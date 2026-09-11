import "dotenv/config";
import fs from "node:fs";
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
import {
  createCustomerLead,
  isSupabaseConfigured,
} from "./supabase.js";
import { signFormToken, verifyFormToken, publicBaseUrl } from "./form-token.js";
import {
  normalizeAnswers,
  validateAnswers,
  buildFormSummary,
} from "./form-schema.js";
import { renderFormPage, renderDonePage } from "./form-page.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const port = Number(process.env.PORT || 3000);
/** webform = Messenger opens external form; chat = in-thread questions */
const DEMO_MODE = (process.env.DEMO_MODE || "webform").toLowerCase();

const liveSend = {
  text: (id, t, mt) => meta.sendText(id, t, mt),
  quick: (id, t, opts) => meta.sendQuickReplies(id, t, opts),
  buttons: (id, t, opts) => meta.sendButtonTemplate(id, t, opts),
  urlButton: (id, t, spec) => meta.sendUrlButton(id, t, spec),
};

const LOG_PATH = "/tmp/sanhe-webhook.log";

function logEvent(...parts) {
  const line = `[${new Date().toISOString()}] ${parts
    .map((p) => (typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ")}\n`;
  try {
    fs.appendFileSync(LOG_PATH, line);
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
  res.status(200).json({ received: true });
  void processWebhook(req.body).catch((error) => {
    console.error("Webhook processing error:", error);
    logEvent("webhook_error", String(error));
  });
});

// ---- Web form demo ----
app.get("/form", (req, res) => {
  const token = String(req.query.t || "");
  try {
    verifyFormToken(token);
  } catch {
    res
      .status(400)
      .type("html")
      .send(
        renderDonePage({
          summary: "連結無效或已過期。請回到 Messenger 再傳一次訊息，取得新的填表連結。",
          messengerOk: false,
        })
      );
    return;
  }
  res.type("html").send(renderFormPage({ token }));
});

app.post("/form/submit", async (req, res) => {
  const token = String(req.body?.token || "");
  let psid;
  try {
    ({ psid } = verifyFormToken(token));
  } catch {
    res
      .status(400)
      .type("html")
      .send(
        renderDonePage({
          summary: "連結無效或已過期。請回 Messenger 重開表單。",
          messengerOk: false,
        })
      );
    return;
  }

  const answers = normalizeAnswers(req.body || {});
  const err = validateAnswers(answers);
  if (err) {
    res
      .status(400)
      .type("html")
      .send(renderFormPage({ token, error: err, prefill: answers }));
    return;
  }

  const summary = buildFormSummary(answers);
  let messengerOk = false;
  let messengerError = "";

  try {
    // Outside webhook turn: prefer UPDATE (24h window), fall back to RESPONSE
    try {
      await meta.sendText(psid, summary, "UPDATE");
    } catch (e1) {
      logEvent("form_summary_update_fail", String(e1));
      await meta.sendText(psid, summary, "RESPONSE");
    }
    messengerOk = true;
    logEvent("form_summary_sent", psid);
  } catch (error) {
    messengerError = String(error);
    logEvent("form_summary_fail", psid, messengerError);
    console.error("form summary send failed:", error);
  }

  // Optional CRM write (only if configured)
  if (isSupabaseConfigured()) {
    try {
      const area =
        answers.area === "其他地區" && answers.area_other
          ? answers.area_other
          : answers.area;
      await createCustomerLead({
        senderId: psid,
        answers: {
          service: answers.service,
          area,
          size: answers.size,
          timeline: answers.timeline,
          budget: answers.budget,
          name: answers.name,
          phone: answers.phone,
          contact_time: answers.contact_time,
        },
      });
      logEvent("form_lead_inserted", psid);
    } catch (error) {
      logEvent("form_lead_fail", String(error));
      console.error("form lead insert failed:", error);
    }
  }

  res.type("html").send(
    renderDonePage({
      summary: messengerOk
        ? summary
        : `${summary}\n\n（Messenger 回傳失敗：${messengerError}）`,
      messengerOk,
    })
  );
});

async function processWebhook(body) {
  logEvent("webhook_in", {
    object: body?.object,
    mode: DEMO_MODE,
    events: (body?.entry ?? []).flatMap((e) =>
      (e.messaging ?? []).map((m) => ({
        sender: m?.sender?.id,
        hasMessage: Boolean(m?.message),
        hasPostback: Boolean(m?.postback),
        payload:
          m?.postback?.payload || m?.message?.quick_reply?.payload || null,
        text: m?.message?.text ?? m?.postback?.title ?? null,
      }))
    ),
  });

  if (body?.object !== "page") return;

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const senderId = event?.sender?.id;
      if (!senderId) continue;

      if (DEMO_MODE === "webform") {
        // Ignore echoes; any user message or postback → send form CTA
        if (event.message?.is_echo) continue;
        if (event.message || event.postback) {
          await sendWebformInvite(senderId, publicBaseUrlFromEnv());
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

async function sendWebformInvite(senderId, baseUrl) {
  const base =
    baseUrl ||
    "https://never-donald-biz-respond.trycloudflare.com";
  const token = signFormToken(senderId);
  const formUrl = `${base}/form?t=${encodeURIComponent(token)}`;

  const intro =
    "可以利用一分鐘快速填表，讓我們迅速掌握您的需求。\n\n請點下方按鈕開啟表單，填完後摘要會回到這個對話。";

  try {
    await meta.sendUrlButton(senderId, intro, {
      title: "開始填表",
      url: formUrl,
    });
    logEvent("webform_invite_sent", senderId);
  } catch (error) {
    logEvent("webform_invite_fail", String(error));
    // Fallback: plain text with raw link
    await meta.sendText(
      senderId,
      `${intro}\n\n表單連結：\n${formUrl}`
    );
  }
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
      try {
        if (!isSupabaseConfigured()) throw new Error("Supabase env not configured");
        await createCustomerLead({ senderId, answers: session.answers });
      } catch (error) {
        console.error("customer_leads insert failed:", error);
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
app.post("/test/reset", (req, res) => {
  const senderId = String(req.body?.senderId || "test-user");
  deleteSession(senderId);
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
      const base =
        process.env.PUBLIC_BASE_URL ||
        "https://never-donald-biz-respond.trycloudflare.com";
      const token = signFormToken(senderId);
      await send.urlButton(senderId, "可以利用一分鐘快速填表…", {
        title: "開始填表",
        url: `${base}/form?t=${encodeURIComponent(token)}`,
      });
    } else {
      await handleIncoming(senderId, { text, payload }, send);
    }
    res.json({ ok: true, senderId, outbox, session: getSession(senderId) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: String(error) });
  }
});

app.listen(port, "127.0.0.1", () => {
  console.log(
    `sanhe-messenger-bot on 127.0.0.1:${port} mode=${DEMO_MODE} steps=${FLOW.length}`
  );
});
