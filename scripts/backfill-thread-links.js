import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fetchThreadId } from "../src/thread-link.js";
import { listLeadsWithoutThreadId, setLeadThreadId } from "../src/supabase.js";

// Uses container environment only; deliberately does not load a local .env file.
export async function backfillThreadLinks({
  listLeads = listLeadsWithoutThreadId, fetchThread = fetchThreadId,
  setThreadId = setLeadThreadId, sleep = delay, pageSize = 100,
} = {}) {
  const counts = { processed: 0, success: 0, none: 0, error: 0, errorCodes: {}, rateLimited: false };
  const recordError = code => {
    // Never echo arbitrary Graph/DB messages, PSIDs or credentials.
    const safeCode = Number.isInteger(code) ? String(code)
      : ["timeout", "configuration", "request_failed", "invalid_response", "graph_error", "write_failed", "list_failed"].includes(code) ? code : "unknown";
    counts.error++;
    counts.errorCodes[safeCode] = (counts.errorCodes[safeCode] || 0) + 1;
  };
  let afterId = null;
  for (;;) {
    let rows;
    try { rows = await listLeads({ afterId, limit: pageSize }); }
    catch { recordError("list_failed"); return counts; }
    if (!rows.length) return counts;
    for (const row of rows) {
      if (counts.processed) await sleep(600);
      counts.processed++;
      let result;
      try { result = await fetchThread(row.messenger_user_id); }
      catch { result = { status: "error", code: "request_failed" }; }
      if (result.status === "rate_limited") {
        recordError(result.code);
        counts.rateLimited = true;
        return counts;
      }
      if (result.status === "ok") {
        try { await setThreadId(row.id, result.threadId); counts.success++; }
        catch { recordError("write_failed"); }
      } else if (result.status === "none") counts.none++;
      else recordError(result.code);
    }
    afterId = rows.at(-1).id;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const counts = await backfillThreadLinks();
  console.log(JSON.stringify(counts));
  if (counts.rateLimited) console.log(`已處理到第 ${counts.processed} 筆`);
  if (counts.error) process.exitCode = 1;
}
