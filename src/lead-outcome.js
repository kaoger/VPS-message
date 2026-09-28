import crypto from "node:crypto";
import express from "express";
import { escapeHtml } from "./form-page.js";
import { failureLimiter } from "./security.js";
import { isSupabaseConfigured, readOutcomeToken, recordContactResult } from "./supabase.js";
import { logEvent } from "./log-event.js";

const outcomes = Object.freeze({
  contacted: "已聯絡",
  site_visit: "約丈量",
  not_interested: "沒興趣",
  unreachable: "聯絡不上",
});
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const invalidLimit = failureLimiter({ max: 60 });

function page({ heading, result, fields = "", button = "" }) {
  return `<!doctype html>
<html lang="zh-Hant"><head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <title>${escapeHtml(heading)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;background:#f4f6f8;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans TC",sans-serif;line-height:1.5}
    main{max-width:520px;margin:32px auto;padding:0 16px}.card{background:#fff;border:1px solid #e6e8eb;border-radius:16px;padding:24px;box-shadow:0 6px 20px #0000000a}
    h1{font-size:1.3rem;margin:0 0 18px}p{margin:0 0 20px}button{width:100%;border:0;border-radius:12px;background:#1877f2;color:#fff;padding:13px 20px;font:inherit;font-weight:600;cursor:pointer}
  </style>
</head><body><main><div class="card"><h1>${escapeHtml(heading)}</h1>${result ? `<p>${escapeHtml(result)}</p>` : ""}${button ? `<form method="post" action="/lead/outcome">${fields}<button type="submit">${escapeHtml(button)}</button></form>` : ""}</div></main></body></html>`;
}

const invalidPage = page({ heading: "連結無效或已過期" });
function invalid(req, res, { count = true } = {}) {
  logEvent("lead_outcome_invalid");
  const retryAfter = count ? invalidLimit.recordFailure(req.ip) : 0;
  if (retryAfter) {
    res.set("Retry-After", String(retryAfter));
    return res.status(429).send("操作太頻繁，請稍後再試。");
  }
  return res.status(404).type("html").send(invalidPage);
}

function params(source) {
  const { id, t, r } = source || {};
  if (typeof id !== "string" || !idPattern.test(id) ||
      typeof t !== "string" || !tokenPattern.test(t) ||
      typeof r !== "string" || !Object.hasOwn(outcomes, r)) return null;
  return { id, token: t, result: r };
}

async function verified(input) {
  if (!input || !isSupabaseConfigured()) return null;
  const row = await readOutcomeToken(input.id);
  if (!row || typeof row.outcome_token_hash !== "string" ||
      !hashPattern.test(row.outcome_token_hash) ||
      !Number.isFinite(Date.parse(row.outcome_token_expires_at)) ||
      Date.parse(row.outcome_token_expires_at) <= Date.now()) return null;
  const hash = crypto.createHash("sha256").update(input.token).digest();
  const stored = Buffer.from(row.outcome_token_hash, "hex");
  if (!crypto.timingSafeEqual(hash, stored)) return null;
  return { ...input, hash: row.outcome_token_hash };
}

export const leadOutcomeRouter = express.Router();
leadOutcomeRouter.use((req, res, next) => {
  res.set({ "Content-Security-Policy": "frame-ancestors 'none'", "X-Frame-Options": "DENY" });
  next();
});

leadOutcomeRouter.get("/", async (req, res) => {
  try {
    const input = await verified(params(req.query));
    if (!input) return invalid(req, res);
    const fields = [["id", input.id], ["t", input.token], ["r", input.result]]
      .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("");
    return res.type("html").send(page({
      heading: "確認聯絡結果",
      result: `要記錄的結果：${outcomes[input.result]}`,
      fields,
      button: "確認",
    }));
  } catch { return invalid(req, res); }
});

leadOutcomeRouter.post("/", async (req, res) => {
  let input;
  try {
    input = await verified(params(req.body));
    if (!input) return invalid(req, res);
    const saved = await recordContactResult({
      id: input.id, hash: input.hash, result: input.result, now: new Date().toISOString(),
    });
    if (!saved) return invalid(req, res, { count: false });
    logEvent("lead_outcome_recorded");
    return res.type("html").send(page({ heading: `已記錄：${outcomes[input.result]}` }));
  } catch { return invalid(req, res, { count: !input }); }
});
