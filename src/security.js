import crypto from "node:crypto";

export function validateEnvironment(env = process.env) {
  if (env.PORT && env.PORT !== "3000") throw new Error("PORT must be 3000");
  if (env.NODE_ENV !== "production") return;
  for (const key of ["META_APP_SECRET", "META_VERIFY_TOKEN", "META_PAGE_ACCESS_TOKEN", "PUBLIC_BASE_URL"]) {
    if (!env[key]?.trim()) throw new Error(`${key} is required in production`);
  }
  if (!env.FORM_TOKEN_SECRET || env.FORM_TOKEN_SECRET.length < 32) {
    throw new Error("FORM_TOKEN_SECRET must contain at least 32 characters in production");
  }
  const url = new URL(env.PUBLIC_BASE_URL);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("PUBLIC_BASE_URL must be an HTTPS origin");
  }
}

export function validSignature(raw, signature, secret) {
  if (!secret || !Buffer.isBuffer(raw) || !/^sha256=[a-f0-9]{64}$/.test(signature || "")) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

// Claims are synchronous, before any asynchronous side effect.
export function expiryStore() {
  const entries = new Map();
  const cleanup = setInterval(() => {
    for (const [key, expiry] of entries) if (expiry <= Date.now()) entries.delete(key);
  }, 60_000);
  cleanup.unref();
  return {
    claim(key, expiry) {
      if ((entries.get(key) || 0) > Date.now()) return false;
      entries.set(key, expiry);
      return true;
    },
    remove(key) { entries.delete(key); },
  };
}

export function formRateLimit({ max = 20, windowMs = 60_000 } = {}) {
  const entries = new Map();
  setInterval(() => {
    for (const [key, value] of entries) if (value.until <= Date.now()) entries.delete(key);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = req.ip;
    let item = entries.get(key);
    if (!item || item.until <= Date.now()) {
      item = { count: 0, until: Date.now() + windowMs };
      entries.set(key, item);
    }
    if (++item.count > max) {
      res.set("Retry-After", String(Math.ceil((item.until - Date.now()) / 1000)));
      return res.status(429).send("操作太頻繁，請稍後再試。");
    }
    next();
  };
}
