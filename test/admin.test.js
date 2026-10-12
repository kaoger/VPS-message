import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import express from "express";
import { createAdmin } from "../src/admin.js";
import { adminConfig, SANHE_PAGE_ID, ADMIN_SCOPES } from "../src/admin-config.js";
import { adminStore, DAY_MS, equalToken } from "../src/admin-store.js";
import { adminGraph } from "../src/admin-graph.js";
import { renderPrivacyPage } from "../src/legal-pages.js";

// Isolated synthetic settings. No dotenv, real Graph or Supabase requests.
process.env.LOG_PATH = "";
const origin = "https://admin.example.test";
const settings = () => ({ META_APP_ID: "202", META_LOGIN_CONFIG_ID: "303", META_APP_SECRET: "fake-app-secret",
  ADMIN_FB_USER_IDS: "101", ADMIN_SESSION_SECRET: "s".repeat(64), ADMIN_ALLOWED_PAGE_ID: SANHE_PAGE_ID,
  PUBLIC_BASE_URL: origin, ADMIN_ALLOWED_BUSINESS_ID: "", META_PAGE_ACCESS_TOKEN: "unused-bot-token" });
const input = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];

async function fixture(t, { overrides = {}, timeoutMs = 1000, storeOptions = {} } = {}) {
  const env = { ...settings(), ...overrides };
  let time = 1_800_000_000_000;
  const store = adminStore({ now: () => time, ...storeOptions });
  const calls = [], logs = [], jar = new Map();
  const mode = { userId: "101", tasks: ["MESSAGING"], grants: ADMIN_SCOPES, fields: ["messages", "feed"],
    expires: 7200, owned: true, business: "404", subscribed: true, pageToken: "fake-authorized-page-token" };
  const oldLog = console.log;
  console.log = (...args) => logs.push(args.join(" "));
  const fetchImpl = async (value, options) => {
    const url = new URL(value);
    assert.equal(url.origin, "https://graph.facebook.com");
    assert.ok(url.pathname.startsWith("/v23.0/"));
    assert.equal(options.redirect, "error");
    const path = url.pathname.slice("/v23.0/".length);
    calls.push({ path, options, url });
    if (path === "oauth/access_token") {
      assert.equal(options.method, "POST");
      assert.equal(url.search, "");
      assert.equal(options.headers["content-type"], "application/x-www-form-urlencoded");
      assert.equal(new URLSearchParams(options.body).get("client_secret"), env.META_APP_SECRET);
      assert.equal(new URLSearchParams(options.body).get("redirect_uri"), `${origin}/admin/callback`);
      return Response.json({ access_token: "fake-user-token", expires_in: mode.expires });
    }
    const token = options.headers.Authorization?.slice(7);
    assert.equal(token, path.startsWith(SANHE_PAGE_ID) ? mode.pageToken : "fake-user-token");
    assert.equal(url.searchParams.get("access_token"), null);
    assert.equal(url.searchParams.get("appsecret_proof"), crypto.createHmac("sha256", env.META_APP_SECRET).update(token).digest("hex"));
    if (mode.hangPath === path) return new Promise(() => {});
    if (mode.networkErrorPath === path) throw new Error("private-error fake-user-token");
    if (mode.errorPath === path) return Response.json({ error: { code: mode.errorCode ?? 200,
      message: "fake-user-token fake-authorized-page-token private-error", extra: env.META_APP_SECRET } }, { status: 400 });
    if (path === "me") return Response.json({ id: mode.userId });
    if (path === "me/permissions") return Response.json({ data: mode.grants.map(permission => ({ permission,
      status: mode.deniedPermission === permission ? "declined" : "granted" })) });
    if (path === "me/accounts") {
      mode.onAccounts?.();
      return Response.json({ data: [
      ...(!mode.hidePage ? [{ id: SANHE_PAGE_ID, name: mode.pageName || "Sanhe <Page>", tasks: mode.tasks, access_token: mode.pageToken }] : []),
      { id: "999", name: "Other Page", tasks: ["MESSAGING"], access_token: "discard-this-token" },
      ] });
    }
    if (path === "me/businesses") return Response.json({ data: mode.businesses || [{ id: mode.business, name: "Test <Business>" }] });
    if (path.endsWith("/owned_pages") && mode.ownedPages?.[path]) {
      const result = mode.ownedPages[path];
      return Response.json(typeof result === "function" ? result(url) : { data: result });
    }
    if (path === "404/owned_pages") return Response.json({ data: mode.owned ? [{ id: SANHE_PAGE_ID, name: "Owned <Page>" }] : [] });
    if (path === `${SANHE_PAGE_ID}/subscribed_apps`) {
      if (options.method === "POST") {
        assert.equal(options.headers["content-type"], "application/x-www-form-urlencoded");
        const fields = new URLSearchParams(options.body).get("subscribed_fields");
        assert.equal(typeof fields, "string");
        assert.match(fields, /^[a-z_]+(?:,[a-z_]+)+$/);
        const submitted = fields.split(",");
        for (const field of [...(mode.subscribed ? mode.fields : []), "messages", "messaging_postbacks"]) {
          assert.ok(submitted.includes(field), `Missing subscription field: ${field}`);
        }
        if (mode.subscriptionWait) await mode.subscriptionWait;
        if (!mode.mismatch) mode.fields = submitted;
        if (mode.extraField) mode.fields.push("leadgen");
        mode.subscribed = true;
        return Response.json({ success: true });
      }
      return Response.json({ data: [{ id: "505", subscribed_fields: ["leadgen"] },
        ...(mode.subscribed ? [{ id: "202", subscribed_fields: mode.fields }] : [])] });
    }
    if (path === `${SANHE_PAGE_ID}/messages`) {
      assert.equal(options.headers["content-type"], "application/json");
      if (mode.hang) return new Promise(() => {});
      if (mode.wait) await mode.wait;
      return Response.json(mode.noMessageId ? {} : { message_id: mode.messageId || "m_fake-message-001" });
    }
    throw new Error("Unexpected mock path");
  };
  const admin = createAdmin({ env, store, fetchImpl, timeoutMs });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/admin", admin.router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    store.close();
    await new Promise(resolve => server.close(resolve));
    console.log = oldLog;
  });
  async function request(path, { cookie, headers = {}, ...options } = {}) {
    const response = await fetch(base + path, { ...options, redirect: "manual", headers: {
      Cookie: cookie ?? [...jar].map(([name, value]) => `${name}=${value}`).join("; "), ...headers,
    } });
    for (const value of response.headers.getSetCookie()) {
      const [name, content] = value.split(";")[0].split("=");
      if (/Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(value)) jar.delete(name);
      else jar.set(name, content);
    }
    const html = await response.text();
    return { status: response.status, html, headers: response.headers };
  }
  async function start() {
    const response = await request("/admin/login");
    return { ...response, state: new URL(response.headers.get("location")).searchParams.get("state") };
  }
  async function login() {
    const initial = await start();
    return request(`/admin/callback?state=${initial.state}&code=mock-code`);
  }
  let csrf;
  async function authorize() {
    const response = await login();
    assert.equal(response.status, 303, response.html);
    const page = await request("/admin/pages");
    csrf = input(page.html, "csrf");
    assert.ok(csrf);
    const selected = await post("/admin/page", { page: SANHE_PAGE_ID });
    assert.equal(selected.status, 303, selected.html);
  }
  async function post(path, body, options = {}) {
    return request(path, { method: "POST", body: new URLSearchParams({ csrf: csrf || "", ...body }),
      headers: { Origin: origin, ...options.headers }, cookie: options.cookie });
  }
  function observe({ timestamp = time, psid = "606", pageId = SANHE_PAGE_ID, ...changes } = {}) {
    admin.observe(pageId, { sender: { id: psid }, recipient: { id: pageId }, timestamp, message: { text: "private inbound" }, ...changes });
  }
  async function prepare() {
    const response = await request("/admin/recipients");
    return { operation: input(response.html, "operation"), recipient: response.html.match(/<option value="([a-f0-9]{64})"/)?.[1], html: response.html };
  }
  return { env, store, calls, logs, jar, mode, request, post, start, login, authorize, observe, prepare,
    advance: ms => { time += ms; }, sends: () => calls.filter(call => call.path.endsWith("/messages")),
    getCsrf: () => csrf };
}

test("missing or invalid admin configuration returns 503 without affecting health", async t => {
  const f = await fixture(t, { overrides: { META_LOGIN_CONFIG_ID: "" } });
  assert.equal((await f.request("/admin")).status, 503);
  assert.equal((await f.request("/health")).status, 200);
  for (const key of ["META_APP_ID", "META_LOGIN_CONFIG_ID", "META_APP_SECRET", "ADMIN_FB_USER_IDS", "ADMIN_SESSION_SECRET", "ADMIN_ALLOWED_PAGE_ID", "PUBLIC_BASE_URL"]) {
    assert.equal(adminConfig({ ...settings(), [key]: "" }), null, key);
  }
  for (const overrides of [{ PUBLIC_BASE_URL: "http://admin.example.test" }, { PUBLIC_BASE_URL: `${origin}/path` },
    { ADMIN_SESSION_SECRET: "short" }, { ADMIN_ALLOWED_PAGE_ID: "999" }, { ADMIN_FB_USER_IDS: "101,,202" }, { ADMIN_ALLOWED_BUSINESS_ID: "bad" }]) {
    assert.equal(adminConfig({ ...settings(), ...overrides }), null);
  }
  assert.equal(f.calls.length, 0);
});

test("login uses configuration, signed secure state cookie, strict CSP and no scope override", async t => {
  const f = await fixture(t);
  const home = await f.request("/admin");
  assert.match(home.html, /Continue with Facebook/);
  assert.doesNotMatch(home.html, /<script|fake-user-token/);
  assert.match(home.headers.get("content-security-policy"), /default-src 'none'.*form-action 'self'.*frame-ancestors 'none'/);
  assert.equal(home.headers.get("cache-control"), "no-store");
  assert.equal(home.headers.get("referrer-policy"), "same-origin");
  const login = await f.start();
  const url = new URL(login.headers.get("location"));
  assert.equal(url.hostname, "www.facebook.com");
  assert.equal(url.searchParams.get("config_id"), "303");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), null);
  assert.equal(url.searchParams.get("auth_type"), "rerequest");
  assert.match(login.state, /^[a-f0-9]{64}$/);
  const cookie = login.headers.getSetCookie()[0];
  for (const flag of [/HttpOnly/, /Secure/, /SameSite=Lax/, /Path=\/admin/]) assert.match(cookie, flag);
});

test("invalid, duplicated, mismatched, expired and replayed OAuth states never exchange tokens", async t => {
  const f = await fixture(t);
  const invalid = await f.request("/admin/callback?state=bad&code=mock");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("referrer-policy"), "no-referrer");
  let initial = await f.start();
  assert.equal((await f.request(`/admin/callback?state=${initial.state}&state=${initial.state}&code=mock`)).status, 400);
  initial = await f.start();
  assert.equal((await f.request(`/admin/callback?state=${"a".repeat(64)}&code=mock`)).status, 400);
  initial = await f.start();
  f.advance(5 * 60_000);
  assert.equal((await f.request(`/admin/callback?state=${initial.state}&code=mock`)).status, 400);
  assert.equal(f.calls.length, 0);
  initial = await f.start();
  const cookie = [...f.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  assert.equal((await f.request(`/admin/callback?state=${initial.state}&code=mock`)).status, 303);
  const count = f.calls.length;
  assert.equal((await f.request(`/admin/callback?state=${initial.state}&code=mock`, { cookie })).status, 400);
  assert.equal(f.calls.length, count);
});

test("non-allowlisted user gets app-scoped ID, no session or retained token", async t => {
  const f = await fixture(t);
  f.mode.userId = "707";
  const response = await f.login();
  assert.equal(response.status, 403);
  assert.match(response.html, /請把此 ID 交給管理員：707/);
  assert.doesNotMatch(response.html, /fake-user-token/);
  assert.equal(f.jar.has("sanhe_admin_session"), false);
  assert.deepEqual(f.calls.map(call => call.path), ["oauth/access_token", "me"]);
  assert.equal((await f.request("/admin/pages")).status, 401);
});

test("login requires all four grants and the supported Page MESSAGING task", async t => {
  const f = await fixture(t);
  f.mode.grants = ["pages_show_list"];
  assert.equal((await f.login()).status, 403);
  f.mode.grants = ADMIN_SCOPES;
  f.mode.tasks = ["ANALYZE"];
  assert.equal((await f.login()).status, 403);
  assert.equal(f.jar.has("sanhe_admin_session"), false);
});

test("successful re-login rotates session, invalidates old signed cookie, and logout is local only", async t => {
  const f = await fixture(t);
  await f.authorize();
  const old = `sanhe_admin_session=${f.jar.get("sanhe_admin_session")}`;
  await f.authorize();
  assert.notEqual(old, `sanhe_admin_session=${f.jar.get("sanhe_admin_session")}`);
  assert.equal((await f.request("/admin/pages", { cookie: old })).status, 401);
  const calls = f.calls.length;
  assert.equal((await f.post("/admin/logout", {})).status, 303);
  assert.equal((await f.request("/admin/pages")).status, 401);
  assert.equal(f.calls.length, calls);
  assert.ok(!f.calls.some(call => call.options.method === "DELETE"));
});

test("idle session expiry rejects all protected actions", async t => {
  const f = await fixture(t);
  await f.authorize();
  f.advance(30 * 60_000);
  assert.equal((await f.post("/admin/send", {})).status, 401);
  assert.equal(f.sends().length, 0);
});

test("absolute and earlier token expiry apply despite continued activity", async t => {
  const f = await fixture(t);
  await f.authorize();
  for (let i = 0; i < 5; i++) { f.advance(20 * 60_000); assert.equal((await f.request("/admin")).status, 200); }
  f.advance(20 * 60_000);
  assert.equal((await f.request("/admin/pages")).status, 401);
  f.mode.expires = 60;
  await f.authorize();
  f.advance(60_000);
  assert.equal((await f.post("/admin/logout", {})).status, 401);
});

test("all POSTs reject missing CSRF, malformed unicode, cross origin and absent session before Graph", async t => {
  const f = await fixture(t);
  await f.authorize();
  const count = f.calls.length;
  for (const path of ["/admin/page", "/admin/subscription", "/admin/send", "/admin/logout"]) {
    assert.equal((await f.post(path, { csrf: "" })).status, 403);
    assert.equal((await f.post(path, { csrf: "é".repeat(64) })).status, 403);
    assert.equal((await f.post(path, {}, { headers: { Origin: "https://evil.example.test" } })).status, 403);
    assert.equal((await f.post(path, {}, { headers: { Origin: "" } })).status, 403);
    assert.equal((await f.post(path, {}, { cookie: "" })).status, 401);
  }
  assert.equal(f.calls.length, count);
  assert.equal(equalToken("é", "x"), false);
});

test("business restriction verifies membership and Page ownership; foreign business/Page rejected", async t => {
  const f = await fixture(t, { overrides: { ADMIN_ALLOWED_BUSINESS_ID: "404" } });
  f.mode.owned = false;
  assert.equal((await f.login()).status, 502);
  f.mode.owned = true;
  await f.authorize();
  const business = await f.request("/admin/businesses?business=404");
  assert.equal(business.status, 200);
  assert.match(business.html, /Test &lt;Business&gt;.*Owned Pages/s);
  assert.match(business.html, /Owned &lt;Page&gt;/);
  assert.equal((await f.request("/admin/businesses?business=999")).status, 403);
  const count = f.calls.length;
  assert.equal((await f.post("/admin/page", { page: "999" })).status, 403);
  assert.equal(f.calls.length, count);
  f.mode.tasks = [];
  assert.equal((await f.post("/admin/page", { page: SANHE_PAGE_ID })).status, 403);
  assert.equal((await f.request("/admin/recipients")).status, 403);
});

test("businesses automatically show only Sanhe owners and count other Pages without their names or IDs", async t => {
  const f = await fixture(t);
  await f.login();
  f.mode.businesses = [{ id: "404", name: '<b>Sanhe & Business</b>' },
    { id: "777777", name: "Private foreign business" }, { id: "405", name: "Another Sanhe owner" },
    { id: "invalid/path", name: "Invalid business" }];
  f.mode.ownedPages = {
    "404/owned_pages": [{ id: SANHE_PAGE_ID, name: '<img src=x onerror="alert(1)">' },
      { id: "888888", name: "Private other Page" }, { id: "888889", name: "Another private Page" }],
    "777777/owned_pages": [{ id: "999999", name: "Foreign owned Page" }],
    "405/owned_pages": [{ id: SANHE_PAGE_ID, name: "Second supported Page" }],
  };
  const before = f.calls.length;
  const response = await f.request("/admin/businesses");
  assert.equal(response.status, 200);
  assert.match(response.html, /&lt;b&gt;Sanhe &amp; Business&lt;\/b&gt;/);
  assert.match(response.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(response.html, /Owned Pages.*Supported Page.*Other Pages: 2 \(not supported\)/s);
  assert.match(response.html, /Another Sanhe owner.*Second supported Page/s);
  assert.doesNotMatch(response.html, /Private foreign business|777777|Private other Page|888888|888889|Foreign owned Page|999999|Another private Page|Invalid business|<img|\?business=/);
  assert.deepEqual(f.calls.slice(before).map(call => call.path), ["me/businesses", "404/owned_pages", "777777/owned_pages", "405/owned_pages"]);
  assert.equal((await f.request("/admin/businesses?business=777777")).status, 403);
});

test("configured business wins over other Sanhe owners and still requires Page ownership", async t => {
  const f = await fixture(t, { overrides: { ADMIN_ALLOWED_BUSINESS_ID: "404" } });
  await f.login();
  f.mode.businesses = [{ id: "404", name: "Configured Sanhe business" }, { id: "777777", name: "Hidden Sanhe owner" }];
  const before = f.calls.length;
  const response = await f.request("/admin/businesses");
  assert.match(response.html, /Configured Sanhe business.*Owned &lt;Page&gt;/s);
  assert.doesNotMatch(response.html, /Hidden Sanhe owner|777777/);
  assert.deepEqual(f.calls.slice(before).map(call => call.path), ["me/businesses", "404/owned_pages"]);
  f.mode.owned = false;
  const empty = await f.request("/admin/businesses");
  assert.match(empty.html, /No supported business portfolios/);
  assert.doesNotMatch(empty.html, /Configured Sanhe business|Business ID: 404/);
});

test("ownership filtering includes later owned_pages results and fails closed on lookup failure", async t => {
  const f = await fixture(t);
  await f.login();
  f.mode.ownedPages = { "404/owned_pages": url => url.searchParams.has("after")
    ? { data: [{ id: SANHE_PAGE_ID, name: "Supported on second page" }] }
    : { data: [{ id: "888888", name: "Private first page" }], paging: {
      next: "https://do-not-follow.example.test", cursors: { after: "owned-next" } } } };
  const response = await f.request("/admin/businesses");
  assert.match(response.html, /Supported on second page.*Other Pages: 1/s);
  assert.doesNotMatch(response.html, /Private first page|888888/);
  const queries = f.calls.filter(call => call.path === "404/owned_pages");
  assert.equal(queries.length, 2);
  assert.equal(queries[1].url.searchParams.get("after"), "owned-next");
  f.mode.errorPath = "404/owned_pages";
  const failed = await f.request("/admin/businesses");
  assert.equal(failed.status, 502);
  assert.doesNotMatch(failed.html, /Test &lt;Business&gt;|Business ID: 404|Private first page|888888/);
});

test("Page selection exposes only supported assets and does not retain unrelated names", async t => {
  const f = await fixture(t);
  await f.login();
  const response = await f.request("/admin/pages");
  assert.match(response.html, /Sanhe &lt;Page&gt;/);
  assert.match(response.html, /Other Pages: 1 \(not supported\)/);
  assert.doesNotMatch(response.html, /Other Page<|>999<|Page ID: 999|discard-this-token/);
  const session = f.store.session(f.jar.get("sanhe_admin_session").split(".")[0]);
  assert.equal(session.pages, undefined);
  assert.equal(session.otherPageCount, 1);
});

const progressSteps = html => [...html.matchAll(/<(?:a|span) class="step[^>]*>.*?<\/li>/gs)].map(match => match[0]);
test("step progress follows login, Page selection and verified confirmation; GET alone never completes webhook", async t => {
  const f = await fixture(t);
  const home = await f.request("/admin");
  assert.equal(progressSteps(home.html).length, 4);
  assert.ok(progressSteps(home.html).every(step => !step.includes('class="step complete"')));
  await f.login();
  const business = progressSteps((await f.request("/admin/businesses")).html);
  assert.match(business[0], /complete.*aria-current="step"/);
  assert.doesNotMatch(business[1], /complete/);
  await f.authorize();
  let webhook = await f.request("/admin/subscription");
  let steps = progressSteps(webhook.html);
  assert.match(steps[1], /complete/);
  assert.match(steps[2], /aria-current="step"/);
  assert.doesNotMatch(steps[2], /complete/);
  await f.post("/admin/subscription", { operation: input(webhook.html, "operation") });
  webhook = await f.request("/admin/subscription");
  assert.match(progressSteps(webhook.html)[2], /complete.*aria-current="step"/);
  assert.match(webhook.html, /class="notice success" role="status">Subscription confirmed/);
  const send = progressSteps((await f.request("/admin/recipients")).html);
  assert.match(send[2], /complete/);
  assert.match(send[3], /aria-current="step"/);
  assert.doesNotMatch(send[3], /complete/);
  f.mode.mismatch = true;
  f.mode.fields = ["messages"];
  await f.post("/admin/subscription", { operation: input(webhook.html, "operation") });
  webhook = await f.request("/admin/subscription");
  assert.match(webhook.html, /class="notice warning" role="status">Warning:/);
  assert.doesNotMatch(progressSteps(webhook.html)[2], /complete/);
});

test("webhook progress resets on external removal, Page re-selection and failed confirmation", async t => {
  const f = await fixture(t);
  await f.authorize();
  async function confirm() {
    const page = await f.request("/admin/subscription");
    await f.post("/admin/subscription", { operation: input(page.html, "operation") });
    const confirmed = await f.request("/admin/subscription");
    assert.match(progressSteps(confirmed.html)[2], /complete/);
    return confirmed;
  }
  await confirm();
  f.mode.subscribed = false;
  const removed = await f.request("/admin/subscription");
  assert.doesNotMatch(progressSteps(removed.html)[2], /complete/);
  assert.match(removed.html, /class="notice warning".*no longer confirmed/);
  await confirm();
  await f.post("/admin/page", { page: SANHE_PAGE_ID });
  assert.doesNotMatch(progressSteps((await f.request("/admin/subscription")).html)[2], /complete/);
  const confirmed = await confirm();
  f.mode.errorPath = `${SANHE_PAGE_ID}/subscribed_apps`;
  assert.equal((await f.post("/admin/subscription", { operation: input(confirmed.html, "operation") })).status, 502);
  f.mode.errorPath = "";
  const failed = await f.request("/admin/subscription");
  assert.doesNotMatch(progressSteps(failed.html)[2], /complete/);
  assert.doesNotMatch(failed.html, /Subscription confirmed/);
});

test("all main controls have visible descriptions and tooltips while CSP permits only nonced CSS", async t => {
  const f = await fixture(t);
  const home = await f.request("/admin");
  assert.match(home.html, /Continue with Facebook<\/a><p class="hint" id="login-help">/);
  await f.authorize();
  f.observe();
  const pages = [["/admin/businesses", "business_management"], ["/admin/pages", "pages_show_list"],
    ["/admin/subscription", "pages_manage_metadata"], ["/admin/recipients", "pages_messaging"]];
  for (const [path, permission] of pages) {
    const response = await f.request(path);
    assert.match(response.html, /Sanhe Interior Design · Messenger Admin/);
    assert.match(response.html, new RegExp(`This step uses ${permission}`));
    assert.equal((response.html.match(/<[^>]+ aria-current="step"/g) || []).length, 1);
    assert.match(response.html, /title="End this admin session" aria-describedby="logout-help">Log out<\/button><p class="hint" id="logout-help">/);
    for (const match of response.html.matchAll(/<button[^>]+aria-describedby="([^"]+)"[^>]*>/g)) {
      assert.match(match[0], /title="[^"]+"/);
      assert.ok(response.html.includes(`<p class="hint" id="${match[1]}">`));
    }
    const nonce = response.html.match(/<style nonce="([a-f0-9]+)">/)[1];
    assert.ok(response.headers.get("content-security-policy").includes(`style-src 'nonce-${nonce}'`));
    assert.doesNotMatch(response.html, /<script|style=|<img|<link|on(?:click|load)=/);
    assert.doesNotMatch(response.headers.get("content-security-policy"), /unsafe-inline|script-src/);
  }
});

test("subscription reads are side-effect free; confirmation retains union, verifies, and prevents replay", async t => {
  const f = await fixture(t);
  await f.authorize();
  const response = await f.request("/admin/subscription");
  const subscriptions = () => f.calls.filter(call => call.path.endsWith("subscribed_apps"));
  assert.ok(subscriptions().every(call => call.options.method === "GET"));
  assert.match(response.html, /messages, feed/);
  const operation = input(response.html, "operation");
  assert.equal((await f.post("/admin/subscription", { operation })).status, 303);
  assert.deepEqual(subscriptions().slice(-3).map(call => call.options.method), ["GET", "POST", "GET"]);
  const write = subscriptions().find(call => call.options.method === "POST");
  assert.equal(write.options.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(new URLSearchParams(write.options.body).get("subscribed_fields"), "messages,feed,messaging_postbacks");
  assert.equal((await f.post("/admin/subscription", { operation })).status, 409);
  const after = await f.request("/admin/subscription");
  assert.match(after.html, /Subscription confirmed/);
  f.mode.mismatch = true;
  f.mode.fields = ["messages", "feed"];
  assert.equal((await f.post("/admin/subscription", { operation: input(after.html, "operation") })).status, 303);
  assert.match((await f.request("/admin/subscription")).html, /Warning: subscription verification did not match/);
  assert.ok(!f.calls.some(call => call.options.method === "DELETE"));
});

test("unknown subscription fields refuse writes rather than risking removal", async t => {
  const f = await fixture(t);
  await f.authorize();
  const page = await f.request("/admin/subscription");
  f.mode.fields = undefined;
  assert.equal((await f.post("/admin/subscription", { operation: input(page.html, "operation") })).status, 502);
  assert.equal(f.calls.filter(call => call.path.endsWith("subscribed_apps") && call.options.method === "POST").length, 0);
});

test("subscription verification warns when Graph adds unexpected fields", async t => {
  const f = await fixture(t);
  await f.authorize();
  const page = await f.request("/admin/subscription");
  f.mode.extraField = true;
  assert.equal((await f.post("/admin/subscription", { operation: input(page.html, "operation") })).status, 303);
  assert.match((await f.request("/admin/subscription")).html, /Warning: subscription verification did not match/);
});

test("subscription writes are serialized across different administrator sessions", async t => {
  const f = await fixture(t);
  await f.authorize();
  const firstCookie = `sanhe_admin_session=${f.jar.get("sanhe_admin_session")}`;
  const firstCsrf = f.getCsrf();
  const firstPage = await f.request("/admin/subscription");
  const login = await f.request("/admin/login", { cookie: "" });
  const state = new URL(login.headers.get("location")).searchParams.get("state");
  assert.equal((await f.request(`/admin/callback?state=${state}&code=mock`, {
    cookie: `sanhe_admin_state=${f.jar.get("sanhe_admin_state")}`,
  })).status, 303);
  const secondCsrf = input((await f.request("/admin/pages")).html, "csrf");
  assert.equal((await f.post("/admin/page", { csrf: secondCsrf, page: SANHE_PAGE_ID })).status, 303);
  const secondPage = await f.request("/admin/subscription");
  let release;
  f.mode.subscriptionWait = new Promise(resolve => { release = resolve; });
  const first = f.post("/admin/subscription", { csrf: firstCsrf, operation: input(firstPage.html, "operation") }, { cookie: firstCookie });
  const writes = () => f.calls.filter(call => call.path.endsWith("subscribed_apps") && call.options.method === "POST");
  while (writes().length === 0) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.post("/admin/subscription", { csrf: secondCsrf, operation: input(secondPage.html, "operation") })).status, 409);
  release();
  assert.equal((await first).status, 303);
  assert.equal(writes().length, 1);
});

test("logout also invalidates an outstanding OAuth state", async t => {
  const f = await fixture(t);
  await f.authorize();
  const pending = await f.start();
  const cookie = [...f.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  assert.equal((await f.post("/admin/logout", {})).status, 303);
  const count = f.calls.length;
  assert.equal((await f.request(`/admin/callback?state=${pending.state}&code=mock`, { cookie })).status, 400);
  assert.equal(f.calls.length, count);
});

test("observer failure is contained and logs only a fixed event", async t => {
  const f = await fixture(t);
  f.store.observe = () => { throw new Error("private inbound fake-user-token"); };
  assert.doesNotThrow(() => f.observe());
  assert.equal((await f.request("/health")).status, 200);
  assert.deepEqual(f.logs, ["admin_observer_failed"]);
});

test("observer rejects foreign Page, echo, non-message, forged timestamps; out-of-order takes maximum", async t => {
  const f = await fixture(t);
  await f.authorize();
  const invalid = [{ pageId: "999" }, { message: { is_echo: true } }, { message: null },
    { delivery: {} }, { read: {} }, { timestamp: 1_800_000_300_001 }, { timestamp: "1800000000000" },
    { timestamp: NaN }, { timestamp: 0 }, { psid: "bad" }, { recipient: { id: "999" } }];
  for (const row of invalid) f.observe(row);
  assert.equal(f.store.recipients(SANHE_PAGE_ID).length, 0);
  f.observe({ timestamp: 1_800_000_000_000 - 1000 });
  f.observe({ timestamp: 1_800_000_000_000 - 2000 });
  assert.equal(f.store.recipients(SANHE_PAGE_ID)[0].lastInboundAt, 1_800_000_000_000 - 1000);
  const ready = await f.prepare();
  assert.match(ready.html, /Customer 1.*Within 24 hours/s);
  assert.doesNotMatch(ready.html, /value="606"|>606<|private inbound/);
});

test("clock skew up to five minutes qualifies immediately but never extends the reply window", async t => {
  const f = await fixture(t);
  const observedAt = 1_800_000_000_000;
  for (const [psid, skew] of [["606", 1], ["607", 1000], ["608", 5 * 60_000]]) {
    f.observe({ psid, timestamp: observedAt + skew });
    const row = f.store.recipient(SANHE_PAGE_ID, psid);
    assert.equal(row.lastInboundAt, observedAt);
    assert.equal(f.store.canReply(row), true);
  }
  f.observe({ psid: "609", timestamp: observedAt + 5 * 60_000 + 1 });
  assert.equal(f.store.recipient(SANHE_PAGE_ID, "609"), undefined);
  // A delayed older event cannot move the clamped timestamp backwards.
  f.observe({ timestamp: observedAt - 1 });
  assert.equal(f.store.recipient(SANHE_PAGE_ID, "606").lastInboundAt, observedAt);
  f.advance(DAY_MS - 1);
  for (const row of f.store.recipients(SANHE_PAGE_ID)) assert.equal(f.store.canReply(row), true);
  f.advance(1);
  for (const row of f.store.recipients(SANHE_PAGE_ID)) assert.equal(f.store.canReply(row), false);
});

test("customer postback opens and refreshes the reply window; echo, delivery, read and foreign Page remain excluded", async t => {
  const f = await fixture(t);
  await f.authorize();
  const postback = { message: null, postback: { payload: "private button payload", title: "private button title" } };
  for (const extra of [{ pageId: "999" }, { message: { is_echo: true } }, { delivery: {} }, { read: {} }]) {
    f.observe({ ...postback, ...extra });
  }
  assert.equal(f.store.recipients(SANHE_PAGE_ID).length, 0);
  f.observe({ timestamp: 1_800_000_000_000 - DAY_MS });
  assert.equal(f.store.canReply(f.store.recipient(SANHE_PAGE_ID, "606")), false);
  f.observe(postback);
  const ready = await f.prepare();
  assert.match(ready.html, /Within 24 hours/);
  assert.doesNotMatch(ready.html, /private button/);
  assert.equal((await f.post("/admin/send", { ...ready, text: "postback reply" })).status, 303);
  assert.equal(f.sends().length, 1);
});

async function prepareWrite(f, kind) {
  if (kind === "send") {
    f.observe();
    const ready = await f.prepare();
    return { operation: ready.operation, recipient: ready.recipient, text: "fresh authorization reply" };
  }
  const page = await f.request("/admin/subscription");
  assert.equal(page.status, 200);
  return { operation: input(page.html, "operation") };
}

for (const kind of ["send", "subscription"]) {
  test(`${kind} refreshes Page token and all four permissions immediately before Graph writes`, async t => {
    const f = await fixture(t);
    await f.authorize();
    const body = await prepareWrite(f, kind);
    f.mode.pageToken = "fake-refreshed-page-token";
    const start = f.calls.length;
    assert.equal((await f.post(`/admin/${kind}`, body)).status, 303);
    const calls = f.calls.slice(start);
    assert.deepEqual(calls.slice(0, 2).map(call => call.path), ["me/accounts", "me/permissions"]);
    const write = calls.find(call => call.options.method === "POST");
    assert.equal(write.options.headers.Authorization, "Bearer fake-refreshed-page-token");
    const session = f.store.session(f.jar.get("sanhe_admin_session").split(".")[0], false);
    assert.equal(session.page.token, "fake-refreshed-page-token");
    const html = (await f.request("/admin")).html;
    assert.doesNotMatch(html + f.logs.join("\n"), /fake-refreshed-page-token/);
  });

  test(`${kind} rejects revoked access and authorization lookup failures without Graph writes`, async t => {
    const failures = [
      ["missing MESSAGING", f => { f.mode.tasks = ["ANALYZE"]; }],
      ["missing Page", f => { f.mode.hidePage = true; }],
      ["missing Page token", f => { f.mode.pageToken = ""; }],
      ...ADMIN_SCOPES.map(permission => [`declined ${permission}`, f => { f.mode.deniedPermission = permission; }]),
      ["missing permission", f => { f.mode.grants = ADMIN_SCOPES.slice(1); }],
      ["accounts Graph error", f => { f.mode.errorPath = "me/accounts"; }],
      ["permissions Graph error", f => { f.mode.errorPath = "me/permissions"; }],
      ["invalid User token", f => { f.mode.errorPath = "me/accounts"; f.mode.errorCode = 190; }],
      ["accounts timeout", f => { f.mode.hangPath = "me/accounts"; }],
      ["permissions timeout", f => { f.mode.hangPath = "me/permissions"; }],
      ["network failure", f => { f.mode.networkErrorPath = "me/accounts"; }],
    ];
    for (const [name, fail] of failures) await t.test(name, async child => {
      const f = await fixture(child, { timeoutMs: 100 });
      await f.authorize();
      const body = await prepareWrite(f, kind);
      const session = f.store.session(f.jar.get("sanhe_admin_session").split(".")[0], false);
      fail(f);
      const start = f.calls.length;
      const response = await f.post(`/admin/${kind}`, body);
      assert.equal(response.status, 403);
      assert.match(response.html, /Please sign in again/);
      assert.doesNotMatch(response.html + f.logs.join("\n"), /fake-.*token|private-error|fake-app-secret/);
      assert.equal(session.page, null);
      assert.equal(session.availablePage, null);
      assert.ok(f.calls.slice(start).every(call => call.options.method === "GET"));
      assert.equal((await f.request("/admin/recipients")).status, f.mode.errorCode === 190 ? 401 : 403);
    });
  });

  test(`${kind} rejects session expiry during authorization lookup before Graph writes`, async t => {
    const f = await fixture(t);
    await f.authorize();
    const body = await prepareWrite(f, kind);
    f.mode.onAccounts = () => f.advance(30 * 60_000);
    const start = f.calls.length;
    assert.equal((await f.post(`/admin/${kind}`, body)).status, 401);
    assert.ok(f.calls.slice(start).every(call => call.options.method === "GET"));
  });
}

test("send rechecks the 24-hour boundary after authorization lookup", async t => {
  const f = await fixture(t);
  await f.authorize();
  f.observe({ timestamp: 1_800_000_000_000 - DAY_MS + 1 });
  const ready = await f.prepare();
  f.mode.onAccounts = () => f.advance(1);
  const response = await f.post("/admin/send", { ...ready, text: "expired during lookup" });
  assert.equal(response.status, 400);
  assert.match(response.html, /24-hour reply window has expired/);
  assert.equal(f.sends().length, 0);
});

test("24-hour boundary, stale form and forged recipient are rejected before any send", async t => {
  const f = await fixture(t);
  await f.authorize();
  f.observe({ timestamp: 1_800_000_000_000 - DAY_MS });
  let ready = await f.prepare();
  assert.match(ready.html, /Expired: reply disabled/);
  assert.equal((await f.post("/admin/send", { ...ready, text: "reply" })).status, 400);
  f.observe({ timestamp: 1_800_000_000_000 - DAY_MS + 1 });
  ready = await f.prepare();
  f.advance(1);
  assert.equal((await f.post("/admin/send", { ...ready, text: "reply" })).status, 400);
  f.observe();
  ready = await f.prepare();
  assert.equal((await f.post("/admin/send", { ...ready, recipient: "606", text: "reply" })).status, 400);
  assert.equal((await f.post("/admin/send", { ...ready, text: "x".repeat(2001) })).status, 400);
  assert.equal((await f.post("/admin/send", { ...ready, text: " " })).status, 400);
  assert.equal(f.sends().length, 0);
});

test("complete mock flow sends one RESPONSE using logged-in Page token, safe message ID/time, no secrets/log body", async t => {
  const f = await fixture(t);
  await f.authorize();
  await f.request("/admin/businesses?business=404");
  await f.request("/admin/subscription");
  f.observe();
  const ready = await f.prepare();
  const response = await f.post("/admin/send", { operation: ready.operation, recipient: ready.recipient, text: "unique-private-reply" });
  assert.equal(response.status, 303);
  const call = f.sends()[0];
  assert.deepEqual(JSON.parse(call.options.body), { messaging_type: "RESPONSE", recipient: { id: "606" }, message: { text: "unique-private-reply" } });
  assert.equal(call.options.headers.Authorization, "Bearer fake-authorized-page-token");
  assert.equal((await f.post("/admin/send", { operation: ready.operation, recipient: ready.recipient, text: "unique-private-reply" })).status, 409);
  assert.equal(f.sends().length, 1);
  const result = await f.request("/admin/recipients");
  assert.match(result.html, /Meta accepted the reply.*m_fake-message-001.*Time \(UTC\)/s);
  assert.match(result.html, /class="notice success" role="status">Meta accepted/);
  assert.doesNotMatch(result.html, /fake-user-token|fake-authorized-page-token|discard-this-token|unique-private-reply|unused-bot-token/);
  assert.doesNotMatch(f.logs.join("\n"), /101|606|fake-.*token|fake-app-secret|unique-private-reply|private inbound/);
  assert.ok(f.logs.every(line => /^admin_[a-z_]+(?: \d+)?$/.test(line)));
});

test("concurrent replay cannot send twice; new operation cannot bypass an in-flight send", async t => {
  const f = await fixture(t);
  await f.authorize();
  f.observe();
  const ready = await f.prepare();
  let release;
  f.mode.wait = new Promise(resolve => { release = resolve; });
  const first = f.post("/admin/send", { ...ready, text: "one" });
  while (f.sends().length === 0) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.post("/admin/send", { ...ready, text: "one" })).status, 409);
  const other = await f.prepare();
  assert.equal((await f.post("/admin/send", { ...other, text: "two" })).status, 409);
  release();
  assert.equal((await first).status, 303);
  assert.equal(f.sends().length, 1);
});

test("Graph errors expose only numeric code; invalid token clears session; all values escape/redact", async t => {
  const f = await fixture(t);
  await f.authorize();
  f.mode.pageName = '<img src=x onerror="alert(1)"> fake-authorized-page-token fake-user-token';
  const page = await f.request("/admin/pages");
  assert.match(page.html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt; \[redacted\] \[redacted\]/);
  assert.doesNotMatch(page.html, /<img|fake-.*token/);
  f.mode.errorPath = "me/businesses";
  f.mode.errorCode = 200;
  let failed = await f.request("/admin/businesses");
  assert.equal(failed.status, 502);
  assert.match(failed.html, /Meta error code: 200/);
  assert.doesNotMatch(failed.html + f.logs.join(""), /private-error|fake-.*token|fake-app-secret/);
  f.mode.errorCode = 190;
  assert.equal((await f.request("/admin/businesses")).status, 502);
  assert.equal((await f.request("/admin/pages")).status, 401);
});

test("timeout is unconfirmed, no retries; replay stays blocked", async t => {
  const f = await fixture(t, { timeoutMs: 20 });
  await f.authorize();
  f.observe();
  const ready = await f.prepare();
  f.mode.hang = true;
  const response = await f.post("/admin/send", { ...ready, text: "reply" });
  assert.equal(response.status, 502);
  assert.match(response.html, /Result unconfirmed.*No automatic retry/s);
  assert.match(response.html, /class="notice warning" role="alert"/);
  assert.match((await f.request("/admin/recipients")).html, /class="notice warning" role="status">Result unconfirmed/);
  assert.equal(f.sends()[0].options.signal.aborted, true);
  assert.equal((await f.post("/admin/send", { ...ready, text: "reply" })).status, 409);
  assert.equal(f.sends().length, 1);
});

test("missing message_id is not confirmed as success; upstream IDs are escaped and tokens redacted", async t => {
  const f = await fixture(t);
  await f.authorize();
  f.observe();
  let ready = await f.prepare();
  f.mode.noMessageId = true;
  assert.match((await f.post("/admin/send", { ...ready, text: "reply" })).html, /Result unconfirmed/);
  f.mode.noMessageId = false;
  f.mode.messageId = '<script>fake-user-token</script>';
  ready = await f.prepare();
  await f.post("/admin/send", { ...ready, text: "reply" });
  const result = await f.request("/admin/recipients");
  assert.match(result.html, /&lt;script&gt;\[redacted\]&lt;\/script&gt;/);
  assert.doesNotMatch(result.html, /<script>|fake-user-token/);
});

test("login and send limits are separate and enforce ten attempts per minute", async t => {
  const f = await fixture(t);
  await f.authorize();
  for (let i = 0; i < 10; i++) assert.equal((await f.post("/admin/send", {})).status, 400);
  assert.equal((await f.post("/admin/send", {})).status, 429);
  for (let i = 0; i < 9; i++) assert.equal((await f.request("/admin/login")).status, 302);
  assert.equal((await f.request("/admin/login")).status, 429);
  f.advance(60_000);
  assert.equal((await f.request("/admin/login")).status, 302);
  assert.equal(f.sends().length, 0);
});

test("bounded stores, restart cleanup, signed cookie tampering and allowlist removal", async t => {
  const f = await fixture(t, { storeOptions: { maxStates: 1, maxSessions: 1, maxRecipients: 2, maxRates: 3 } });
  const state = f.store.state();
  assert.equal(f.store.state(), null);
  assert.equal(f.store.consumeState(state), true);
  await f.authorize();
  assert.equal(f.store.createSession({ tokenUntil: Infinity }), null);
  for (const psid of ["606", "607", "608"]) f.observe({ psid });
  assert.equal(f.store.recipients(SANHE_PAGE_ID).length, 2);
  assert.equal(f.store.recipient(SANHE_PAGE_ID, "606"), undefined);
  const fresh = adminStore();
  assert.equal(fresh.recipients(SANHE_PAGE_ID).length, 0);
  fresh.close();
  const raw = f.jar.get("sanhe_admin_session");
  assert.equal((await f.request("/admin/pages", { cookie: `sanhe_admin_session=${raw.slice(0, -1)}z` })).status, 401);
  f.env.ADMIN_FB_USER_IDS = "707";
  assert.equal((await f.request("/admin/pages")).status, 401);
  f.advance(2 * DAY_MS);
  assert.equal(f.store.recipients(SANHE_PAGE_ID).length, 0);
});

test("Graph pagination reconstructs fixed URLs with cursors, never follows paging.next", async () => {
  const calls = [];
  const graph = adminGraph(adminConfig(settings()), { fetchImpl: async (value, options) => {
    const url = new URL(value); calls.push(url);
    assert.equal(options.headers.Authorization, "Bearer synthetic-token");
    return Response.json(calls.length === 1 ? { data: [{ id: "404" }], paging: {
      next: "https://evil.example.test/?access_token=do-not-follow", cursors: { after: "safe-cursor" },
    } } : { data: [{ id: "405" }] });
  } });
  assert.deepEqual(await graph.list("me/businesses", "synthetic-token", "id,name"), [{ id: "404" }, { id: "405" }]);
  assert.equal(calls[1].origin, "https://graph.facebook.com");
  assert.equal(calls[1].searchParams.get("after"), "safe-cursor");
  assert.ok(calls.every(url => !url.searchParams.has("access_token")));
});

test("privacy policy describes admin authorization, memory retention and required session cookies", () => {
  const html = renderPrivacyPage();
  for (const text of ["2026 年 10 月 12 日", "Facebook Login for Business", "HttpOnly", "SameSite=Lax", "48 小時", "最長 2 小時", "不寫入資料庫或日誌"]) assert.ok(html.includes(text));
});
