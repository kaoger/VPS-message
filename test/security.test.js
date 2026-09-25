import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { FORM_FIELDS as ORIGINAL_FORM_FIELDS } from "../fixtures/original-form-fields.js";
import { validateEnvironment, validSignature, expiryStore } from "../src/security.js";

// Never load local credentials or contact real Meta / Supabase services.
process.env.DOTENV_CONFIG_PATH = "test/nonexistent.env";
Object.assign(process.env, {
  NODE_ENV: "production", PORT: "3000", DEMO_MODE: "webform", QUESTIONS_PATH: "",
  META_APP_SECRET: "test-app-secret", META_VERIFY_TOKEN: "test-verify",
  META_PAGE_ACCESS_TOKEN: "test-page-token", FORM_TOKEN_SECRET: "x".repeat(32),
  PUBLIC_BASE_URL: "https://example.test", SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test", SUPABASE_SERVICE_ROLE_KEY: "", LOG_PATH: "",
  INVITE_COOLDOWN_MINUTES: "30", TRUST_LOCAL_PROXY: "false",
});
const realFetch = globalThis.fetch;
const realLog = console.log;
const logs = [];
console.log = (...args) => logs.push(args.join(" "));
let sends = 0, inserts = 0, updates = 0, failDb = false, failMeta = false;
const rows = new Map();
const automaticInvites = new Set();
const messages = [];
globalThis.fetch = async (url, options) => {
  const value = String(url);
  if (value.startsWith("https://graph.facebook.com/")) {
    sends++;
    messages.push(JSON.parse(options.body));
    assert.equal(new URL(value).search, "");
    assert.equal(options.headers.Authorization, "Bearer test-page-token");
    return new Response("{}", { status: failMeta ? 500 : 200 });
  }
  if (value.startsWith("https://example.supabase.co/rest/")) {
    if (failDb) return new Response(JSON.stringify({ message: "private database error" }), { status: 400 });
    if (value.includes("/bot_invite_registry")) {
      const params = new URL(value).searchParams;
      if (options.method === "POST") {
        const { messenger_user_id: sender } = JSON.parse(options.body);
        if (automaticInvites.has(sender)) return Response.json({ code: "23505", message: "duplicate key" }, { status: 409 });
        automaticInvites.add(sender);
        return new Response(null, { status: 201 });
      }
      assert.equal(options.method, "DELETE");
      const sender = params.get("messenger_user_id")?.slice(3);
      automaticInvites.delete(sender);
      return new Response(null, { status: 204 });
    }
    const params = new URL(value).searchParams;
    if (options.method === "POST") {
      inserts++;
      const row = { ...JSON.parse(options.body), id: String(inserts) };
      rows.set(row.id, row);
      return Response.json({ id: row.id }, { status: 201 });
    }
    const sender = params.get("messenger_user_id");
    assert.ok(sender?.startsWith("eq."), "All reads and updates must check ownership");
    const id = params.get("id")?.slice(3);
    const matches = [...rows.values()].filter(row => row.messenger_user_id === sender.slice(3) && (!id || id === row.id));
    if (options.method === "GET") return Response.json(id ? matches : matches.slice(-1));
    assert.equal(options.method, "PATCH");
    assert.ok(id, "Update must target a specific lead");
    const previous = params.get("answers");
    assert.ok(previous?.startsWith("eq."), "Update must use compare-and-swap");
    const row = matches.find(r => JSON.stringify(r.answers) === previous.slice(3));
    if (!row) return Response.json(null);
    updates++;
    const changes = JSON.parse(options.body);
    assert.ok(!("status" in changes) && !("completed_at" in changes), "Edits preserve business workflow and original time");
    Object.assign(row, changes);
    return Response.json({ id: row.id });
  }
  if (value.startsWith("http://127.0.0.1:3000/")) return realFetch(url, options);
  throw new Error("Unexpected network destination");
};
const { app, handleIncoming } = await import("../src/server.js");
const { signFormToken, verifyFormToken } = await import("../src/form-token.js");
const { FORM_FIELDS, validateAnswers, buildFormSummary } = await import("../src/form-schema.js");
const { FLOW } = await import("../src/flow.js");
const { SERVICE_TRIGGERS } = await import("../src/service-triggers.js");
const { renderDonePage } = await import("../src/form-page.js");
const metaClient = await import("../src/meta.js");
let server;
before(async () => {
  server = app.listen(3000, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
});
after(async () => { console.log = realLog; globalThis.fetch = realFetch; if (server?.listening) await new Promise(r => server.close(r)); });
const request = (path, options) => fetch("http://127.0.0.1:3000" + path, options);
const answers = { service: "新成屋裝潢", area: "高雄市", size: "20 坪以下", timeline: "一個月內", budget: "50 萬以下", name: "測試姓名", phone: "0912345678", contact_time: "上午 8–12 點" };
const submit = (token, values = answers) => request("/form/submit", { method: "POST", body: new URLSearchParams({ token, ...values }) });
const webhook = body => request("/webhook", { method: "POST", headers: {
  "content-type": "application/json", "X-Hub-Signature-256": "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex"),
}, body });

test("production configuration refuses missing secrets and unsafe origins", () => {
  validateEnvironment();
  for (const key of ["META_APP_SECRET", "META_VERIFY_TOKEN", "META_PAGE_ACCESS_TOKEN", "PUBLIC_BASE_URL", "FORM_TOKEN_SECRET"]) {
    assert.throws(() => validateEnvironment({ ...process.env, [key]: "" }));
  }
  assert.throws(() => validateEnvironment({ ...process.env, FORM_TOKEN_SECRET: "short" }));
  assert.throws(() => validateEnvironment({ ...process.env, PUBLIC_BASE_URL: "http://example.test" }));
  assert.throws(() => validateEnvironment({ ...process.env, PORT: "8646" }));
});
test("health uses new Supabase key; production test routes are absent", async () => {
  assert.equal((await (await request("/health")).json()).supabaseConfigured, true);
  for (const path of ["/test/message", "/test/reset"]) assert.equal((await request(path, { method: "POST" })).status, 404);
});
test("webhook verification and signature rejection", async () => {
  assert.equal((await request("/webhook?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=123")).status, 200);
  assert.equal((await request("/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123")).status, 403);
  assert.equal((await request("/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 403);
  assert.equal(validSignature(Buffer.from("{}"), "sha256=wrong", "secret"), false);
  assert.equal((await request("/webhook", { method: "POST", headers: { "content-type": "application/json", "X-Hub-Signature-256": "sha256=" + "0".repeat(64) }, body: "{}" })).status, 403);
  assert.equal((await webhook("{}")).status, 200);
});
test("form renders shared questions and escapes customer-supplied values", async () => {
  const response = await request("/form?t=" + encodeURIComponent(signFormToken("render")));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const html = await response.text();
  assert.match(html, /三禾需求快填/);
  assert.equal((html.match(/<section class="card" data-step>/g) || []).length, 8);
  assert.match(html, /name="name" type="text" inputmode="text"\s+autocomplete="name"/);
  assert.match(html, /name="phone" type="tel" inputmode="numeric"\s+autocomplete="tel"/);
  assert.doesNotMatch(html, /Demo|三合/);
  for (const field of ORIGINAL_FORM_FIELDS) {
    assert.ok(html.includes(field.label));
    if (field.placeholder) assert.ok(html.includes(`placeholder="${field.placeholder}"`));
    if (field.otherLabel) assert.ok(html.includes(field.otherLabel));
  }
  const invalid = await submit(signFormToken("escape"), { ...answers, name: '<script>alert(1)</script>', phone: "bad" });
  assert.doesNotMatch(await invalid.text(), /<script>alert\(1\)<\/script>/);
  for (const { service } of SERVICE_TRIGGERS) {
    const serviceToken = signFormToken("prefill-test", 7200, null, service);
    assert.equal(verifyFormToken(serviceToken).service, service);
    const serviceForm = await (await request("/form?t=" + encodeURIComponent(serviceToken))).text();
    assert.match(serviceForm, new RegExp(`class="chip selected" data-field="service" data-value="${service}"`));
    assert.equal((serviceForm.match(/<section class="card" data-step>/g) || []).length, 8);
  }
  assert.throws(() => signFormToken("prefill-test", 7200, null, "未核准服務"));
});
test("completion page asks users to return to Messenger and gates auto-return on success", () => {
  const manual = renderDonePage({ summary: "送出摘要", messengerOk: true, heading: "需求已送出" });
  assert.match(manual, /請回到 Messenger 對話查看摘要與官方 LINE 邀請/);
  assert.doesNotMatch(manual, /MessengerExtensionsSDK|requestCloseBrowser/);

  const automatic = renderDonePage({ summary: "送出摘要", messengerOk: true, heading: "需求已送出", autoReturnToMessenger: true });
  assert.match(automatic, /即將返回對話/);
  assert.match(automatic, /requestCloseBrowser/);
  assert.match(automatic, /messenger\.Extensions\.js/);

  const failedMessage = renderDonePage({ summary: "送出摘要", messengerOk: false, autoReturnToMessenger: true });
  assert.doesNotMatch(failedMessage, /MessengerExtensionsSDK|requestCloseBrowser/);
});
test("Messenger webview button flag is opt-in", async () => {
  const before = messages.length;
  await metaClient.sendUrlButton("webview-enabled", "開始表單", {
    title: "開始填表", url: "https://bot.sameheart-design.com/form", messengerExtensions: true,
  });
  await metaClient.sendUrlButton("webview-disabled", "開始表單", {
    title: "開始填表", url: "https://bot.sameheart-design.com/form",
  });
  assert.equal(messages[before].message.attachment.payload.buttons[0].messenger_extensions, true);
  assert.equal("messenger_extensions" in messages[before + 1].message.attachment.payload.buttons[0], false);
});
test("tokens reject tampering / expiry; independent invites have unique tokens", () => {
  const token = signFormToken("test");
  assert.equal(verifyFormToken(token).psid, "test");
  assert.notEqual(token, signFormToken("test"));
  assert.throws(() => verifyFormToken(token + ".extra"));
  assert.throws(() => verifyFormToken("X" + token));
  assert.throws(() => verifyFormToken(signFormToken("test", -1)));
  const store = expiryStore();
  assert.equal(store.claim("key", Date.now() + 1000), true);
  assert.equal(store.claim("key", Date.now() + 1000), false);
});
test("shared schema validates choices, phone and other area", () => {
  for (const [index, original] of ORIGINAL_FORM_FIELDS.entries()) {
    for (const [key, value] of Object.entries(original)) {
      assert.deepEqual(FORM_FIELDS[index][key], value, `Original field ${original.key}.${key} must stay unchanged`);
    }
  }
  assert.equal(FORM_FIELDS.length, ORIGINAL_FORM_FIELDS.length);
  assert.deepEqual(FORM_FIELDS.map(f => f.key), FLOW.map(f => f.key));
  assert.equal(validateAnswers(answers), null);
  for (const values of [{ service: "unknown" }, { phone: "123" }, { name: "" }, { area: "其他地區" }]) assert.ok(validateAnswers({ ...answers, ...values }));
  assert.match(buildFormSummary({ ...answers, area: "其他地區", area_other: "屏東" }), /服務地區：屏東/);
});
test("invalid forms do not send messages or insert data", async () => {
  const previous = [sends, inserts];
  assert.equal((await submit("invalid")).status, 400);
  assert.equal((await submit(signFormToken("invalid"), { ...answers, phone: "bad" })).status, 400);
  assert.deepEqual([sends, inserts], previous);
});
test("concurrent duplicate submission produces exactly one insert and message", async () => {
  const previous = [sends, inserts];
  const token = signFormToken("duplicate-test");
  const responses = await Promise.all([submit(token), submit(token)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual([sends - previous[0], inserts - previous[1]], [3, 1]);
  const invitation = messages.find(m => m.recipient.id === "duplicate-test" && m.message.attachment?.payload.buttons[0].title === "加入官方 LINE");
  assert.match(invitation.message.attachment.payload.text, /感謝您的填寫/);
  assert.match(invitation.message.attachment.payload.text, /溝通需求、傳送照片/);
  assert.equal(invitation.message.attachment.payload.buttons[0].url, "https://line.me/R/ti/p/@662gzsyl?oat_content=url&ts=09240050");
  const duplicateHtml = await responses.find(r => r.status === 409).text();
  const nextUrl = duplicateHtml.match(/id="new-form-link" href="([^"]+)"/)[1];
  const nextToken = new URL(nextUrl).searchParams.get("t");
  assert.notEqual(nextToken, token);
  assert.equal(verifyFormToken(nextToken).psid, "duplicate-test");
  assert.equal(verifyFormToken(nextToken).edit, null);
  const nextForm = await request("/form?t=" + encodeURIComponent(nextToken));
  assert.equal(nextForm.status, 200);
  assert.doesNotMatch(await nextForm.text(), /value="測試姓名"/);
  const nextResult = await submit(nextToken);
  assert.equal(nextResult.status, 200);
  const doneHtml = await nextResult.text();
  assert.match(doneHtml, /重新填寫（新增一筆）/);
  assert.match(doneHtml, /請回到 Messenger 對話查看摘要與官方 LINE 邀請/);
  assert.equal((await submit(nextToken)).status, 409);
  assert.deepEqual([sends - previous[0], inserts - previous[1]], [6, 2]);
});
test("database failure is visible without exposing backend details or replaying effects", async () => {
  failDb = true;
  const token = signFormToken("database-failure");
  try {
    const response = await submit(token);
    assert.equal(response.status, 503);
    const html = await response.text();
    assert.match(html, /資料儲存失敗/);
    assert.doesNotMatch(html, /private database error/);
    assert.equal((await submit(token)).status, 409);
  } finally { failDb = false; }
});
test("Messenger failure still saves the submitted lead", async () => {
  const previous = inserts;
  failMeta = true;
  try {
    const response = await submit(signFormToken("message-failure"));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /目前無法回傳訊息/);
    assert.equal(inserts - previous, 1);
  } finally { failMeta = false; }
});
test("ordinary first text gets one generic invitation; current Meta FAQ remains excluded", async () => {
  const previous = sends;
  const ordinary = ["我想問一下", "初步洽談諮詢需要準備什麼呢？", "請問有服務 30 年以上的老屋翻新嗎？"];
  const body = JSON.stringify({ object: "page", entry: [{ messaging: ordinary.map((text, index) => ({ sender: { id: `ordinary-${index}` }, message: { text } })) }] });
  await webhook(body);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends - previous, 1);
  const genericInvite = messages.find(message => message.recipient.id === "ordinary-0");
  assert.match(genericInvite.message.attachment.payload.text, /您好，謝謝您的訊息/);
  const genericToken = new URL(genericInvite.message.attachment.payload.buttons[0].url).searchParams.get("t");
  assert.equal(verifyFormToken(genericToken).service, null);
  const submitted = JSON.stringify({ object: "page", entry: [{ messaging: [{ sender: { id: "duplicate-test" }, message: { text: "thanks" } }] }] });
  await webhook(submitted);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends - previous, 2);
});
test("public privacy and data deletion pages are served for Meta App Review", async () => {
  for (const [path, heading, detail] of [["/privacy", "隱私權政策", /href="\/data-deletion"/], ["/data-deletion", "資料刪除說明", /刪除我的資料/]]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, new RegExp(`<h1>${heading}</h1>`));
    assert.match(html, /三禾室內設計裝潢工程/);
    assert.match(html, detail);
    assert.doesNotMatch(html, /mailto:|@gmail\.|@yahoo\./, "Public pages must not expose the developer contact email");
  }
});
test("data deletion request is acknowledged without a form invitation", async () => {
  const previous = messages.length;
  const body = JSON.stringify({ object: "page", entry: [{ messaging: [{ sender: { id: "deletion-request" }, message: { text: "刪除我的資料" } }] }] });
  await webhook(body);
  await new Promise(resolve => setImmediate(resolve));
  const replies = messages.slice(previous).filter(message => message.recipient.id === "deletion-request");
  assert.equal(replies.length, 1);
  assert.match(replies[0].message.text, /已收到您的資料刪除申請/);
  assert.equal(automaticInvites.has("deletion-request"), false);
  assert.ok(!logs.some(line => line.includes("deletion-request")), "Logs must not contain the Messenger id");
});
test("four explicit service entries invite once and preselect the matching first form answer", async () => {
  const previous = messages.length;
  const events = SERVICE_TRIGGERS.map((trigger, index) => ({
    sender: { id: `service-trigger-${index}` },
    ...(index === SERVICE_TRIGGERS.length - 1
      ? { postback: { payload: trigger.payload } }
      : { message: { text: trigger.title } }),
  }));
  await webhook(JSON.stringify({ object: "page", entry: [{ messaging: events }] }));
  await new Promise(resolve => setImmediate(resolve));
  const invitations = messages.slice(previous).filter(message => message.message.attachment?.payload.buttons[0].title === "開始填表");
  assert.equal(invitations.length, 4);

  for (const [index, trigger] of SERVICE_TRIGGERS.entries()) {
    const invitation = invitations.find(message => message.recipient.id === `service-trigger-${index}`);
    assert.match(invitation.message.attachment.payload.text, new RegExp(trigger.service));
    assert.equal("messenger_extensions" in invitation.message.attachment.payload.buttons[0], false);
    const token = new URL(invitation.message.attachment.payload.buttons[0].url).searchParams.get("t");
    assert.equal(verifyFormToken(token).service, trigger.service);
    const form = await (await request("/form?t=" + encodeURIComponent(token))).text();
    assert.match(form, new RegExp(`class="chip selected" data-field="service" data-value="${trigger.service}"`));
    assert.equal((form.match(/<section class="card" data-step>/g) || []).length, 8);
  }

  const beforeDuplicate = messages.length;
  await webhook(JSON.stringify({ object: "page", entry: [{ messaging: [
    { sender: { id: "service-trigger-0" }, message: { text: SERVICE_TRIGGERS[0].title } },
    { sender: { id: "service-trigger-0" }, message: { text: SERVICE_TRIGGERS[0].title } },
  ] }] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length, beforeDuplicate);
});
test("automatic invitation is shared across generic and service entry; explicit 新增需求 remains available", async () => {
  const previous = messages.length;
  const userId = "once-only-user";
  await webhook(JSON.stringify({ object: "page", entry: [{ messaging: [
    { sender: { id: userId }, message: { text: "您好，我想了解裝修服務" } },
    { sender: { id: userId }, message: { text: SERVICE_TRIGGERS[0].title } },
  ] }] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length - previous, 1);
  const automatic = messages[previous];
  const token = new URL(automatic.message.attachment.payload.buttons[0].url).searchParams.get("t");
  assert.equal(verifyFormToken(token).service, null);

  const beforeManual = messages.length;
  await webhook(JSON.stringify({ object: "page", entry: [{ messaging: [
    { sender: { id: userId }, message: { text: "新增需求" } },
  ] }] }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(messages.length - beforeManual, 1, "explicit command bypasses the automatic-once marker");
});
test("without database credentials, chat still reaches confirmation and completion", async () => {
  const key = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = "";
  const outbox = [];
  const send = { text: async (_id, text) => outbox.push(text), quick: async () => {}, buttons: async () => {} };
  try {
    for (const step of FLOW) await handleIncoming("chat-test", { text: answers[step.key] }, send);
    await handleIncoming("chat-test", { text: "確認送出" }, send);
    assert.match(outbox.at(-1), /感謝/);
    assert.equal((await submit(signFormToken("no-db"))).status, 200);
  } finally { process.env.SUPABASE_SECRET_KEY = key; }
});
test("edits prefill and update the same lead; stale or forged ownership cannot overwrite it", async () => {
  const original = [...rows.values()].find(row => row.messenger_user_id === "duplicate-test");
  const firstMessage = messages.find(m => m.recipient.id === "duplicate-test" && m.message.attachment);
  const link = firstMessage.message.attachment.payload.buttons[0].url;
  const token = new URL(link).searchParams.get("t");
  const claims = verifyFormToken(token);
  assert.equal(claims.edit.id, original.id);
  const page = await request("/form?t=" + encodeURIComponent(token));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /確認修改並送出/);
  const counts = [inserts, updates];
  const changed = { ...answers, phone: "0999999999", area: "其他地區", area_other: "屏東" };
  const results = await Promise.all([submit(token, changed), submit(token, changed)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.deepEqual([inserts, updates], [counts[0], counts[1] + 1]);
  assert.equal(original.phone, "0999999999");
  assert.equal(original.location, "屏東");
  assert.equal(original.answers.area, "其他地區");
  assert.equal((await request("/form?t=" + encodeURIComponent(token))).status, 409);
  // A different token with the old version simulates replay after in-memory claims are lost.
  const stale = signFormToken("duplicate-test", 7200, claims.edit);
  assert.equal((await submit(stale)).status, 409);
  const wrongOwner = signFormToken("different-person", 7200, claims.edit);
  assert.equal((await request("/form?t=" + encodeURIComponent(wrongOwner))).status, 409);
  assert.equal((await submit(wrongOwner)).status, 409);
  const latestMessage = messages.filter(m => m.recipient.id === "duplicate-test" && m.message.attachment?.payload.buttons[0].title === "修改需求").at(-1);
  const lineUpdate = messages.filter(m => m.recipient.id === "duplicate-test" && m.message.attachment?.payload.buttons[0].title === "加入官方 LINE").at(-1);
  assert.match(lineUpdate.message.attachment.payload.text, /感謝您的更新/);
  const latest = new URL(latestMessage.message.attachment.payload.buttons[0].url).searchParams.get("t");
  const latestHtml = await (await request("/form?t=" + encodeURIComponent(latest))).text();
  assert.match(latestHtml, /0999999999/);
  assert.match(latestHtml, /屏東/);
  // Actual edit failure never inserts a replacement lead or announces success.
  const before = [inserts, updates, sends];
  failDb = true;
  try { assert.equal((await submit(latest, changed)).status, 503); }
  finally { failDb = false; }
  assert.deepEqual([inserts, updates, sends], before);
});
test("edit command bypasses invitation cooldown and new-demand command creates a fresh form", async () => {
  for (const command of ["修改需求", "新增需求"]) {
    const count = messages.length;
    await webhook(JSON.stringify({ object: "page", entry: [{ messaging: [{ sender: { id: "duplicate-test" }, message: { text: command } }] }] }));
    for (let i = 0; i < 20 && messages.length === count; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(messages.length, count + 1);
    const token = new URL(messages.at(-1).message.attachment.payload.buttons[0].url).searchParams.get("t");
    assert.equal(Boolean(verifyFormToken(token).edit), command === "修改需求");
  }
});
test("memory-only submissions can be edited without creating database rows", async () => {
  const key = process.env.SUPABASE_SECRET_KEY;
  process.env.SUPABASE_SECRET_KEY = "";
  try {
    const message = messages.find(m => m.recipient.id === "no-db" && m.message.attachment);
    const token = new URL(message.message.attachment.payload.buttons[0].url).searchParams.get("t");
    assert.equal((await request("/form?t=" + encodeURIComponent(token))).status, 200);
    const before = [inserts, updates];
    assert.equal((await submit(token, { ...answers, phone: "0988888888" })).status, 200);
    assert.deepEqual([inserts, updates], before);
  } finally { process.env.SUPABASE_SECRET_KEY = key; }
});
test("two distinct edit links for one version cannot both update; expired edit links cannot read data", async () => {
  const { editToken, loadLead } = await import("../src/lead-edit.js");
  const row = await loadLead("duplicate-test");
  const first = editToken("duplicate-test", row);
  const second = editToken("duplicate-test", row);
  const before = updates;
  const results = await Promise.all([submit(first), submit(second)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(updates, before + 1);
  const expired = signFormToken("duplicate-test", -1, verifyFormToken(first).edit);
  const response = await request("/form?t=" + encodeURIComponent(expired));
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), /測試姓名|0912345678/);
});
test("rate limit rejects excessive form submissions", async () => {
  let response;
  for (let i = 0; i < 21; i++) response = await submit("invalid");
  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
});
test("logs contain neither customer data nor API secrets / errors", () => {
  const output = logs.join("\n");
  assert.match(output, /form_lead_inserted/);
  for (const value of ["0912345678", "測試姓名", "private text", "private database error", "test-page-token", "sb_secret_test"]) {
    assert.ok(!output.includes(value));
  }
});
