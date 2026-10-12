import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { SANHE_PAGE_ID, ADMIN_SCOPES } from "../src/admin-config.js";

// The actual server mounts the admin console. Never load local credentials.
process.env.DOTENV_CONFIG_PATH = "test/nonexistent.env";
Object.assign(process.env, {
  NODE_ENV: "production", PORT: "3000", DEMO_MODE: "webform", QUESTIONS_PATH: "",
  META_APP_SECRET: "synthetic-app-secret", META_VERIFY_TOKEN: "synthetic-verify",
  META_PAGE_ACCESS_TOKEN: "synthetic-bot-token", FORM_TOKEN_SECRET: "f".repeat(64),
  PUBLIC_BASE_URL: "https://admin.example.test", SUPABASE_URL: "", SUPABASE_SECRET_KEY: "",
  SUPABASE_SERVICE_ROLE_KEY: "", LOG_PATH: "", TRUST_LOCAL_PROXY: "false",
  META_APP_ID: "202", META_LOGIN_CONFIG_ID: "303", ADMIN_FB_USER_IDS: "101",
  ADMIN_SESSION_SECRET: "s".repeat(64), ADMIN_ALLOWED_PAGE_ID: SANHE_PAGE_ID,
  ADMIN_ALLOWED_BUSINESS_ID: "",
});

test("signed real webhook feeds admin before existing continue branches; unsigned and echo events never qualify", async t => {
  const realFetch = globalThis.fetch, realLog = console.log;
  const calls = [], logs = [], jar = new Map();
  console.log = (...args) => logs.push(args.join(" "));
  globalThis.fetch = async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, "https://graph.facebook.com", "All external traffic must be mocked Graph calls");
    const path = url.pathname.replace(/^\/v\d+\.\d+\//, "");
    calls.push({ path, options });
    if (path === "oauth/access_token") return Response.json({ access_token: "synthetic-user-token", expires_in: 7200 });
    const token = options.headers.Authorization;
    if (token === "Bearer synthetic-bot-token") return Response.json({});
    assert.equal(token, path.startsWith(SANHE_PAGE_ID) ? "Bearer synthetic-admin-page-token" : "Bearer synthetic-user-token");
    if (path === "me") return Response.json({ id: "101" });
    if (path === "me/permissions") return Response.json({ data: ADMIN_SCOPES.map(permission => ({ permission, status: "granted" })) });
    if (path === "me/accounts") return Response.json({ data: [{ id: SANHE_PAGE_ID, name: "Synthetic Page", tasks: ["MESSAGING"], access_token: "synthetic-admin-page-token" }] });
    if (path === `${SANHE_PAGE_ID}/messages`) return Response.json({ message_id: "m_synthetic-webhook-reply" });
    throw new Error("Unexpected mock path");
  };
  let server;
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    globalThis.fetch = realFetch;
    console.log = realLog;
  });
  const { app } = await import("../src/server.js");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, options = {}) {
    const response = await realFetch(base + path, { ...options, redirect: "manual", headers: {
      Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "), ...options.headers,
    } });
    for (const value of response.headers.getSetCookie()) {
      const [name, content] = value.split(";")[0].split("=");
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(value)) jar.delete(name);
      else jar.set(name, content);
    }
    return { status: response.status, html: await response.text(), headers: response.headers };
  }
  const login = await request("/admin/login");
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  assert.equal((await request(`/admin/callback?state=${state}&code=synthetic-code`)).status, 303);
  const pages = await request("/admin/pages");
  const csrf = pages.html.match(/name="csrf" value="([^"]+)"/)[1];
  const post = (path, body) => request(path, { method: "POST", headers: { Origin: process.env.PUBLIC_BASE_URL }, body: new URLSearchParams({ csrf, ...body }) });
  assert.equal((await post("/admin/page", { page: SANHE_PAGE_ID })).status, 303);
  const event = (id, text, extra = {}) => ({ sender: { id }, recipient: { id: SANHE_PAGE_ID }, timestamp: Date.now(), message: { text }, ...extra });
  const payload = events => JSON.stringify({ object: "page", entry: [{ id: SANHE_PAGE_ID, messaging: events }] });
  const webhook = (body, signed = true) => request("/webhook", { method: "POST", headers: {
    "content-type": "application/json", "X-Hub-Signature-256": signed
      ? "sha256=" + crypto.createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex") : "sha256=invalid",
  }, body });
  assert.equal((await webhook(payload([event("700", "unsigned private inbound")]), false)).status, 403);
  assert.equal((await webhook(payload([event("701", "echo private inbound", { message: { is_echo: true, text: "echo" } })]))).status, 200);
  // Each valid event enters an existing branch that ends with continue.
  for (const [id, text] of [["702", "刪除我的資料"], ["703", "修改需求"], ["704", "新增需求"]]) {
    assert.equal((await webhook(payload([event(id, text)]))).status, 200);
  }
  // Unknown postback enters the webform branch's continue, but still opens a reply window.
  assert.equal((await webhook(payload([event("705", "", { message: null, postback: { payload: "synthetic_button" } })]))).status, 200);
  assert.equal((await webhook(payload([
    event("706", "", { message: null, delivery: { mids: [] } }),
    event("707", "", { message: null, read: { watermark: Date.now() } }),
    event("708", "future private inbound", { timestamp: Date.now() + 10 * 60_000 }),
    event("709", "", { message: null, postback: { payload: "synthetic_button" }, timestamp: Date.now() + 1000 }),
  ]))).status, 200);
  const recipients = await request("/admin/recipients");
  assert.equal(recipients.status, 200);
  const codes = [...recipients.html.matchAll(/<option value="([a-f0-9]{64})"/g)].map(match => match[1]);
  assert.equal(codes.length, 5);
  assert.doesNotMatch(recipients.html, /value="70[0-9]"|>70[0-9]<|private inbound|synthetic_button/);
  const operation = recipients.html.match(/name="operation" value="([^"]+)"/)[1];
  assert.equal((await post("/admin/send", { operation, recipient: codes[0], text: "unique synthetic admin reply" })).status, 303);
  const sends = calls.filter(call => call.options.headers.Authorization === "Bearer synthetic-admin-page-token" && call.path.endsWith("/messages"));
  assert.equal(sends.length, 1);
  assert.ok(["702", "703", "704", "705", "709"].includes(JSON.parse(sends[0].options.body).recipient.id));
  assert.match((await request("/admin/recipients")).html, /m_synthetic-webhook-reply/);
  process.env.META_LOGIN_CONFIG_ID = "";
  assert.equal((await request("/admin")).status, 503);
  assert.equal((await request("/health")).status, 200);
  assert.doesNotMatch(logs.join("\n"), /synthetic-.*token|unique synthetic admin reply|private inbound/);
});
