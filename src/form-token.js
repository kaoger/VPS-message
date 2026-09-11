import crypto from "node:crypto";

function secret() {
  return (
    process.env.FORM_TOKEN_SECRET ||
    process.env.META_VERIFY_TOKEN ||
    "dev-form-secret-change-me"
  );
}

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
export function signFormToken(psid, ttlSec = 2 * 60 * 60) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${psid}.${exp}`;
  const sig = crypto
    .createHmac("sha256", secret())
    .update(payload)
    .digest();
  return `${b64url(payload)}.${b64url(sig)}`;
}

export function verifyFormToken(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) {
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
  const [psid, expStr] = payload.split(".");
  const exp = Number(expStr);
  if (!psid || !exp || Date.now() / 1000 > exp) {
    throw new Error("token expired");
  }
  return { psid, exp };
}

export function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    return process.env.PUBLIC_BASE_URL.replace(/\/$/, "");
  }
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}
