import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { backfillThreadLinks } from "../scripts/backfill-thread-links.js";

test("backfill pages beyond a batch without skipping changed rows; reruns select only missing IDs", async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: String(index + 1), messenger_user_id: `private-${index}`, messenger_thread_id: null }));
  const waits = [], cursors = [], writes = [];
  const options = {
    pageSize: 2,
    listLeads: async ({ afterId, limit }) => {
      cursors.push(afterId);
      return rows.filter(row => row.messenger_thread_id === null && (!afterId || row.id > afterId)).slice(0, limit);
    },
    fetchThread: async () => ({ status: "ok", threadId: "123" }),
    setThreadId: async (id, threadId) => { writes.push(id); rows.find(row => row.id === id).messenger_thread_id = threadId; },
    sleep: async ms => waits.push(ms),
  };
  const counts = await backfillThreadLinks(options);
  assert.deepEqual(counts, { processed: 5, success: 5, none: 0, error: 0, errorCodes: {}, rateLimited: false });
  assert.deepEqual(cursors, [null, "2", "4", "5"]);
  assert.deepEqual(waits, [600, 600, 600, 600]);
  assert.deepEqual(writes, ["1", "2", "3", "4", "5"]);
  assert.equal((await backfillThreadLinks(options)).processed, 0);
});

for (const code of [613, 80006]) {
  test(`backfill stops immediately on rate limit ${code} and records the exact processed count`, async () => {
    let calls = 0, writes = 0;
    const waits = [];
    const counts = await backfillThreadLinks({
      listLeads: async () => [1, 2, 3, 4].map(id => ({ id, messenger_user_id: "private" })),
      fetchThread: async () => ++calls === 2 ? { status: "rate_limited", code } : { status: "ok", threadId: "123" },
      setThreadId: async () => { writes++; }, sleep: async ms => waits.push(ms),
    });
    assert.deepEqual(counts, { processed: 2, success: 1, none: 0, error: 1, errorCodes: { [code]: 1 }, rateLimited: true });
    assert.equal(calls, 2);
    assert.equal(writes, 1);
    assert.deepEqual(waits, [600]);
  });
}

test("backfill counts none, numeric errors and thrown failures without leaking messages", async () => {
  const results = [{ status: "none" }, { status: "error", code: 190 },
    { status: "error", code: "private-token" }, { status: "ok", threadId: "123" }, null];
  let batch = 0, index = 0;
  const counts = await backfillThreadLinks({
    listLeads: async () => batch++ ? [] : results.map((_, id) => ({ id, messenger_user_id: "private-psid" })),
    fetchThread: async () => { const result = results[index++]; if (!result) throw new Error("private-token"); return result; },
    setThreadId: async () => { throw new Error("private-db-message"); }, sleep: async () => {},
  });
  assert.deepEqual(counts, { processed: 5, success: 0, none: 1, error: 4,
    errorCodes: { 190: 1, unknown: 1, write_failed: 1, request_failed: 1 }, rateLimited: false });
  assert.doesNotMatch(JSON.stringify(counts), /private/);
});

test("listing failure is summarized without propagating a private database error", async () => {
  const counts = await backfillThreadLinks({ listLeads: async () => { throw new Error("private-db-key"); } });
  assert.deepEqual(counts, { processed: 0, success: 0, none: 0, error: 1, errorCodes: { list_failed: 1 }, rateLimited: false });
});

test("CLI without exported credentials prints only counters and does not load local dotenv", () => {
  let result;
  try {
    execFileSync(process.execPath, ["scripts/backfill-thread-links.js"], {
      cwd: new URL("../", import.meta.url), encoding: "utf8",
      env: { ...process.env, SUPABASE_URL: "", SUPABASE_SECRET_KEY: "", SUPABASE_SERVICE_ROLE_KEY: "", NODE_OPTIONS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.fail("Missing credentials must produce a nonzero exit code");
  } catch (error) {
    assert.equal(error.status, 1);
    assert.equal(error.stderr, "");
    result = JSON.parse(error.stdout);
  }
  assert.equal(result.processed, 0);
  assert.deepEqual(result.errorCodes, { list_failed: 1 });
});
