import { test } from "node:test";
import assert from "node:assert/strict";
import { SANHE_PAGE_ID } from "../src/admin-config.js";

process.env.DOTENV_CONFIG_PATH = "test/nonexistent.env";
Object.assign(process.env, {
  NODE_ENV: "production", PORT: "3000", DEMO_MODE: "webform", QUESTIONS_PATH: "",
  META_APP_SECRET: "synthetic-app-secret", META_VERIFY_TOKEN: "synthetic-verify",
  META_PAGE_ACCESS_TOKEN: "synthetic-page-token", FORM_TOKEN_SECRET: "x".repeat(32),
  PUBLIC_BASE_URL: "https://example.test", SUPABASE_URL: "https://thread-hooks.example.test",
  SUPABASE_SECRET_KEY: "synthetic-store-key", SUPABASE_SERVICE_ROLE_KEY: "", LOG_PATH: "",
  ADMIN_FB_USER_IDS: "", TRUST_LOCAL_PROXY: "false",
});

test("thread hooks preserve form and chat completion under background failures", { timeout: 10000 }, async t => {
  const realFetch = globalThis.fetch, realLog = console.log;
  const rows = new Map(), logs = [], messages = [], graphCalls = [], threadWrites = [];
  let graph = async () => Response.json({ data: [{ link: `/${SANHE_PAGE_ID}/inbox/123/` }] });
  let failInsert = false, failThreadWrite = false, server;
  console.log = (...args) => logs.push(args);
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (url.origin === "https://graph.facebook.com") {
      if (url.pathname.endsWith("/conversations")) {
        graphCalls.push(url.searchParams.get("user_id"));
        return graph(options.signal);
      }
      assert.equal(url.pathname, "/v23.0/me/messages");
      messages.push(JSON.parse(options.body));
      return Response.json({});
    }
    assert.equal(url.origin, "https://thread-hooks.example.test", "External requests must stay in the fake store");
    assert.equal(url.pathname, "/rest/v1/customer_leads");
    if (options.method === "POST") {
      if (failInsert) return Response.json({ message: "private insert error" }, { status: 500 });
      const row = { ...JSON.parse(options.body), id: String(rows.size + 1), messenger_thread_id: null };
      rows.set(row.id, row);
      return Response.json({ id: row.id }, { status: 201 });
    }
    const params = url.searchParams;
    const id = params.get("id")?.slice(3);
    const sender = params.get("messenger_user_id")?.slice(3);
    const matches = [...rows.values()].filter(row => (!id || row.id === id) && (!sender || row.messenger_user_id === sender));
    if (options.method === "GET") return Response.json(matches.at(-1) || null);
    assert.equal(options.method, "PATCH");
    const changes = JSON.parse(options.body);
    if ("messenger_thread_id" in changes) {
      threadWrites.push({ id, changes, filter: params.get("messenger_thread_id") });
      assert.deepEqual(Object.keys(changes), ["messenger_thread_id"]);
      if (failThreadWrite) return Response.json({ message: "private write error" }, { status: 500 });
      const row = rows.get(id);
      if (row?.messenger_thread_id === null) Object.assign(row, changes);
      return new Response(null, { status: 204 });
    }
    const row = matches.find(row => params.get("answers") === `eq.${JSON.stringify(row.answers)}`);
    if (!row) return Response.json(null);
    Object.assign(row, changes);
    return Response.json({ id: row.id });
  };
  t.after(async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    globalThis.fetch = realFetch;
    console.log = realLog;
  });
  const { app, handleIncoming } = await import("../src/server.js");
  const { signFormToken } = await import("../src/form-token.js");
  const { editToken } = await import("../src/lead-edit.js");
  const { saveSession, createSession } = await import("../src/session-store.js");
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const answers = { service: "新成屋裝潢", area: "高雄市", size: "20 坪以下", timeline: "一個月內", budget: "50 萬以下", name: "假姓名", phone: "0912345678", contact_time: "上午 8–12 點" };
  const submit = async (token, values = answers) => {
    const response = await realFetch(`${base}/form/submit`, { method: "POST", body: new URLSearchParams({ token, ...values }) });
    return { status: response.status, html: await response.text() };
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const waitFor = async predicate => {
    for (let index = 0; index < 50 && !predicate(); index++) await settle();
    assert.ok(predicate(), "Background work must settle");
  };

  await t.test("form returns success and all Messenger messages while the thread request is pending", async () => {
    let resolveGraph;
    graph = () => new Promise(resolve => { resolveGraph = resolve; });
    const result = await submit(signFormToken("101"));
    assert.equal(result.status, 200);
    assert.match(result.html, /需求已送出/);
    assert.deepEqual(graphCalls, ["101"]);
    assert.equal(threadWrites.length, 0);
    assert.equal(messages.filter(message => message.recipient.id === "101").length, 3);
    resolveGraph(Response.json({ error: { code: 190, message: "private-token-psid-thread" } }, { status: 400 }));
    await waitFor(() => logs.some(args => args[0] === "thread_link_error"));
  });

  await t.test("successful form insert attaches the ID and later edit rechecks without overwriting it", async () => {
    graph = async () => Response.json({ data: [{ link: `/${SANHE_PAGE_ID}/inbox/123/` }] });
    assert.equal((await submit(signFormToken("102"))).status, 200);
    const row = [...rows.values()].find(row => row.messenger_user_id === "102");
    await waitFor(() => row.messenger_thread_id === "123");
    const beforeCalls = graphCalls.length;
    graph = async () => Response.json({ data: [{ link: `/${SANHE_PAGE_ID}/inbox/456/` }] });
    const token = editToken("102", { ...row, storage: "db" });
    const result = await submit(token, { ...answers, phone: "0999999999" });
    assert.equal(result.status, 200);
    assert.match(result.html, /需求已更新/);
    await waitFor(() => graphCalls.length === beforeCalls + 1);
    await settle();
    assert.equal(row.phone, "0999999999");
    assert.equal(row.messenger_thread_id, "123");
    assert.ok(threadWrites.every(write => write.filter === "is.null"));
    const beforeStale = graphCalls.length;
    assert.equal((await submit(token)).status, 409);
    assert.equal(graphCalls.length, beforeStale);
  });

  await t.test("successful edit fills an originally missing thread ID", async () => {
    const row = [...rows.values()].find(row => row.messenger_user_id === "101");
    assert.equal(row.messenger_thread_id, null);
    const token = editToken("101", { ...row, storage: "db" });
    assert.equal((await submit(token)).status, 200);
    await waitFor(() => row.messenger_thread_id === "456");
  });

  await t.test("a failed background PATCH cannot change form success or leak private errors", async () => {
    failThreadWrite = true;
    const beforeLogs = logs.filter(args => args[0] === "thread_link_error").length;
    const result = await submit(signFormToken("103"));
    assert.equal(result.status, 200);
    assert.match(result.html, /需求已送出/);
    await waitFor(() => logs.filter(args => args[0] === "thread_link_error").length > beforeLogs);
    assert.equal([...rows.values()].find(row => row.messenger_user_id === "103").messenger_thread_id, null);
    failThreadWrite = false;
  });

  await t.test("chat confirmation triggers attachment without awaiting the request", async () => {
    let resolveGraph;
    graph = () => new Promise(resolve => { resolveGraph = resolve; });
    saveSession("104", { ...createSession(), answers, awaitingConfirm: true });
    const sent = [];
    const beforeCalls = graphCalls.length;
    await handleIncoming("104", { text: "確認送出" }, { text: async (_id, text) => sent.push(text) });
    assert.equal(graphCalls.length, beforeCalls + 1);
    assert.equal(graphCalls.at(-1), "104");
    assert.match(sent.at(-1), /感謝/);
    const row = [...rows.values()].find(row => row.messenger_user_id === "104");
    assert.equal(row.messenger_thread_id, null);
    resolveGraph(Response.json({ data: [{ link: `/${SANHE_PAGE_ID}/inbox/789/` }] }));
    await waitFor(() => row.messenger_thread_id === "789");
  });

  await t.test("invalid submissions and failed inserts never query threads", async () => {
    const before = graphCalls.length;
    assert.equal((await submit(signFormToken("105"), {})).status, 400);
    failInsert = true;
    assert.equal((await submit(signFormToken("105"))).status, 503);
    saveSession("106", { ...createSession(), answers, awaitingConfirm: true });
    const sent = [];
    await handleIncoming("106", { text: "確認送出" }, { text: async (_id, text) => sent.push(text) });
    assert.match(sent.at(-1), /送出時發生問題/);
    failInsert = false;
    assert.equal(graphCalls.length, before);
  });

  await t.test("without DB credentials, memory form, edit and chat all skip attachment", async () => {
    process.env.SUPABASE_SECRET_KEY = "";
    const before = graphCalls.length, beforeRows = rows.size;
    assert.equal((await submit(signFormToken("107"))).status, 200);
    const editMessage = messages.filter(message => message.recipient.id === "107" &&
      message.message.attachment?.payload.buttons[0].title === "修改需求").at(-1);
    const token = new URL(editMessage.message.attachment.payload.buttons[0].url).searchParams.get("t");
    assert.equal((await submit(token)).status, 200);
    saveSession("108", { ...createSession(), answers, awaitingConfirm: true });
    const sent = [];
    await handleIncoming("108", { text: "確認送出" }, { text: async (_id, text) => sent.push(text) });
    assert.match(sent.at(-1), /感謝/);
    assert.equal(graphCalls.length, before);
    assert.equal(rows.size, beforeRows);
    process.env.SUPABASE_SECRET_KEY = "synthetic-store-key";
  });

  const threadLogs = logs.filter(args => args[0].startsWith("thread_link_"));
  assert.ok(threadLogs.every(args => args.length === 1 && ["thread_link_none", "thread_link_error", "thread_link_rate_limited"].includes(args[0])));
  assert.doesNotMatch(JSON.stringify(logs), /private-token-psid-thread|private write error|synthetic-page-token|synthetic-store-key/);
});
