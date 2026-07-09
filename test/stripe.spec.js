// Stripe flow end-to-end: verified webhook writes a member; unlock/success mints an access
// cookie; outbound Stripe HTTP is mocked (no network).
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { describe, it, expect, vi, afterEach } from "vitest";
import { _signTestPayload } from "../src/stripe.js";
import { getMemberBySessionId } from "../src/db.js";

const BASE = "https://cleantech.test";
const call = (path, init) => exports.default.fetch(new Request(BASE + path, { redirect: "manual", ...init }));

afterEach(() => vi.unstubAllGlobals());

// Mock the Worker's outbound fetch to Stripe.
function stubStripe() {
  vi.stubGlobal("fetch", async (input) => {
    const u = typeof input === "string" ? input : input.url;
    if (/\/v1\/checkout\/sessions\/[^/]+$/.test(u)) {
      return new Response(
        JSON.stringify({ id: "cs_ok", payment_status: "paid", customer_details: { email: "buyer@x.co" } }),
        { headers: { "content-type": "application/json" } }
      );
    }
    if (u.endsWith("/v1/checkout/sessions")) {
      return new Response(
        JSON.stringify({ id: "cs_ok", url: "https://checkout.stripe.test/pay/cs_ok" }),
        { headers: { "content-type": "application/json" } }
      );
    }
    throw new Error("unexpected outbound fetch: " + u);
  });
}

describe("webhook", () => {
  const body = JSON.stringify({
    id: "evt_1",
    type: "checkout.session.completed",
    data: { object: { id: "cs_webhook_1", customer: "cus_9", customer_details: { email: "w@x.co" } } },
  });

  it("accepts a correctly signed event and records the member", async () => {
    const sig = await _signTestPayload(env.STRIPE_WEBHOOK_SECRET, body);
    const r = await call("/webhook/stripe", {
      method: "POST",
      headers: { "Stripe-Signature": sig, "content-type": "application/json" },
      body,
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ received: true });
    const m = await getMemberBySessionId(env, "cs_webhook_1");
    expect(m.email).toBe("w@x.co");
  });

  it("rejects an invalid signature with 400", async () => {
    const r = await call("/webhook/stripe", {
      method: "POST",
      headers: { "Stripe-Signature": `t=${Math.floor(Date.now() / 1000)},v1=bad`, "content-type": "application/json" },
      body,
    });
    expect(r.status).toBe(400);
  });

  it("rejects a body signed with the wrong secret", async () => {
    const sig = await _signTestPayload("whsec_wrong", body);
    const r = await call("/webhook/stripe", {
      method: "POST",
      headers: { "Stripe-Signature": sig, "content-type": "application/json" },
      body,
    });
    expect(r.status).toBe(400);
  });
});

describe("checkout + success unlock", () => {
  it("GET /unlock redirects to the Stripe checkout url", async () => {
    stubStripe();
    const r = await call("/unlock");
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("checkout.stripe.test/pay/cs_ok");
  });

  it("GET /unlock/success verifies payment, sets a session cookie, and unlocks the meter", async () => {
    stubStripe();
    const success = await call("/unlock/success?session_id=cs_ok");
    expect(success.status).toBe(303);
    const setCookie = success.headers.get("set-cookie");
    expect(setCookie).toMatch(/session_token=/);

    // Use the minted cookie: the paywall is bypassed even with an exhausted view count.
    const token = setCookie.split(";")[0]; // session_token=...
    const exhausted = "ct_views=" + encodeURIComponent("forged"); // invalid/ignored
    const page = await call("/project/mustang-ridge-solar", {
      headers: { Cookie: `${token}; ${exhausted}` },
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Member · unlimited access");
  });
});
