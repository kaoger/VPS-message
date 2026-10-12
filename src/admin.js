import express from "express";
import { adminConfig, ADMIN_SCOPES, GRAPH_VERSION } from "./admin-config.js";
import { adminGraph, AdminGraphError } from "./admin-graph.js";
import { adminStore, randomId, signedId, cookieId, equalToken } from "./admin-store.js";
import { adminPage, adminNav, csrfField, hidden } from "./admin-page.js";
import { logEvent } from "./log-event.js";

const SESSION_COOKIE = "sanhe_admin_session", STATE_COOKIE = "sanhe_admin_state";
const cookieOptions = { httpOnly: true, secure: true, sameSite: "lax", path: "/admin" };
const scalar = (value, max = 2048) => typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
const asset = row => typeof row?.id === "string" && /^\d+$/.test(row.id) ?
  { id: row.id, name: typeof row.name === "string" ? row.name.slice(0, 256) : "Unnamed asset" } : null;

export function createAdmin({ env = process.env, store = adminStore(), fetchImpl, timeoutMs } = {}) {
  const router = express.Router();
  // One supported Page, one process: serialize writes across all admin sessions.
  let subscriptionBusy = false;
  function render(req, res, title, body) {
    const config = req.adminConfig;
    const session = req.adminSession;
    return adminPage(res, { title, body, referrerPolicy: req.path === "/callback" ? "no-referrer" : "same-origin",
      secrets: [config?.appSecret, config?.sessionSecret,
      session?.userToken, session?.availablePage?.token, session?.page?.token] });
  }
  const notice = (req, res, status, text) => {
    res.status(status);
    return render(req, res, "Sanhe Messenger Admin", e => `<p class="notice">${e(text)}</p><p><a href="/admin">Return to admin</a></p>`);
  };
  function clearSession(req, res) {
    store.removeSession(req.adminSessionId);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
  }
  function activeSession(req, res) {
    if (store.session(req.adminSessionId, false) !== req.adminSession) {
      clearSession(req, res);
      notice(req, res, 401, "Please sign in. Your session may have expired.");
      return false;
    }
    return true;
  }
  function requirePage(req, res) {
    if (req.adminSession.page?.id !== req.adminConfig.pageId || !req.adminSession.page?.token) {
      notice(req, res, 403, "Select the supported Page first.");
      return false;
    }
    return true;
  }
  async function account(graph, config, token) {
    const rows = await graph.list("me/accounts", token, "id,name,tasks,access_token");
    const page = rows.find(row => row?.id === config.pageId);
    const availablePage = page && Array.isArray(page.tasks) && page.tasks.includes("MESSAGING") && scalar(page.access_token, 8192)
      ? { ...asset(page), token: page.access_token } : null;
    return { pages: rows.map(asset).filter(Boolean), availablePage };
  }
  async function refreshWriteAuthorization(req, res) {
    const session = req.adminSession;
    try {
      const accounts = await account(req.adminGraph, req.adminConfig, session.userToken);
      const grants = await req.adminGraph.list("me/permissions", session.userToken, "permission,status");
      if (!accounts.availablePage || !ADMIN_SCOPES.every(permission =>
        grants.some(grant => grant?.permission === permission && grant.status === "granted"))) throw new AdminGraphError();
      if (!activeSession(req, res)) { session.page = null; session.availablePage = null; return false; }
      Object.assign(session, accounts, { page: accounts.availablePage });
      return true;
    } catch (error) {
      session.page = null;
      session.availablePage = null;
      const code = error instanceof AdminGraphError ? error.code : null;
      if (code === 190) clearSession(req, res);
      logEvent("admin_write_authorization_failed", ...(code === null ? [] : [code]));
      notice(req, res, 403, "Page access or required permissions could not be verified. Please sign in again.");
      return false;
    }
  }
  async function checkBusiness(graph, config, token) {
    if (!config.businessId) return;
    const businesses = await graph.list("me/businesses", token, "id,name");
    if (!businesses.some(row => row?.id === config.businessId)) throw new AdminGraphError();
    const pages = await graph.list(`${config.businessId}/owned_pages`, token, "id,name");
    if (!pages.some(row => row?.id === config.pageId)) throw new AdminGraphError();
  }
  function issueOperation(session, kind) {
    for (const [id, item] of session.operations) if (item.until <= store.now()) session.operations.delete(id);
    if (session.operations.size >= 50) session.operations.delete(session.operations.keys().next().value);
    const id = randomId();
    session.operations.set(id, { kind, until: store.now() + 30 * 60 * 1000 });
    return id;
  }
  function consumeOperation(session, id, kind) {
    const item = session.operations.get(id);
    session.operations.delete(id);
    return item?.kind === kind && item.until > store.now();
  }
  async function subscription(req) {
    const page = req.adminSession.page;
    const rows = await req.adminGraph.list(`${page.id}/subscribed_apps`, page.token, "id,subscribed_fields");
    const app = rows.find(row => row?.id === req.adminConfig.appId);
    if (app && (!Array.isArray(app.subscribed_fields) || app.subscribed_fields.some(field =>
      typeof field !== "string" || !/^[a-z_]{1,100}$/.test(field)))) throw new AdminGraphError();
    return { subscribed: Boolean(app), fields: app?.subscribed_fields || [] };
  }

  router.use((req, res, next) => {
    // Set headers even on redirects, missing settings and rejected requests.
    res.set({ "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    req.adminConfig = adminConfig(env);
    if (!req.adminConfig) return notice(req, res, 503, "Admin console not configured");
    req.adminGraph = adminGraph(req.adminConfig, { fetchImpl, timeoutMs });
    req.adminSessionId = cookieId(req, SESSION_COOKIE, req.adminConfig.sessionSecret);
    req.adminSession = store.session(req.adminSessionId);
    if (req.adminSession && !req.adminConfig.allowedIds.has(req.adminSession.userId)) {
      clearSession(req, res);
      req.adminSession = null;
    }
    const publicRoute = req.method === "GET" && ["/", "/login", "/callback"].includes(req.path);
    if (!publicRoute && !req.adminSession) return notice(req, res, 401, "Please sign in. Your session may have expired.");
    if (req.method === "POST" && (!equalToken(req.body?.csrf, req.adminSession?.csrf) || req.get("Origin") !== req.adminConfig.origin)) {
      return notice(req, res, 403, "Request verification failed.");
    }
    next();
  });

  router.get("/", (req, res) => render(req, res, "Sanhe Messenger Admin", e => req.adminSession
    ? `${adminNav(e, req.adminSession)}<p>Use the four steps to inspect business assets, select our Page, confirm its webhook subscription and reply to a recent customer.</p>`
    : `<p>Sign in to manage our Page and reply to customers who messaged us within the last 24 hours.</p><a class="button" href="/admin/login">Continue with Facebook</a><p>Facebook Login for Business · Authorized administrators only</p>`));

  router.get("/login", (req, res) => {
    if (!store.rate(`login:${req.ip}`)) return notice(req, res, 429, "Too many login attempts. Try again in one minute.");
    const config = req.adminConfig;
    store.consumeState(cookieId(req, STATE_COOKIE, config.sessionSecret));
    const state = store.state();
    if (!state) return notice(req, res, 503, "Login temporarily unavailable.");
    res.cookie(STATE_COOKIE, signedId(state, config.sessionSecret), { ...cookieOptions, maxAge: 5 * 60 * 1000 });
    const url = new URL(`https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`);
    for (const [key, value] of Object.entries({ client_id: config.appId, config_id: config.configId,
      redirect_uri: config.callback, response_type: "code", override_default_response_type: "true",
      auth_type: "rerequest", state })) url.searchParams.set(key, value);
    logEvent("admin_login_started");
    res.redirect(302, url.href);
  });

  router.get("/callback", async (req, res) => {
    const config = req.adminConfig;
    const boundState = cookieId(req, STATE_COOKIE, config.sessionSecret);
    const valid = store.consumeState(boundState);
    res.clearCookie(STATE_COOKIE, cookieOptions);
    if (!valid || !equalToken(req.query.state, boundState) || !scalar(req.query.code) || req.query.error) {
      logEvent("admin_login_rejected");
      return notice(req, res, 400, "Login verification failed or expired. Please start again.");
    }
    // Consume the state and discard an old login before the first async operation.
    clearSession(req, res);
    req.adminSession = null;
    const tokenIssuedAt = store.now();
    const token = await req.adminGraph.exchange(req.query.code);
    if (!scalar(token.access_token, 8192) || (token.expires_in !== undefined &&
        (!Number.isFinite(token.expires_in) || token.expires_in <= 0))) throw new AdminGraphError();
    const me = await req.adminGraph.get("me", token.access_token, { fields: "id" });
    if (typeof me.id !== "string" || !/^\d+$/.test(me.id)) throw new AdminGraphError();
    if (!config.allowedIds.has(me.id)) {
      logEvent("admin_login_denied");
      return notice(req, res, 403, `Access denied. 請把此 ID 交給管理員：${me.id}`);
    }
    const grants = await req.adminGraph.list("me/permissions", token.access_token, "permission,status");
    if (!ADMIN_SCOPES.every(permission => grants.some(grant => grant?.permission === permission && grant.status === "granted"))) {
      return notice(req, res, 403, "The required permissions were not granted. Please sign in again and authorize all four permissions.");
    }
    const accounts = await account(req.adminGraph, config, token.access_token);
    if (!accounts.availablePage) return notice(req, res, 403, "The supported Page requires the MESSAGING task and a Page access token.");
    await checkBusiness(req.adminGraph, config, token.access_token);
    const tokenUntil = tokenIssuedAt + Math.min(token.expires_in ?? 7200, 7200) * 1000;
    if (tokenUntil <= store.now()) throw new AdminGraphError();
    const id = store.createSession({ userId: me.id, userToken: token.access_token,
      tokenUntil, ...accounts });
    if (!id) return notice(req, res, 503, "Admin console temporarily unavailable.");
    res.cookie(SESSION_COOKIE, signedId(id, config.sessionSecret), { ...cookieOptions, maxAge: 2 * 60 * 60 * 1000 });
    logEvent("admin_login_succeeded");
    res.redirect(303, "/admin/businesses");
  });

  router.get("/businesses", async (req, res) => {
    const config = req.adminConfig, session = req.adminSession;
    const businesses = (await req.adminGraph.list("me/businesses", session.userToken, "id,name")).map(asset).filter(Boolean)
      .filter(row => !config.businessId || row.id === config.businessId);
    const selected = scalar(req.query.business, 100);
    if (selected && !businesses.some(row => row.id === selected)) return notice(req, res, 403, "Unsupported business portfolio.");
    const owned = selected ? (await req.adminGraph.list(`${selected}/owned_pages`, session.userToken, "id,name")).map(asset).filter(Boolean) : null;
    return render(req, res, "Step 1 Business", e => `${adminNav(e, session)}<p>business_management: business portfolios available to the signed-in administrator.</p>
      ${businesses.length ? `<ul>${businesses.map(row => `<li><a href="/admin/businesses?business=${e(row.id)}">${e(row.name)}</a> · ${e(row.id)}</li>`).join("")}</ul>` : "<p>No supported business portfolios were returned.</p>"}
      ${owned ? `<h2>Owned Pages</h2><ul>${owned.map(row => `<li>${e(row.name)} · ${e(row.id)}${row.id === config.pageId ? " · Supported Page" : " · Not supported"}</li>`).join("")}</ul>` : "<p>Select a business to view its owned Pages.</p>"}
      <p><a href="/admin/pages">Continue to Step 2 Page</a></p>`);
  });

  router.get("/pages", async (req, res) => {
    const session = req.adminSession;
    const accounts = await account(req.adminGraph, req.adminConfig, session.userToken);
    Object.assign(session, accounts);
    if (!accounts.availablePage) { session.page = null; return notice(req, res, 403, "Page access or the MESSAGING task is missing. Sign in again."); }
    return render(req, res, "Step 2 Select Page", e => `${adminNav(e, session)}<p>pages_show_list: Pages managed by the signed-in administrator. Only our Page is supported.</p>
      <ul>${session.pages.map(row => `<li>${e(row.name)} · ${e(row.id)}${row.id === req.adminConfig.pageId ? " · MESSAGING task verified" : " · Not supported"}</li>`).join("")}</ul>
      <form method="post" action="/admin/page">${csrfField(e, session)}<label><input type="radio" name="page" value="${e(req.adminConfig.pageId)}" required> ${e(session.availablePage.name)} · ${e(req.adminConfig.pageId)}</label><button>Select Page</button></form>`);
  });

  router.post("/page", async (req, res) => {
    const session = req.adminSession;
    if (req.body?.page !== req.adminConfig.pageId) return notice(req, res, 403, "Unsupported Page.");
    const accounts = await account(req.adminGraph, req.adminConfig, session.userToken);
    if (!accounts.availablePage) { session.page = null; return notice(req, res, 403, "Page access or the MESSAGING task is missing."); }
    await checkBusiness(req.adminGraph, req.adminConfig, session.userToken);
    if (!activeSession(req, res)) return;
    session.page = accounts.availablePage;
    Object.assign(session, accounts);
    logEvent("admin_page_selected");
    res.redirect(303, "/admin/subscription");
  });

  router.get("/subscription", async (req, res) => {
    if (!requirePage(req, res)) return;
    const session = req.adminSession, current = await subscription(req);
    const operation = issueOperation(session, "subscription");
    return render(req, res, "Step 3 Webhook", e => `${adminNav(e, session)}<p>pages_manage_metadata: subscription for ${e(session.page.name)} · ${e(session.page.id)}.</p>
      ${session.subscriptionNotice ? `<p class="notice">${e(session.subscriptionNotice)}</p>` : ""}
      <p>App ${e(req.adminConfig.appId)}: <strong>${current.subscribed ? "Subscribed" : "Not subscribed"}</strong></p><p>Subscribed fields: ${e(current.fields.join(", ") || "None")}</p>
      <p>Confirm subscription reads the current fields, adds messages and messaging_postbacks, then verifies the result. Existing fields are retained. Coordinate with other administrators to avoid concurrent changes.</p>
      <form method="post" action="/admin/subscription">${csrfField(e, session)}${hidden(e, "operation", operation)}<button>Confirm subscription</button></form>
      <p><a href="/admin/recipients">Continue to Step 4 Send</a></p>`);
  });

  router.post("/subscription", async (req, res) => {
    if (!requirePage(req, res)) return;
    const session = req.adminSession;
    if (!consumeOperation(session, req.body?.operation, "subscription")) return notice(req, res, 409, "This operation has already been used or expired.");
    if (subscriptionBusy) return notice(req, res, 409, "A subscription confirmation is already in progress.");
    subscriptionBusy = true;
    try {
      if (!await refreshWriteAuthorization(req, res)) return;
      const before = await subscription(req);
      if (!activeSession(req, res)) return;
      const fields = [...new Set([...before.fields, "messages", "messaging_postbacks"])];
      const result = await req.adminGraph.postForm(`${session.page.id}/subscribed_apps`, session.page.token, { subscribed_fields: fields.join(",") });
      if (result.success !== true) throw new AdminGraphError(null, true);
      const after = await subscription(req);
      session.subscriptionNotice = after.subscribed && new Set(after.fields).size === fields.length &&
        fields.every(field => after.fields.includes(field))
        ? "Subscription confirmed. All previous fields and required fields are present."
        : "Warning: subscription verification did not match. Check the Page settings before recording.";
      logEvent("admin_subscription_checked");
      res.redirect(303, "/admin/subscription");
    } finally { subscriptionBusy = false; }
  });

  router.get("/recipients", (req, res) => {
    if (!requirePage(req, res)) return;
    const session = req.adminSession, rows = store.recipients(session.page.id);
    const previous = new Map([...session.recipientCodes].map(([code, psid]) => [psid, code]));
    session.recipientCodes.clear();
    const recipients = rows.map((row, i) => {
      const code = previous.get(row.psid) || randomId();
      session.recipientCodes.set(code, row.psid);
      return { code, label: `Customer ${i + 1}`, time: new Date(row.lastInboundAt).toISOString(), eligible: store.canReply(row) };
    });
    const operation = issueOperation(session, "send");
    return render(req, res, "Step 4 Send", e => `${adminNav(e, session)}<p>pages_messaging: reply from ${e(session.page.name)} · ${e(session.page.id)}.</p>
      ${session.sendNotice ? `<p class="notice">${e(session.sendNotice)}</p>` : ""}
      <p>Only customer messages observed since this server started are listed. Names and message contents are not collected. Restarting clears the list. Customers must message the Page first.</p>
      ${recipients.length ? `<table><thead><tr><th>Customer</th><th>Last inbound (UTC)</th><th>Reply window</th></tr></thead><tbody>${recipients.map(row => `<tr><td>${e(row.label)}</td><td>${e(row.time)}</td><td>${row.eligible ? "Within 24 hours" : "Expired: reply disabled"}</td></tr>`).join("")}</tbody></table>
      <form method="post" action="/admin/send">${csrfField(e, session)}${hidden(e, "operation", operation)}
      <label>Recent customer <select name="recipient" required><option value="">Select customer</option>${recipients.map(row => `<option value="${e(row.code)}"${row.eligible ? "" : " disabled"}>${e(row.label)} · ${e(row.time)}${row.eligible ? "" : " · Expired"}</option>`).join("")}</select></label>
      <label>Reply (maximum 2000 characters)<textarea name="text" maxlength="2000" required></textarea></label><button${recipients.some(row => row.eligible) ? "" : " disabled"}>Send</button></form>` : "<p>No recent customers. Ask the test customer to send a new message, then refresh this page.</p>"}
      <p><a href="/admin/recipients">Refresh recent customers</a></p>`);
  });

  router.post("/send", async (req, res) => {
    if (!requirePage(req, res)) return;
    const session = req.adminSession;
    if (!store.rate(`send:${req.adminSessionId}`)) return notice(req, res, 429, "Too many send attempts. Try again in one minute.");
    const text = scalar(req.body?.text, 2000)?.trim();
    const psid = session.recipientCodes.get(req.body?.recipient);
    if (!text || !psid || !store.canReply(store.recipient(session.page.id, psid))) {
      return notice(req, res, 400, "Select a recent customer within the 24-hour window and enter a reply of at most 2000 characters.");
    }
    if (!consumeOperation(session, req.body?.operation, "send")) return notice(req, res, 409, "This send operation has already been used or expired. Refresh to prepare a new reply.");
    if (session.sendBusy) return notice(req, res, 409, "A send is already in progress.");
    session.sendBusy = true;
    try {
      if (!await refreshWriteAuthorization(req, res)) return;
      // Authorization checks take time: reject a reply whose window expired meanwhile.
      if (!store.canReply(store.recipient(session.page.id, psid))) {
        return notice(req, res, 400, "The 24-hour reply window has expired. Ask the customer to message the Page again.");
      }
      session.sendNotice = "Result unconfirmed. Check Messenger before preparing another reply. No automatic retry was made.";
      const result = await req.adminGraph.post(`${session.page.id}/messages`, session.page.token, {
        messaging_type: "RESPONSE", recipient: { id: psid }, message: { text },
      });
      if (!scalar(result.message_id, 512)) throw new AdminGraphError(null, true);
      session.sendNotice = `Meta accepted the reply. Message ID: ${result.message_id}. Time (UTC): ${new Date(store.now()).toISOString()}. Confirm receipt in Messenger.`;
      logEvent("admin_message_accepted");
      res.redirect(303, "/admin/recipients");
    } finally { session.sendBusy = false; }
  });

  router.post("/logout", (req, res) => {
    clearSession(req, res);
    store.consumeState(cookieId(req, STATE_COOKIE, req.adminConfig.sessionSecret));
    res.clearCookie(STATE_COOKIE, cookieOptions);
    logEvent("admin_logout");
    res.redirect(303, "/admin");
  });

  router.use((error, req, res, _next) => {
    const code = error instanceof AdminGraphError ? error.code : null;
    if (code === 190) clearSession(req, res);
    logEvent("admin_request_failed", ...(code === null ? [] : [code]));
    const uncertain = error instanceof AdminGraphError && error.uncertain;
    const text = req.path === "/send" && uncertain ? "Result unconfirmed. Check Messenger before preparing another reply. No automatic retry was made."
      : req.path === "/subscription" && uncertain ? "Subscription result unconfirmed. Check the current status before trying again. No automatic retry was made."
      : "Meta request failed. Please check permissions or sign in again.";
    return notice(req, res, 502, text + (code === null ? "" : ` Meta error code: ${code}.`));
  });

  return {
    router, store,
    observe(pageId, event) {
      try { store.observe(pageId, event, adminConfig(env)?.pageId); }
      catch { logEvent("admin_observer_failed"); }
    },
  };
}
