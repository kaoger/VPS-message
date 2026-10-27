import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchThreadId, attachThreadId } from "../src/thread-link.js";
import { SANHE_PAGE_ID } from "../src/admin-config.js";
import { setLeadThreadId, listLeadsWithoutThreadId } from "../src/supabase.js";

const token = "synthetic-thread-token";
const threadId = "123456789012345678901234567890";
const path = `/${SANHE_PAGE_ID}/inbox/${threadId}/`;
const responseFor = link => Response.json({ data: [{ link }] });
const fetchOptions = fetchImpl => ({ token, fetchImpl });

for (const link of [path, `${path}?section=messages&extra=1`, `https://www.facebook.com${path}`,
  `https://business.facebook.com${path}?section=messages`]) {
  test(`thread parser accepts official path shape ${link}`, async () => {
    const result = await fetchThreadId("123", fetchOptions(async (url, options) => {
      assert.equal(url.origin, "https://graph.facebook.com");
      assert.equal(url.pathname, "/v23.0/me/conversations");
      assert.deepEqual(Object.fromEntries(url.searchParams), { platform: "messenger", user_id: "123", fields: "link" });
      assert.equal(options.headers.Authorization, `Bearer ${token}`);
      assert.ok(options.signal instanceof AbortSignal);
      assert.ok(!String(url).includes(token));
      return responseFor(link);
    }));
    assert.deepEqual(result, { status: "ok", threadId });
  });
}

for (const link of ["/999/inbox/123/", `https://evil.test${path}`, `http://www.facebook.com${path}`,
  `https://www.facebook.com.evil.test${path}`, `/${SANHE_PAGE_ID}/inbox/t_123/`,
  `/${SANHE_PAGE_ID}/inbox/${"1".repeat(31)}/`, undefined]) {
  test(`thread parser rejects mismatched page or invalid link ${link}`, async () => {
    assert.deepEqual(await fetchThreadId("123", fetchOptions(async () => responseFor(link))), { status: "none" });
  });
}

test("empty data is none and only the first link is considered", async () => {
  assert.deepEqual(await fetchThreadId("123", fetchOptions(async () => Response.json({ data: [] }))), { status: "none" });
  assert.deepEqual(await fetchThreadId("123", fetchOptions(async () => Response.json({
    data: [{ link: "/999/inbox/123/" }, { link: path }],
  }))), { status: "none" });
});

for (const code of [613, 80006, 190]) {
  test(`Graph error ${code} is classified without exposing the error message`, async () => {
    assert.deepEqual(await fetchThreadId("123", fetchOptions(async () => Response.json({
      error: { code, message: `private PSID and ${token}` },
    }, { status: 400 }))), { status: code === 190 ? "error" : "rate_limited", code });
  });
}

test("request, HTTP, JSON and response-shape failures return safe error codes", async () => {
  for (const [fetchImpl, code] of [
    [async () => { throw new Error(`private ${token}`); }, "request_failed"],
    [async () => Response.json({}, { status: 503 }), 503],
    [async () => new Response("not json"), "request_failed"],
    [async () => Response.json({ data: null }), "invalid_response"],
    [async () => Response.json({ error: { code: token } }), "graph_error"],
  ]) assert.deepEqual(await fetchThreadId("123", fetchOptions(fetchImpl)), { status: "error", code });
  assert.deepEqual(await fetchThreadId("123", { token: "" }), { status: "error", code: "configuration" });
});

test("five-second deadline aborts a pending request", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const pending = fetchThreadId("123", fetchOptions(async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  }));
  t.mock.timers.tick(4999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { status: "error", code: "timeout" });
});

test("explicit graph version and page ID are injectable without admin configuration", async () => {
  const result = await fetchThreadId("psid&fields=private", {
    token, pageId: "42", graphVersion: "v99.0",
    fetchImpl: async url => {
      assert.equal(url.pathname, "/v99.0/me/conversations");
      assert.equal(url.searchParams.get("user_id"), "psid&fields=private");
      assert.equal(url.searchParams.get("fields"), "link");
      return responseFor("/42/inbox/123/");
    },
  });
  assert.deepEqual(result, { status: "ok", threadId: "123" });
});

test("attachment retries none once after exactly five seconds and stores only a successful ID", async () => {
  const events = [], writes = [], waits = [];
  let calls = 0;
  assert.deepEqual(await attachThreadId("lead", "psid", {
    fetchThread: async psid => {
      assert.equal(psid, "psid");
      return ++calls === 1 ? { status: "none" } : { status: "ok", threadId };
    },
    setThreadId: async (...args) => writes.push(args), sleep: async ms => waits.push(ms),
    logger: (...args) => events.push(args),
  }), { status: "ok", threadId });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [5000]);
  assert.deepEqual(writes, [["lead", threadId]]);
  assert.deepEqual(events, [["thread_link_none"]]);
});

for (const status of ["none", "error", "rate_limited"]) {
  test(`attachment gives up safely for ${status}`, async () => {
    let calls = 0, sleeps = 0;
    const logs = [];
    await attachThreadId("private-lead", "private-psid", {
      fetchThread: async () => { calls++; return { status, code: 613 }; },
      setThreadId: async () => assert.fail("Must not write without a thread ID"),
      sleep: async ms => { assert.equal(ms, 5000); sleeps++; },
      logger: (...args) => logs.push(args),
    });
    assert.equal(calls, status === "none" ? 2 : 1);
    assert.equal(sleeps, status === "none" ? 1 : 0);
    assert.ok(logs.every(args => args.length === 1 && args[0] === `thread_link_${status}`));
  });
}

test("thread writes are atomic, fill null only and never change workflow columns", async t => {
  process.env.SUPABASE_URL = "https://thread-store.example.test";
  process.env.SUPABASE_SECRET_KEY = "synthetic-store-key";
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const rows = new Map([["a", { messenger_thread_id: null, notification_status: "sent", answers: { name: "private" } }],
    ["b", { messenger_thread_id: "999" }], ["c", { messenger_thread_id: "" }]]);
  const before = structuredClone([...rows]);
  let fail = false;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://thread-store.example.test");
    assert.equal(options.method, "PATCH");
    assert.equal(url.searchParams.get("messenger_thread_id"), "is.null");
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body), ["messenger_thread_id"]);
    const row = rows.get(url.searchParams.get("id").slice(3));
    if (fail) return Response.json({ message: "private failure" }, { status: 500 });
    if (row?.messenger_thread_id === null) Object.assign(row, body);
    return new Response(null, { status: 204 });
  };
  await Promise.all([setLeadThreadId("a", "123"), setLeadThreadId("a", "456")]);
  assert.equal(rows.get("a").messenger_thread_id, "123");
  for (const id of ["b", "c", "missing"]) await setLeadThreadId(id, "456");
  assert.deepEqual(rows.get("b"), before[1][1]);
  assert.deepEqual(rows.get("c"), before[2][1]);
  assert.deepEqual(rows.get("a"), { ...before[0][1], messenger_thread_id: "123" });
  for (const bad of ["", "1/../x", "1".repeat(31), 123]) await assert.rejects(setLeadThreadId("a", bad), /Invalid thread ID/);
  fail = true;
  await assert.rejects(setLeadThreadId("a", "789"));
});

test("backfill store query filters missing IDs and supports stable keyset pagination", async t => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  let fail = false;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://thread-store.example.test");
    assert.equal(url.searchParams.get("select"), "id,messenger_user_id");
    assert.deepEqual(url.searchParams.getAll("messenger_user_id"), ["not.is.null", "neq."]);
    assert.equal(url.searchParams.get("messenger_thread_id"), "is.null");
    assert.equal(url.searchParams.get("order"), "id.asc");
    assert.equal(url.searchParams.get("limit"), "2");
    assert.equal(url.searchParams.get("id"), "gt.previous");
    return Response.json(fail ? { message: "private failure" } : [{ id: "next", messenger_user_id: "123" }], { status: fail ? 500 : 200 });
  };
  assert.deepEqual(await listLeadsWithoutThreadId({ afterId: "previous", limit: 2 }), [{ id: "next", messenger_user_id: "123" }]);
  fail = true;
  await assert.rejects(listLeadsWithoutThreadId({ afterId: "previous", limit: 2 }));
});
