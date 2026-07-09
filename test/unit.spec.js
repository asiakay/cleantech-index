// Pure-logic unit tests: signed cookies, Stripe signature verification, sitemap, render.
import { describe, it, expect } from "vitest";
import {
  signPayload,
  verifyPayload,
  parseCookies,
  serializeCookie,
} from "../src/cookies.js";
import {
  verifyStripeSignature,
  _signTestPayload,
} from "../src/stripe.js";
import { renderSitemap, renderRobots } from "../src/sitemap.js";
import { renderProjectPage, renderPaywall, FREE_LIMIT } from "../src/render.js";

const SECRET = "unit-secret";

describe("signed cookies", () => {
  it("round-trips a payload", async () => {
    const t = await signPayload(SECRET, { v: 2 });
    expect(await verifyPayload(SECRET, t)).toEqual({ v: 2 });
  });
  it("rejects a tampered body", async () => {
    const t = await signPayload(SECRET, { v: 2 });
    expect(await verifyPayload(SECRET, "x" + t.slice(1))).toBeNull();
  });
  it("rejects a wrong secret", async () => {
    const t = await signPayload(SECRET, { v: 2 });
    expect(await verifyPayload("other", t)).toBeNull();
  });
  it("enforces exp", async () => {
    const past = await signPayload(SECRET, { paid: true, exp: Math.floor(Date.now() / 1000) - 10 });
    expect(await verifyPayload(SECRET, past)).toBeNull();
    const future = await signPayload(SECRET, { paid: true, exp: Math.floor(Date.now() / 1000) + 999 });
    expect(await verifyPayload(SECRET, future)).toMatchObject({ paid: true });
  });
  it("parses and hardens cookies", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
    const s = serializeCookie("ct_views", "v.sig");
    expect(s).toMatch(/HttpOnly/);
    expect(s).toMatch(/Secure/);
    expect(s).toMatch(/SameSite=Lax/);
  });
});

describe("stripe signature verification", () => {
  const whsec = "whsec_unit";
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });

  it("accepts a correctly signed payload", async () => {
    const header = await _signTestPayload(whsec, body);
    const r = await verifyStripeSignature(whsec, body, header);
    expect(r.ok).toBe(true);
    expect(r.event.id).toBe("evt_1");
  });
  it("rejects a bad signature", async () => {
    const header = `t=${Math.floor(Date.now() / 1000)},v1=deadbeef`;
    const r = await verifyStripeSignature(whsec, body, header);
    expect(r).toMatchObject({ ok: false, reason: "signature_mismatch" });
  });
  it("rejects a stale timestamp (replay)", async () => {
    const oldTs = Math.floor(Date.now() / 1000) - 10000;
    const header = await _signTestPayload(whsec, body, oldTs);
    const r = await verifyStripeSignature(whsec, body, header);
    expect(r).toMatchObject({ ok: false, reason: "timestamp_out_of_tolerance" });
  });
  it("rejects a missing header", async () => {
    expect((await verifyStripeSignature(whsec, body, null)).ok).toBe(false);
  });
  it("ignores non-v1 schemes and still verifies v1", async () => {
    const ts = Math.floor(Date.now() / 1000);
    const good = await _signTestPayload(whsec, body, ts); // t=..,v1=..
    const header = good + ",v0=ignoreme";
    expect((await verifyStripeSignature(whsec, body, header)).ok).toBe(true);
  });
});

describe("sitemap + robots", () => {
  it("emits urlset with project and developer urls", () => {
    const xml = renderSitemap("https://x.test", {
      projects: ["a-solar"],
      developers: ["dev-co"],
    });
    expect(xml).toContain("<loc>https://x.test/project/a-solar</loc>");
    expect(xml).toContain("<loc>https://x.test/developer/dev-co</loc>");
    expect(xml).toContain("<loc>https://x.test/</loc>");
    expect(xml.startsWith('<?xml')).toBe(true);
  });
  it("robots references the sitemap", () => {
    expect(renderRobots("https://x.test")).toContain("Sitemap: https://x.test/sitemap.xml");
  });
});

describe("render", () => {
  const row = {
    project_name: "Mustang Ridge Solar", slug: "mustang-ridge-solar",
    technology_type: "Solar PV", capacity_mw: 250, status: "Operational",
    interconnection_utility: "ERCOT", commercial_operation_year: 2023,
    county: "Crockett", state: "TX", developer_name: "Helios Grid Partners",
    developer_slug: "helios-grid-partners", headquarters_state: "TX", total_portfolio_mw: 4200,
    vendors: [{ name: "Sunterra Modules", type: "PV Module" }],
  };
  it("meta title uses the exact required format", () => {
    const { title } = renderProjectPage(row, row.vendors, 2, "https://x.test");
    expect(title).toBe("Mustang Ridge Solar - 250 MW Solar PV Infrastructure | CleanTech Index");
  });
  it("shows the free-views meter and flushes head first", () => {
    const { chunks } = renderProjectPage(row, row.vendors, 2, "https://x.test");
    expect(chunks[0].startsWith("<!doctype html>")).toBe(true);
    expect(chunks.join("")).toContain("2 free views left");
  });
  it("paywall names the limit", () => {
    expect(renderPaywall("https://x.test").chunks.join("")).toContain(`${FREE_LIMIT} free project views`);
  });
});
