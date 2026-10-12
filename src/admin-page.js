import { randomId } from "./admin-store.js";

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

export function adminPage(res, { title = "Sanhe Messenger Admin", body, session, currentStep = 1, secrets = [], referrerPolicy = "same-origin" }) {
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
*{box-sizing:border-box}body{margin:0;background:#f5f4f0;color:#20332f;font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}a{color:#245c52;text-underline-offset:3px}a:hover{color:#163d35}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #b4772d;outline-offset:3px}
.brand-bar{background:#fff;border-bottom:1px solid #dfE4df}.brand-inner{max-width:1040px;margin:auto;padding:22px 32px;display:flex;align-items:center;justify-content:space-between;gap:24px}.brand{font-weight:650;letter-spacing:.02em;text-decoration:none}.logout{flex:0 0 200px;text-align:right}.logout .hint{margin:6px 0 0;font-size:12px}.logout button{background:#fff;border:1px solid #ccd8d2;color:#245c52;padding:7px 16px}
main{max-width:976px;margin:32px auto;padding:32px;background:white;border:1px solid #e0e5df;border-radius:16px;box-shadow:0 8px 30px #20332f06}h1{font-size:30px;line-height:1.25;letter-spacing:-.025em;margin:0 0 20px}h2{font-size:20px;margin:0 0 12px}h3{font-size:16px;margin:16px 0 8px}p{margin:0 0 16px}.eyebrow{color:#63736c;font-size:12px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;margin:0 0 10px}
.steps{margin-bottom:32px}.steps ol{list-style:none;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:0;padding:0}.steps li{min-width:0}.step{display:block;height:100%;padding:12px;border:1px solid #e1e6e1;border-radius:10px;background:#f7f8f6;text-decoration:none;color:#596960}.step-label{display:block;font-size:14px;font-weight:650}.step-state{display:block;font-size:12px;margin-top:4px}.step.complete{background:#eef6f0;border-color:#c9dfcf;color:#27603c}.step[aria-current="step"]{background:#245c52;border-color:#245c52;color:white}.step:hover{border-color:#245c52}.step[aria-disabled="true"]{color:#737b76}
section,.card{border:1px solid #e1e6e1;padding:24px;margin:20px 0;border-radius:12px}.asset-name{font-size:18px;font-weight:600;margin-bottom:6px}.asset-id{font-size:13px;color:#63736c}.badge{display:inline-block;border:1px solid #c9dfcf;background:#eef6f0;color:#27603c;padding:3px 9px;border-radius:20px;font-size:12px;font-weight:650}.notice{padding:18px 20px;border:1px solid #d5e2e8;border-left:4px solid #547984;border-radius:10px;background:#f1f6f8;margin:0 0 24px}.notice p:last-child{margin-bottom:0}.notice-title{display:block;font-weight:650;margin-bottom:4px}.notice.success{background:#eff8f0;border-color:#c4dec9;border-left-color:#34824b;color:#285d38}.notice.warning{background:#fff8e9;border-color:#ead8af;border-left-color:#ae7a26;color:#78551d}.muted,.hint{color:#63736c}.hint{font-size:13px;line-height:1.5;margin:8px 0 0}
form{margin:20px 0}button,.button{display:inline-block;background:#245c52;color:white;padding:11px 20px;border:1px solid #245c52;border-radius:8px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;text-align:center}button:hover,.button:hover{background:#1b473f;color:white}button:disabled{background:#737d78;border-color:#737d78;cursor:not-allowed}input,textarea,select{font:inherit;max-width:100%;min-width:0;padding:10px 12px;border:1px solid #bbc9c1;border-radius:8px;background:#fff;color:#20332f}select,textarea{display:block;width:100%;margin-top:8px}textarea{min-height:120px;resize:vertical}input[type="radio"]{accent-color:#245c52;margin-right:8px}label{display:block;margin:0 0 20px}.page-choice{padding:16px;background:#f7f8f6;border:1px solid #e1e6e1;border-radius:8px}table{width:100%;table-layout:fixed;border-spacing:0;border:1px solid #e1e6e1;border-radius:10px;overflow:hidden;margin:20px 0;font-size:14px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #e1e6e1;vertical-align:top;overflow-wrap:anywhere}th{background:#f7f8f6;font-weight:650}tbody tr:last-child td{border-bottom:0}time,code{overflow-wrap:anywhere}.next{margin:24px 0 0}.footer{border-top:1px solid #e1e6e1;margin:32px 0 0;padding-top:20px;font-size:12px}.logout form{margin:0}
@media(max-width:600px){.brand-inner{padding:16px;gap:16px;align-items:flex-start}.brand{font-size:13px;max-width:190px}.logout{flex-basis:105px}.logout button{font-size:13px;padding:6px 12px}.logout .hint{font-size:11px}main{margin:16px 12px;padding:20px 16px;border-radius:12px}h1{font-size:25px}.steps{margin-bottom:24px}.steps ol{grid-template-columns:repeat(2,minmax(0,1fr))}.step{padding:10px}.step-label{font-size:13px}.notice,section,.card{padding:16px}th,td{padding:10px 8px;font-size:12px}select{font-size:14px}.asset-name{font-size:16px}}
</style></head><body><header class="brand-bar"><div class="brand-inner"><a class="brand" href="/admin">Sanhe Interior Design · Messenger Admin</a>${session ? `<div class="logout"><form method="post" action="/admin/logout">${csrfField(e, session)}<button title="End this admin session" aria-describedby="logout-help">Log out</button><p class="hint" id="logout-help">End this admin session.</p></form></div>` : ""}</div></header><main>${adminNav(e, session, currentStep)}<p class="eyebrow">${session ? "Page management" : "Authorized administrators"}</p><h1>${e(title)}</h1>${body(e)}
<p class="muted footer"><a href="/privacy">Privacy policy</a> · Restricted to authorized Page administrators.</p></main></body></html>`);
}

export const hidden = (e, name, value) => `<input type="hidden" name="${e(name)}" value="${e(value)}">`;
export const csrfField = (e, session) => hidden(e, "csrf", session.csrf);
export function adminNav(e, session, currentStep = 1) {
  const steps = [["Business", "businesses"], ["Page", "pages"], ["Webhook", "subscription"], ["Send", "recipients"]];
  return `<nav class="steps" aria-label="Admin setup progress"><ol>${steps.map(([label, route], index) => {
    const step = index + 1;
    const complete = step === 1 ? Boolean(session) : step === 2 ? Boolean(session?.page) : step === 3 ? session?.subscriptionConfirmed === true : false;
    const available = Boolean(session) && (step < 3 || Boolean(session.page));
    const current = currentStep === step;
    const content = `<span class="step-label">Step ${e(step)} ${e(label)}</span><span class="step-state">${complete ? "Completed" : current ? (session ? "Current step" : "Sign in to start") : available ? "Available" : "Pending"}</span>`;
    const attributes = `class="step${complete ? " complete" : ""}"${current ? ' aria-current="step"' : ""}`;
    return `<li>${available ? `<a ${attributes} href="/admin/${e(route)}">${content}</a>` : `<span ${attributes} aria-disabled="true">${content}</span>`}</li>`;
  }).join("")}</ol></nav>`;
}
