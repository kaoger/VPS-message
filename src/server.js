import "dotenv/config";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { validateEnvironment, validSignature, expiryStore, formRateLimit } from "./security.js";
import express from "express";
import {
  FLOW,
  buildSummary,
  titleForPayload,
  CONFIRM_OPTIONS,
  SUBMIT_SUCCESS_TEXT,
} from "./flow.js";
import {
  getSession,
  saveSession,
  deleteSession,
  createSession,
} from "./session-store.js";
import * as meta from "./meta.js";
import { OFFICIAL_LINE_URL, lineThankYouText } from "./contact.js";
import {
  createCustomerLead,
  isSupabaseConfigured,
  claimAutomaticInvite,
  releaseAutomaticInvite,
} from "./supabase.js";
import { signFormToken, verifyFormToken } from "./form-token.js";
import { editToken, loadLead, saveLead, isCurrentVersion } from "./lead-edit.js";
import {
  normalizeAnswers,
  validateAnswers,
  buildFormSummary,
  FORM_FIELDS,
} from "./form-schema.js";
import { renderFormPage, renderDonePage } from "./form-page.js";
import { serviceForTrigger } from "./service-triggers.js";

validateEnvironment();
export const app = express();
// Enable only for a known, single local reverse proxy that overwrites forwarding headers.
if (process.env.TRUST_LOCAL_PROXY === "true") app.set("trust proxy", "loopback");
app.use(express.json({ limit: "32kb", verify: (req, _res, buffer) => { req.rawBody = buffer; } }));
app.use(express.urlencoded({ extended: false }));
app.use((_req, res, next) => {
  res.set({ "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  next();
});
const submissions = expiryStore();
const invites = expiryStore();

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
/** webform = Messenger opens external form; chat = in-thread questions */
const DEMO_MODE = (process.env.DEMO_MODE || "webform").toLowerCase();
// Enable only after bot.sameheart-design.com is whitelisted in Meta Messenger settings.
const MESSENGER_WEBVIEW_ENABLED = process.env.MESSENGER_WEBVIEW_ENABLED === "true";

const liveSend = {
  text: (id, t, mt) => meta.sendText(id, t, mt),
  quick: (id, t, opts) => meta.sendQuickReplies(id, t, opts),
  buttons: (id, t, opts) => meta.sendButtonTemplate(id, t, opts),
  urlButton: (id, t, spec) => meta.sendUrlButton(id, t, spec),
};

const LOG_PATH = process.env.LOG_PATH;

function logEvent(...parts) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}\n`;
  try {
    if (LOG_PATH) fs.appendFileSync(LOG_PATH, line);
  } catch {
    /* ignore */
  }
  console.log(...parts);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    demoMode: DEMO_MODE,
    flowSteps: FLOW.length,
    supabaseConfigured: isSupabaseConfigured(),
  });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token &&
    token === process.env.META_VERIFY_TOKEN &&
    challenge
  ) {
    return res.status(200).send(String(challenge));
  }
  return res.sendStatus(403);
});

app.post("/webhook", (req, res) => {
  if (!validSignature(req.rawBody, req.get("X-Hub-Signature-256"), process.env.META_APP_SECRET)) {
    return res.sendStatus(403);
  }
  res.status(200).json({ received: true });
  void processWebhook(req.body).catch((error) => {
    logEvent("webhook_error");
  });
});

// ---- Web form ----
const unavailable = "此連結無效、已過期或資料已更新。請回 Messenger 傳「修改需求」取得最新修改連結。";
const baseUrl = () => publicBaseUrlFromEnv() || "http://127.0.0.1:3000";
const editUrlFor = (psid, row) => `${baseUrl()}/form?t=${encodeURIComponent(editToken(psid, row))}`;
const newFormUrlFor = psid => `${baseUrl()}/form?t=${encodeURIComponent(signFormToken(psid))}`;

function formError(res, status, summary) {
  return res.status(status).type("html").send(renderDonePage({ summary, heading: "暫時無法處理", messengerOk: false }));
}

app.get("/form", async (req, res) => {
  const token = String(req.query.t || "");
  let claims;
  try { claims = verifyFormToken(token); }
  catch { return formError(res, 400, unavailable); }
  let prefill = {};
  if (claims.edit) {
    try {
      const row = await loadLead(claims.psid, claims.edit);
      if (!isCurrentVersion(row, claims.edit)) return formError(res, 409, unavailable);
      prefill = { ...row.answers };
      // Older records stored the typed region directly in area.
      if (prefill.area && !FORM_FIELDS.find(f => f.key === "area")?.options?.includes(prefill.area)) {
        prefill.area_other = prefill.area;
        prefill.area = "其他地區";
      }
    } catch { logEvent("form_load_fail"); return formError(res, 503, "目前無法讀取需求，請稍後重試。"); }
  } else if (claims.service) {
    prefill.service = claims.service;
  }
  res.type("html").send(renderFormPage({ token, prefill, editing: Boolean(claims.edit) }));
});

app.post("/form/submit", formRateLimit(), async (req, res) => {
  const token = String(req.body?.token || "");
  let claims;
  try { claims = verifyFormToken(token); }
  catch { return formError(res, 400, unavailable); }
  const { psid, exp, edit } = claims;
  const answers = normalizeAnswers(req.body || {});
  const err = validateAnswers(answers);
  if (err) return res.status(400).type("html").send(renderFormPage({ token, error: err, prefill: answers, editing: Boolean(edit) }));
  if (!submissions.claim(token, exp * 1000)) {
    return res.status(409).type("html").send(renderDonePage({
      heading: "這份表單已送出或正在處理",
      summary: "若要測試另一筆或新增案件，請按下方「重新填寫（新增一筆）」。若要修改原資料，請回 Messenger 使用「修改需求」。",
      messengerOk: false,
      newFormUrl: newFormUrlFor(psid),
    }));
  }

  const summary = (edit ? "需求已更新，以下為最新資料：\n\n" : "") + buildFormSummary(answers);
  let row;
  try {
    row = await saveLead(psid, answers, edit);
    if (!row) return formError(res, 409, unavailable);
    logEvent(edit ? "form_lead_updated" : "form_lead_inserted");
  } catch {
    logEvent("form_lead_fail");
    return formError(res, 503, "資料儲存失敗，尚未確認成功。請保留下方摘要並聯繫粉專。\n\n" + buildFormSummary(answers));
  }
  const editUrl = editUrlFor(psid, row);
  let messengerOk = false;
  let notice = "";
  try {
    await meta.sendText(psid, summary, "RESPONSE");
    messengerOk = true;
    logEvent("form_summary_sent");
  } catch {
    notice = "\n\n目前無法回傳訊息，請保留下方摘要並聯繫粉專。";
    logEvent("form_summary_fail");
  }
  try {
    await meta.sendUrlButton(psid, "如需調整這筆需求，請點「修改需求」。連結兩小時內有效；過期可傳「修改需求」取得新連結。另有新案件可傳「新增需求」。", { title: "修改需求", url: editUrl });
  } catch {
    notice += "\n\n修改按鈕未能傳到 Messenger，仍可使用本頁的「修改需求」。";
    logEvent("form_edit_button_fail");
  }
  try {
    await meta.sendUrlButton(psid, lineThankYouText(Boolean(edit)), {
      title: "加入官方 LINE", url: OFFICIAL_LINE_URL,
    });
  } catch {
    logEvent("form_line_button_fail");
    notice += "\n\n官方 LINE 邀請未能傳到 Messenger，可用此連結加入：" + OFFICIAL_LINE_URL;
  }
  res.type("html").send(renderDonePage({
    summary: summary + notice,
    heading: edit ? "需求已更新" : "需求已送出",
    messengerOk, editUrl, newFormUrl: newFormUrlFor(psid),
    autoReturnToMessenger: MESSENGER_WEBVIEW_ENABLED,
  }));
});
async function processWebhook(body) {
  logEvent("webhook_in");

  if (body?.object !== "page") return;

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const senderId = event?.sender?.id;
      if (!senderId) continue;

      if (DEMO_MODE === "webform") {
        // Keep the four service entries; ordinary text gets a generic invite.
        if (event.message?.is_echo) continue;
        const command = (event.message?.text || event.postback?.payload || "").trim();
        if (command === "修改需求") {
          try {
            const row = await loadLead(senderId);
            if (row) await meta.sendUrlButton(senderId, "請修改最近一筆需求，確認後再送出。", { title: "修改需求", url: editUrlFor(senderId, row), messengerExtensions: MESSENGER_WEBVIEW_ENABLED });
            else await meta.sendText(senderId, "目前找不到可修改的需求。若要建立新案件，請傳「新增需求」。");
          } catch { logEvent("edit_invite_fail"); }
          continue;
        }
        if (command === "新增需求") {
          await sendWebformInvite(senderId, publicBaseUrlFromEnv());
          continue;
        }
        if (event.message || event.postback) {
          const service = serviceForTrigger({
            text: event.message?.text || "",
            payload: event.message?.quick_reply?.payload || event.postback?.payload || "",
          });
          const text = (event.message?.text || "").trim();
          const isExistingMetaFaq = [
            "初步洽談諮詢需要準備什麼呢？",
            "有提供單一空間局部裝修？",
            "請問有單純提供系統櫃規劃嗎？",
            "請問有服務 30 年以上的老屋翻新嗎？",
          ].includes(text);
          const isGenericText = !service && !event.postback && text.length > 0 && !isExistingMetaFaq;
          if (!service && !isGenericText) continue;
          if (await claimInviteOnce(senderId, service ? "service" : "generic")) {
            try { await sendWebformInvite(senderId, publicBaseUrlFromEnv(), service); }
            catch { await releaseInviteReservation(senderId); logEvent("webform_invite_fail"); }
          }
        }
        continue;
      }

      // ---- classic in-chat flow ----
      if (event.postback?.payload) {
        await handleIncoming(
          senderId,
          {
            text: event.postback.title ?? null,
            payload: event.postback.payload,
          },
          liveSend
        );
        continue;
      }

      const message = event?.message;
      if (!message || message.is_echo) continue;
      const payload = message.quick_reply?.payload ?? null;
      const text =
        typeof message.text === "string" ? message.text.trim() : null;
      if (text == null && !payload) continue;
      await handleIncoming(senderId, { text, payload }, liveSend);
    }
  }
}

function publicBaseUrlFromEnv() {
  return (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
}

async function sendWebformInvite(senderId, baseUrl, service = null, sender = meta) {
  const base = baseUrl || "http://127.0.0.1:3000";
  const token = signFormToken(senderId, 2 * 60 * 60, null, service);
  const formUrl = `${base}/form?t=${encodeURIComponent(token)}`;

  const intro = service
    ? `您好，謝謝您洽詢「${service}」！為了更了解您的需求，麻煩您花約一分鐘填寫表單，完成後摘要會回到這個對話。`
    : "您好，謝謝您的訊息！為了更了解您的需求，麻煩您花約一分鐘填寫表單，完成後摘要會回到這個對話。";

  try {
    await sender.sendUrlButton(senderId, intro, {
      title: "開始填表",
      url: formUrl,
      messengerExtensions: MESSENGER_WEBVIEW_ENABLED,
    });
    logEvent("webform_invite_sent");
  } catch (error) {
    logEvent("webform_invite_fail");
    // Fallback: plain text with raw link
    await sender.sendText(
      senderId,
      `${intro}\n\n表單連結：\n${formUrl}`
    );
  }
}

async function claimInviteOnce(senderId, kind) {
  // Local development without database credentials still supports one invite
  // per process; production uses a durable unique-key database reservation.
  if (!isSupabaseConfigured()) return invites.claim(senderId, Number.MAX_SAFE_INTEGER);
  try { return await claimAutomaticInvite({ senderId, kind }); }
  catch {
    logEvent("webform_invite_claim_fail");
    return false;
  }
}

async function releaseInviteReservation(senderId) {
  if (!isSupabaseConfigured()) {
    invites.remove(senderId);
    return;
  }
  try { await releaseAutomaticInvite({ senderId }); }
  catch { logEvent("webform_invite_release_fail"); }
}

function optionMatch(step, payload, text) {
  if (!step?.options?.length) return null;
  if (payload) {
    const byPayload = titleForPayload(step, payload);
    if (byPayload) return { value: byPayload, payload };
  }
  if (text) {
    const byTitle = step.options.find(([title]) => title === text);
    if (byTitle) return { value: byTitle[0], payload: byTitle[1] };
  }
  return null;
}

async function askStep(senderId, stepIndex, send) {
  const step = FLOW[stepIndex];
  if (!step) return;
  if (step.type === "button_template") {
    await send.buttons(senderId, step.text, step.options);
  } else if (step.type === "quick_reply") {
    await send.quick(senderId, step.text, step.options);
  } else {
    await send.text(senderId, step.text);
  }
}

async function showConfirm(senderId, session, send) {
  session.awaitingConfirm = true;
  session.step = FLOW.length;
  saveSession(senderId, session);
  if (typeof send.buttons === "function") {
    await send.buttons(senderId, buildSummary(session.answers), CONFIRM_OPTIONS);
  } else {
    await send.quick(senderId, buildSummary(session.answers), CONFIRM_OPTIONS);
  }
}

/** Classic in-chat 8-step flow (DEMO_MODE=chat) */
export async function handleIncoming(senderId, { text, payload }, send) {
  let session = getSession(senderId);

  if (!session || session.completed) {
    session = createSession();
    saveSession(senderId, session);
    const match = optionMatch(FLOW[0], payload, text);
    if (!match) {
      await askStep(senderId, 0, send);
      return;
    }
  }

  if (session.awaitingConfirm) {
    const p = payload || null;
    const t = text || null;
    const [submitTitle, submitPayload] = CONFIRM_OPTIONS[0];
    const [restartTitle, restartPayload] = CONFIRM_OPTIONS[1];
    const isSubmit = p === submitPayload || t === submitTitle;
    const isRestart = p === restartPayload || t === restartTitle;

    if (isRestart) {
      deleteSession(senderId);
      session = createSession();
      saveSession(senderId, session);
      await askStep(senderId, 0, send);
      return;
    }

    if (isSubmit) {
      if (session.submitting) return;
      session.submitting = true;
      saveSession(senderId, session);
      try {
        if (isSupabaseConfigured()) await createCustomerLead({ senderId, answers: session.answers });
      } catch (error) {
        session.submitting = false;
        logEvent("customer_leads_insert_failed");
        await send.text(
          senderId,
          "送出時發生問題，請稍後再按「確認送出」。若持續失敗請聯繫客服。"
        );
        saveSession(senderId, session);
        return;
      }
      session.awaitingConfirm = false;
      session.completed = true;
      saveSession(senderId, session);
      await send.text(senderId, SUBMIT_SUCCESS_TEXT);
      deleteSession(senderId);
      return;
    }

    await showConfirm(senderId, session, send);
    return;
  }

  if (session.waitingAreaOther) {
    const areaStep = FLOW[session.step];
    if (!text) {
      await send.text(senderId, areaStep?.otherPrompt || "請輸入地區名稱：");
      return;
    }
    session.answers[areaStep.key] = text;
    session.waitingAreaOther = false;
    session.step += 1;
    saveSession(senderId, session);
    if (session.step >= FLOW.length) await showConfirm(senderId, session, send);
    else await askStep(senderId, session.step, send);
    return;
  }

  const stepIndex = session.step;
  const step = FLOW[stepIndex];
  if (!step) {
    session = createSession();
    saveSession(senderId, session);
    await askStep(senderId, 0, send);
    return;
  }

  if (step.type === "quick_reply" || step.type === "button_template") {
    const match = optionMatch(step, payload, text);
    if (!match) {
      await askStep(senderId, stepIndex, send);
      return;
    }
    const { value, payload: resolvedPayload } = match;
    if (step.otherPayload && resolvedPayload === step.otherPayload) {
      session.waitingAreaOther = true;
      saveSession(senderId, session);
      await send.text(senderId, step.otherPrompt);
      return;
    }
    session.answers[step.key] = value;
  } else {
    if (!text) {
      await askStep(senderId, stepIndex, send);
      return;
    }
    if (typeof step.validate === "function" && !step.validate(text)) {
      await send.text(senderId, step.errorText || "格式不正確，請再試一次。");
      saveSession(senderId, session);
      return;
    }
    session.answers[step.key] = text;
  }

  const next = stepIndex + 1;
  if (next >= FLOW.length) {
    await showConfirm(senderId, session, send);
    return;
  }
  session.step = next;
  saveSession(senderId, session);
  await askStep(senderId, next, send);
}

// ---- local tests ----
if (process.env.NODE_ENV !== "production") {
app.post("/test/reset", (req, res) => {
  const senderId = String(req.body?.senderId || "test-user");
  deleteSession(senderId);
  invites.remove(senderId);
  res.json({ ok: true, senderId });
});

app.post("/test/message", async (req, res) => {
  const senderId = String(req.body?.senderId || "test-user");
  const text = req.body?.text != null ? String(req.body.text).trim() : null;
  const payload = req.body?.payload != null ? String(req.body.payload) : null;
  const outbox = [];
  const send = {
    text: async (_id, t) => outbox.push({ type: "text", text: t }),
    quick: async (_id, t, options) =>
      outbox.push({
        type: "quick_reply",
        text: t,
        options: options.map(([title, p]) => ({ title, payload: p })),
      }),
    buttons: async (_id, t, options) => {
      for (let i = 0; i < options.length; i += 3) {
        outbox.push({
          type: "button_template",
          text: i === 0 ? t : "請繼續選擇：",
          options: options.slice(i, i + 3).map(([title, p]) => ({
            title,
            payload: p,
          })),
        });
      }
    },
    urlButton: async (_id, t, spec) =>
      outbox.push({ type: "url_button", text: t, ...spec }),
  };

  try {
    if (DEMO_MODE === "webform") {
      const service = serviceForTrigger({ text: text || "", payload: payload || "" });
      const isExistingMetaFaq = [
        "初步洽談諮詢需要準備什麼呢？",
        "有提供單一空間局部裝修？",
        "請問有單純提供系統櫃規劃嗎？",
        "請問有服務 30 年以上的老屋翻新嗎？",
      ].includes(text || "");
      const generic = !service && !payload && Boolean(text) && text !== "新增需求" && !isExistingMetaFaq;
      if (text === "新增需求" || service || generic) {
        if (text === "新增需求" || await claimInviteOnce(senderId, service ? "service" : "generic")) {
          const localSender = {
            sendUrlButton: async (_id, t, spec) => outbox.push({ type: "url_button", text: t, ...spec }),
            sendText: async (_id, t) => outbox.push({ type: "text", text: t }),
          };
          await sendWebformInvite(senderId, process.env.PUBLIC_BASE_URL || "http://127.0.0.1:3000", service, localSender);
        }
      }
    } else {
      await handleIncoming(senderId, { text, payload }, send);
    }
    res.json({ ok: true, senderId, outbox, session: getSession(senderId) });
  } catch (error) {
    logEvent("test_message_failed");
    res.status(500).json({ ok: false, error: "Request failed" });
  }
});
}

app.use((error, _req, res, _next) => {
  logEvent("request_failed");
  res.status(error.status >= 400 && error.status < 500 ? error.status : 500).send("請求無法處理，請稍後再試。");
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) app.listen(port, host, () => {
  console.log(
    `sanhe-messenger-bot on ${host}:${port} mode=${DEMO_MODE} steps=${FLOW.length}`
  );
});
