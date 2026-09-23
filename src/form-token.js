import crypto from "node:crypto";

function secret() {
  const value = process.env.FORM_TOKEN_SECRET;
  if (process.env.NODE_ENV === "production" && (!value || value.length < 32)) {
    throw new Error("FORM_TOKEN_SECRET must contain at least 32 characters");
  }
  return value || DEV_SECRET;
}

const DEV_SECRET = crypto.randomBytes(32).toString("hex");

function b64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, "base64").toString("utf8");
}

/** Create short-lived token binding Messenger PSID */
export function signFormToken(psid, ttlSec = 2 * 60 * 60, edit = null) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${psid}.${exp}.${crypto.randomBytes(16).toString("hex")}${edit ? "." + b64url(JSON.stringify(edit)) : ""}`;
  const sig = crypto
    .createHmac("sha256", secret())
    .update(payload)
    .digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

export function verifyFormToken(token) {
  if (!token || typeof token !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("invalid token");
  }
  const [payloadB64, sigB64] = token.split(".");
  const payload = fromB64url(payloadB64);
  const expected = crypto
    .createHmac("sha256", secret())
    .update(payload)
    .digest();
  const got = Buffer.from(
    sigB64.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (sigB64.length % 4)) % 4),
    "base64"
  );
  if (
    expected.length !== got.length ||
    !crypto.timingSafeEqual(expected, got)
  ) {
    throw new Error("bad signature");
  }
  const [psid, expStr, , editData] = payload.split(".");
  const exp = Number(expStr);
  if (!psid || !exp || Date.now() / 1000 > exp) {
    throw new Error("token expired");
  }
  const edit = editData ? JSON.parse(fromB64url(editData)) : null;
  if (edit && (!edit.id || !["db", "memory"].includes(edit.storage) || !/^[a-f0-9]{64}$/.test(edit.version))) throw new Error("invalid edit token");
  return { psid, exp, edit };
}

export function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
