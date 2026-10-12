import { randomId } from "./admin-store.js";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

export function adminPage(res, { title = "Sanhe Messenger Admin", body, secrets = [], referrerPolicy = "same-origin" }) {
  const e = value => {
    let safe = String(value ?? "");
    for (const secret of secrets.filter(Boolean)) safe = safe.split(secret).join("[redacted]");
    return escapeHtml(safe);
  };
  const nonce = randomId();
  res.set({
    "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    // no-referrer makes browser form POSTs send Origin: null. Keep same-origin
    // forms verifiable while suppressing referrers to Facebook and other sites.
    "X-Frame-Options": "DENY", "Referrer-Policy": referrerPolicy, "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  return res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title><style nonce="${nonce}">
body{margin:0;background:#f4f6f8;color:#182331;font:16px/1.6 system-ui,sans-serif}main{max-width:900px;margin:32px auto;padding:24px;background:white;border-radius:12px}h1{font-size:26px}h2{font-size:21px}a{color:#075bc1}nav{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}section{border-top:1px solid #ddd;padding:16px 0}button,.button{display:inline-block;background:#075bc1;color:white;padding:10px 16px;border:0;border-radius:6px;font:inherit;cursor:pointer;text-decoration:none}button:disabled{background:#687382;cursor:not-allowed}input,textarea,select{font:inherit;max-width:100%;box-sizing:border-box;padding:8px}textarea{display:block;width:100%;min-height:100px}label{display:block;margin:12px 0}.notice{background:#eef4fd;padding:16px;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px;border-bottom:1px solid #ddd;overflow-wrap:anywhere}.muted{color:#526071}code{overflow-wrap:anywhere}
</style></head><body><main><h1>${e(title)}</h1>${body(e)}
<p class="muted"><a href="/privacy">Privacy policy</a> · Restricted to authorized Page administrators.</p></main></body></html>`);
}

export const hidden = (e, name, value) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
export const csrfField = (e, session) => hidden(e, "csrf", session.csrf);
export const adminNav = (e, session) => `<nav><a href="/admin/businesses">Step 1 Business</a><a href="/admin/pages">Step 2 Page</a><a href="/admin/subscription">Step 3 Webhook</a><a href="/admin/recipients">Step 4 Send</a></nav><form method="post" action="/admin/logout">${csrfField(e, session)}<button>Log out</button></form>`;
