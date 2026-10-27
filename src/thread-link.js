import { setTimeout as delay } from "node:timers/promises";
import { SANHE_PAGE_ID, GRAPH_VERSION } from "./admin-config.js";
import { setLeadThreadId } from "./supabase.js";
import { logEvent } from "./log-event.js";

export async function fetchThreadId(psid, {
  fetchImpl = globalThis.fetch,
  token = process.env.META_PAGE_ACCESS_TOKEN,
  pageId = SANHE_PAGE_ID,
  graphVersion = GRAPH_VERSION,
} = {}) {
  if (!token || !psid) return { status: "error", code: "configuration" };
  const url = new URL(`https://graph.facebook.com/${graphVersion}/me/conversations`);
  url.search = new URLSearchParams({ platform: "messenger", user_id: psid, fields: "link" }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    });
    const body = await response.json();
    if (body?.error) {
      const code = Number.isInteger(body.error.code) ? body.error.code : "graph_error";
      return { status: [613, 80006].includes(code) ? "rate_limited" : "error", code };
    }
    if (!response.ok) return { status: "error", code: response.status };
    if (!Array.isArray(body?.data)) return { status: "error", code: "invalid_response" };
    if (!body.data.length) return { status: "none" };
    const link = body.data[0]?.link;
    const match = typeof link === "string"
      ? /^(?:https:\/\/(?:www|business)\.facebook\.com)?\/([0-9]+)\/inbox\/([0-9]+)\//.exec(link) : null;
    if (!match || match[1] !== pageId || !/^[0-9]{1,30}$/.test(match[2])) return { status: "none" };
    return { status: "ok", threadId: match[2] };
  } catch {
    return { status: "error", code: controller.signal.aborted ? "timeout" : "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

// Callers detach this promise and catch failures so saving/sending never waits.
export async function attachThreadId(leadId, psid, {
  fetchThread = fetchThreadId,
  setThreadId = setLeadThreadId,
  sleep = ms => delay(ms, undefined, { ref: false }),
  logger = logEvent,
} = {}) {
  let result = await fetchThread(psid);
  if (result.status === "none") {
    logger("thread_link_none");
    await sleep(5000);
    result = await fetchThread(psid);
  }
  if (result.status === "ok") await setThreadId(leadId, result.threadId);
  else logger(result.status === "rate_limited" ? "thread_link_rate_limited"
    : result.status === "none" ? "thread_link_none" : "thread_link_error");
  return result;
}
