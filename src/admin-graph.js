import crypto from "node:crypto";
import { GRAPH_VERSION } from "./admin-config.js";

export class AdminGraphError extends Error {
  constructor(code = null, uncertain = false) {
    super("Meta request failed");
    this.code = Number.isSafeInteger(code) && code >= 0 ? code : null;
    this.uncertain = uncertain;
  }
}

export function adminGraph(config, { fetchImpl = (...args) => fetch(...args), timeoutMs = 10_000 } = {}) {
  async function request(path, { token, method = "GET", params = {}, body, form = false } = {}) {
    const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`);
    const headers = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      params = { ...params, appsecret_proof: crypto.createHmac("sha256", config.appSecret).update(token).digest("hex") };
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (body) headers["content-type"] = form ? "application/x-www-form-urlencoded" : "application/json";
    const controller = new AbortController();
    let timer;
    try {
      const work = (async () => {
        const response = await fetchImpl(url, { method, headers,
          body: body ? (form ? new URLSearchParams(body).toString() : JSON.stringify(body)) : undefined,
          signal: controller.signal, redirect: "error" });
        const result = await response.json();
        if (!response.ok || result?.error) throw new AdminGraphError(result?.error?.code);
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new AdminGraphError(null, true);
        return result;
      })();
      // Race also bounds injected fetch implementations that do not honor AbortSignal.
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new AdminGraphError(null, true)); }, timeoutMs);
      });
      return await Promise.race([work, timeout]);
    } catch (error) {
      if (error instanceof AdminGraphError) throw error;
      throw new AdminGraphError(null, true);
    } finally { clearTimeout(timer); }
  }
  return {
    // No access token exists yet: code exchange is the appsecret_proof exception.
    exchange: code => request("oauth/access_token", { method: "POST", form: true, body: {
      client_id: config.appId, client_secret: config.appSecret, redirect_uri: config.callback, code,
    } }),
    get: (path, token, params) => request(path, { token, params }),
    post: (path, token, body) => request(path, { token, method: "POST", body }),
    postForm: (path, token, body) => request(path, { token, method: "POST", body, form: true }),
    async list(path, token, fields) {
      const rows = [];
      const cursors = new Set();
      let after;
      // Never follow paging.next, including URLs supplied by upstream errors.
      for (let page = 0; page < 10; page++) {
        const result = await request(path, { token, params: { fields, limit: "100", ...(after ? { after } : {}) } });
        if (!Array.isArray(result.data)) throw new AdminGraphError();
        rows.push(...result.data);
        if (rows.length > 1000) throw new AdminGraphError();
        const cursor = result.paging?.cursors?.after;
        if (!result.paging?.next) return rows;
        if (typeof cursor !== "string" || cursor.length > 2048 || cursors.has(cursor)) throw new AdminGraphError();
        cursors.add(cursor);
        after = cursor;
      }
      throw new AdminGraphError();
    },
  };
}
