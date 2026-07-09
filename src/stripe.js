// stripe.js — Stripe integration with ZERO SDK. REST via fetch, webhook verified with Web Crypto.
// Kept dependency-free so it runs natively on the edge; the stripe-node SDK needs Node crypto.

const enc = new TextEncoder();

function toHex(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

// Constant-time compare over equal-length hex strings.
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a Stripe webhook.
 * Header format: `t=<unix_seconds>,v1=<hex_hmac>[,v1=<hex_hmac>][,v0=...]`.
 * Signed payload is exactly `${t}.${rawBody}`, HMAC-SHA256 keyed with the whsec_ secret.
 * We ignore every scheme except v1 (downgrade protection), enforce a timestamp
 * tolerance (replay protection), and compare in constant time.
 *
 * @returns {{ok:true,event:object} | {ok:false,reason:string}}
 */
export async function verifyStripeSignature(
  secret,
  rawBody,
  sigHeader,
  toleranceSec = 300,
  nowMs = Date.now()
) {
  if (!secret) return { ok: false, reason: "no_secret_configured" };
  if (!sigHeader) return { ok: false, reason: "missing_signature_header" };

  const items = sigHeader.split(",").map((p) => p.trim());
  const t = items.find((p) => p.startsWith("t="))?.slice(2);
  const v1s = items.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));

  if (!t) return { ok: false, reason: "missing_timestamp" };
  if (v1s.length === 0) return { ok: false, reason: "missing_v1_signature" };

  const ts = parseInt(t, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "malformed_timestamp" };
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > toleranceSec) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const expected = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  if (!v1s.some((sig) => timingSafeEqual(sig, expected))) {
    return { ok: false, reason: "signature_mismatch" };
  }

  try {
    return { ok: true, event: JSON.parse(rawBody) };
  } catch {
    return { ok: false, reason: "invalid_json_body" };
  }
}

const apiBase = (env) => env.STRIPE_API_BASE || "https://api.stripe.com";

/** Create a one-time Checkout Session and return the Stripe session object (has `.url`). */
export async function createCheckoutSession(env, { successUrl, cancelUrl }) {
  const form = new URLSearchParams();
  form.set("mode", "payment");
  form.set("success_url", successUrl);
  form.set("cancel_url", cancelUrl);

  if (env.STRIPE_PRICE_ID) {
    form.set("line_items[0][price]", env.STRIPE_PRICE_ID);
    form.set("line_items[0][quantity]", "1");
  } else {
    const cents = parseInt(env.STRIPE_UNLOCK_AMOUNT_CENTS || "900", 10);
    form.set("line_items[0][price_data][currency]", "usd");
    form.set("line_items[0][price_data][product_data][name]", "CleanTech Index — full access");
    form.set("line_items[0][price_data][unit_amount]", String(cents));
    form.set("line_items[0][quantity]", "1");
  }

  const res = await fetch(`${apiBase(env)}/v1/checkout/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });

  if (!res.ok) {
    throw new Error(`stripe_checkout_create_failed ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/** Retrieve a Checkout Session to confirm payment on the success redirect. */
export async function retrieveCheckoutSession(env, sessionId) {
  const res = await fetch(
    `${apiBase(env)}/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
  );
  if (!res.ok) {
    throw new Error(`stripe_checkout_retrieve_failed ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Exported for tests: lets a test forge a correctly-signed webhook payload.
export async function _signTestPayload(secret, rawBody, ts = Math.floor(Date.now() / 1000)) {
  const sig = await hmacSha256Hex(secret, `${ts}.${rawBody}`);
  return `t=${ts},v1=${sig}`;
}
