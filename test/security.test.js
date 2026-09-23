import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
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
let sends = 0, inserts = 0, failDb = false, failMeta = false;
globalThis.fetch = async (url, options) => {
  const value = String(url);
  if (value.startsWith("https://graph.facebook.com/")) {
    sends++;
    assert.equal(new URL(value).search, "");
    assert.equal(options.headers.Authorization, "Bearer test-page-token");
    return new Response("{}", { status: failMeta ? 500 : 200 });
  }
  if (value.startsWith("https://example.supabase.co/rest/")) {
    inserts++;
    assert.equal(options.method, "POST");
    const row = JSON.parse(options.body);
    assert.equal(row.customer_name, "測試姓名");
    return new Response(JSON.stringify(failDb ? { message: "private database error" } : { id: 1 }), {
      status: failDb ? 400 : 201, headers: { "content-type": "application/json" },
    });
  }
  if (value.startsWith("http://127.0.0.1:3000/")) return realFetch(url, options);
  throw new Error("Unexpected network destination");
};
const { app, handleIncoming } = await import("../src/server.js");
const { signFormToken, verifyFormToken } = await import("../src/form-token.js");
const { FORM_FIELDS, validateAnswers, buildFormSummary } = await import("../src/form-schema.js");
const { FLOW } = await import("../src/flow.js");
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
  assert.doesNotMatch(html, /Demo|三合/);
  for (const step of FLOW) assert.ok(html.includes(step.text));
  const invalid = await submit(signFormToken("escape"), { ...answers, name: '<script>alert(1)</script>', phone: "bad" });
  assert.doesNotMatch(await invalid.text(), /<script>alert\(1\)<\/script>/);
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
  assert.deepEqual([sends - previous[0], inserts - previous[1]], [1, 1]);
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
test("three incoming messages only invite once; submitted users are suppressed", async () => {
  const previous = sends;
  const body = JSON.stringify({ object: "page", entry: [{ messaging: [1, 2, 3].map(() => ({ sender: { id: "invite-test" }, message: { text: "private text" } })) }] });
  await webhook(body);
  // Let the asynchronous webhook processing drain.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends - previous, 1);
  const submitted = JSON.stringify({ object: "page", entry: [{ messaging: [{ sender: { id: "duplicate-test" }, message: { text: "thanks" } }] }] });
  await webhook(submitted);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sends - previous, 1);
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
