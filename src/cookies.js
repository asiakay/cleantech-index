// cookies.js
// Zero-dependency signed-cookie primitives using the Workers-native Web Crypto API.
// A token is `<base64url(payload)>.<base64url(HMAC-SHA256(payload))>`.
// Tampering with the payload invalidates the signature, so counts can't be forged.

const enc = new TextEncoder();
const dec = new TextDecoder();

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = str.length % 4 ? 4 - (str.length % 4) : 0;
  str += "=".repeat(pad);
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Constant-time string compare — avoids leaking signature bytes via timing.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToB64url(new Uint8Array(sig));
}

/** Sign an arbitrary JSON-serializable payload into a cookie-safe token. */
export async function signPayload(secret, payload) {
  const body = bytesToB64url(enc.encode(JSON.stringify(payload)));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

/** Verify a token and return its payload, or null if missing/tampered/malformed. */
export async function verifyPayload(secret, token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(dec.decode(b64urlToBytes(body)));
    // Optional expiry: if the payload carries `exp` (unix seconds) and it's past, reject.
    if (payload && typeof payload.exp === "number" && Date.now() / 1000 > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** Parse a raw Cookie header into a { name: value } map. */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Serialize a Set-Cookie value. Defaults are hardened for edge tracking. */
export function serializeCookie(name, value, opts = {}) {
  const {
    maxAge = 60 * 60 * 24 * 180, // 180 days
    path = "/",
    httpOnly = true,
    secure = true,
    sameSite = "Lax",
  } = opts;
  let str = `${name}=${encodeURIComponent(value)}`;
  if (maxAge != null) str += `; Max-Age=${maxAge}`;
  if (path) str += `; Path=${path}`;
  if (httpOnly) str += `; HttpOnly`;
  if (secure) str += `; Secure`;
  if (sameSite) str += `; SameSite=${sameSite}`;
  return str;
}
