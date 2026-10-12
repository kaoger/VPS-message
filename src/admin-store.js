import crypto from "node:crypto";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const randomId = () => crypto.randomBytes(32).toString("hex");
export const equalToken = (a, b) => typeof a === "string" && typeof b === "string" &&
  a.length <= 512 && b.length <= 512 && Buffer.byteLength(a) === Buffer.byteLength(b) &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function signedId(id, secret) {
  return `${id}.${crypto.createHmac("sha256", secret).update(id).digest("hex")}`;
}

export function cookieId(req, name, secret) {
  const values = (req.headers.cookie || "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  const id = value.split(".")[0];
  return /^[a-f0-9]{64}$/.test(id) && equalToken(value, signedId(id, secret)) ? id : null;
}

export function adminStore({ now = Date.now, maxStates = 200, maxSessions = 100, maxRecipients = 500, maxRates = 2000 } = {}) {
  const states = new Map(), sessions = new Map(), recipients = new Map(), rates = new Map();
  function active(session) {
    return session && now() < session.createdAt + 2 * 60 * 60 * 1000 &&
      now() < session.lastAt + 30 * 60 * 1000 && now() < session.tokenUntil;
  }
  function sweep() {
    for (const [id, state] of states) if (state.until <= now()) states.delete(id);
    for (const [id, session] of sessions) if (!active(session)) sessions.delete(id);
    // Keep an expired row for one extra day so the UI can explain the disabled reply.
    for (const [id, row] of recipients) if (row.lastInboundAt + 2 * DAY_MS <= now()) recipients.delete(id);
    for (const [key, rate] of rates) if (rate.until <= now()) rates.delete(key);
  }
  const timer = setInterval(sweep, 60_000);
  timer.unref();
  return {
    now, close() { clearInterval(timer); },
    state() {
      sweep();
      if (states.size >= maxStates) return null;
      const id = randomId();
      states.set(id, { until: now() + 5 * 60 * 1000 });
      return id;
    },
    consumeState(id) {
      const item = states.get(id);
      states.delete(id);
      return Boolean(item && item.until > now());
    },
    createSession(data) {
      sweep();
      if (sessions.size >= maxSessions) return null;
      const id = randomId();
      sessions.set(id, { ...data, createdAt: now(), lastAt: now(), csrf: randomId(),
        recipientCodes: new Map(), operations: new Map() });
      return id;
    },
    session(id, touch = true) {
      const item = sessions.get(id);
      if (!active(item)) { sessions.delete(id); return null; }
      if (touch) item.lastAt = now();
      return item;
    },
    removeSession(id) { sessions.delete(id); },
    rate(key, max = 10) {
      sweep();
      let item = rates.get(key);
      if (!item) {
        if (rates.size >= maxRates) return false;
        item = { count: 0, until: now() + 60_000 };
        rates.set(key, item);
      }
      return ++item.count <= max;
    },
    observe(pageId, event, allowedPageId) {
      const observedAt = now();
      if (pageId !== allowedPageId || !/^\d+$/.test(pageId || "") ||
          (!event?.message && !event?.postback) || event.message?.is_echo || event.delivery || event.read ||
          typeof event.sender?.id !== "string" || !/^\d+$/.test(event.sender.id) ||
          event.sender.id === pageId || event.recipient?.id !== pageId ||
          !Number.isSafeInteger(event.timestamp) || event.timestamp <= 0 || event.timestamp > observedAt + 5 * 60_000 ||
          event.timestamp + 2 * DAY_MS <= observedAt) return;
      // Clamp once at observation so clock skew cannot extend the 24-hour window later.
      const lastInboundAt = Math.min(event.timestamp, observedAt);
      sweep();
      const key = `${pageId}:${event.sender.id}`;
      const previous = recipients.get(key);
      if (previous && previous.lastInboundAt >= lastInboundAt) return;
      if (!previous && recipients.size >= maxRecipients) recipients.delete(recipients.keys().next().value);
      recipients.delete(key);
      recipients.set(key, { pageId, psid: event.sender.id, lastInboundAt });
    },
    recipients(pageId) {
      sweep();
      return [...recipients.values()].filter(row => row.pageId === pageId).sort((a, b) => b.lastInboundAt - a.lastInboundAt);
    },
    recipient(pageId, psid) { return recipients.get(`${pageId}:${psid}`); },
    canReply(row) { return Boolean(row && row.lastInboundAt <= now() && now() < row.lastInboundAt + DAY_MS); },
  };
}
