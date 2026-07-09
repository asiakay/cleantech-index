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
import {
  renderProjectPage,
  renderDeveloperPage,
  renderHome,
  renderAccount,
  renderNotFound,
  renderPaywall,
  FREE_LIMIT,
} from "../src/render.js";

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
  it("accepts a payload without exp", async () => {
    const t = await signPayload(SECRET, { v: 0 });
    expect(await verifyPayload(SECRET, t)).toEqual({ v: 0 });
  });
  it("rejects null token", async () => {
    expect(await verifyPayload(SECRET, null)).toBeNull();
  });
  it("rejects empty string token", async () => {
    expect(await verifyPayload(SECRET, "")).toBeNull();
  });
  it("rejects token with no dot separator", async () => {
    expect(await verifyPayload(SECRET, "nodothere")).toBeNull();
  });
  it("parses and hardens cookies", () => {
    expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" });
    const s = serializeCookie("ct_views", "v.sig");
    expect(s).toMatch(/HttpOnly/);
    expect(s).toMatch(/Secure/);
    expect(s).toMatch(/SameSite=Lax/);
  });
  it("parseCookies handles a null Cookie header", () => {
    expect(parseCookies(null)).toEqual({});
  });
  it("parseCookies handles an empty Cookie header", () => {
    expect(parseCookies("")).toEqual({});
  });
  it("parseCookies skips parts without an equals sign", () => {
    expect(parseCookies("badpart; a=1; another-bad")).toEqual({ a: "1" });
  });
  it("parseCookies URL-decodes values", () => {
    expect(parseCookies("k=hello%20world")).toEqual({ k: "hello world" });
  });
  it("serializeCookie applies a custom maxAge", () => {
    const s = serializeCookie("session_token", "tok", { maxAge: 86400 });
    expect(s).toContain("Max-Age=86400");
    expect(s).toContain("HttpOnly");
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

const projectRow = {
  project_name: "Mustang Ridge Solar", slug: "mustang-ridge-solar",
  technology_type: "Solar PV", capacity_mw: 250, status: "Operational",
  interconnection_utility: "ERCOT", commercial_operation_year: 2023,
  county: "Crockett", state: "TX", developer_name: "Helios Grid Partners",
  developer_slug: "helios-grid-partners", headquarters_state: "TX", total_portfolio_mw: 4200,
  vendors: [{ name: "Sunterra Modules", type: "PV Module" }],
};

describe("renderProjectPage", () => {
  it("meta title uses the exact required format", () => {
    const { title } = renderProjectPage(projectRow, projectRow.vendors, 2, "https://x.test");
    expect(title).toBe("Mustang Ridge Solar - 250 MW Solar PV Infrastructure | CleanTech Index");
  });
  it("shows the free-views meter and flushes head first", () => {
    const { chunks } = renderProjectPage(projectRow, projectRow.vendors, 2, "https://x.test");
    expect(chunks[0].startsWith("<!doctype html>")).toBe(true);
    expect(chunks.join("")).toContain("2 free views left");
  });
  it("shows singular 'view' when exactly 1 view remains", () => {
    const { chunks } = renderProjectPage(projectRow, projectRow.vendors, 1, "https://x.test");
    expect(chunks.join("")).toContain("1 free view left");
    expect(chunks.join("")).not.toContain("1 free views left");
  });
  it("shows member badge instead of meter when freeViewsLeft is null", () => {
    const body = renderProjectPage(projectRow, projectRow.vendors, null, "https://x.test").chunks.join("");
    expect(body).toContain("Member · unlimited access");
    expect(body).not.toContain("free view");
  });
  it("renders vendor list", () => {
    const body = renderProjectPage(projectRow, projectRow.vendors, 2, "https://x.test").chunks.join("");
    expect(body).toContain("Sunterra Modules");
    expect(body).toContain("PV Module");
  });
  it("omits the suppliers section when there are no vendors", () => {
    const body = renderProjectPage(projectRow, [], 2, "https://x.test").chunks.join("");
    expect(body).not.toContain("Hardware");
  });
  it("JSON-LD is safe when the project name contains </script>", () => {
    const evil = { ...projectRow, project_name: "Evil </script><script>alert(1)</script> Solar" };
    const body = renderProjectPage(evil, [], 1, "https://x.test").chunks.join("");
    // The dangerous sequence must not appear verbatim.
    expect(body).not.toContain("</script><script>");
    // But the page must still contain the escaped name in JSON-LD.
    expect(body).toContain("\\u003c/script\\u003e");
  });
  it("includes a canonical link", () => {
    const body = renderProjectPage(projectRow, [], 2, "https://x.test").chunks.join("");
    expect(body).toContain('rel="canonical" href="https://x.test/project/mustang-ridge-solar"');
  });
  it("paywall names the limit", () => {
    expect(renderPaywall("https://x.test").chunks.join("")).toContain(`${FREE_LIMIT} free project views`);
  });
});

describe("renderDeveloperPage", () => {
  const dev = { name: "Prairie Wind Development", slug: "prairie-wind-development", headquarters_state: "IA", total_portfolio_mw: 3100.5 };
  const projects = [
    { project_name: "North Prairie Wind", slug: "north-prairie-wind", technology_type: "Onshore Wind", capacity_mw: 400, status: "Operational", state: "IA", commercial_operation_year: 2022 },
    { project_name: "South Prairie Wind", slug: "south-prairie-wind", technology_type: "Onshore Wind", capacity_mw: 200, status: "Planned", state: "IA", commercial_operation_year: null },
  ];

  it("title format is correct", () => {
    const { title } = renderDeveloperPage(dev, projects, "https://x.test");
    expect(title).toBe("Prairie Wind Development — Clean Energy Project Portfolio | CleanTech Index");
  });
  it("lists all projects with links", () => {
    const body = renderDeveloperPage(dev, projects, "https://x.test").chunks.join("");
    expect(body).toContain("/project/north-prairie-wind");
    expect(body).toContain("North Prairie Wind");
    expect(body).toContain("/project/south-prairie-wind");
  });
  it("shows portfolio MW in the subtitle", () => {
    const body = renderDeveloperPage(dev, projects, "https://x.test").chunks.join("");
    expect(body).toContain("3100.5 MW");
  });
  it("shows HQ state in the subtitle", () => {
    const body = renderDeveloperPage(dev, projects, "https://x.test").chunks.join("");
    expect(body).toContain("HQ IA");
  });
  it("shows 'No projects tracked' when the list is empty", () => {
    const body = renderDeveloperPage(dev, [], "https://x.test").chunks.join("");
    expect(body).toContain("No projects tracked yet");
  });
  it("JSON-LD is safe when developer name contains </script>", () => {
    const evilDev = { ...dev, name: "Bad </script><script>alert(1)</script> Co" };
    const body = renderDeveloperPage(evilDev, [], "https://x.test").chunks.join("");
    expect(body).not.toContain("</script><script>");
    expect(body).toContain("\\u003c/script\\u003e");
  });
  it("includes a canonical link", () => {
    const body = renderDeveloperPage(dev, [], "https://x.test").chunks.join("");
    expect(body).toContain('rel="canonical" href="https://x.test/developer/prairie-wind-development"');
  });
});

describe("renderHome", () => {
  const projects = [
    { project_name: "Mustang Ridge Solar", slug: "mustang-ridge-solar", technology_type: "Solar PV", capacity_mw: 250, state: "TX" },
    { project_name: "North Prairie Wind", slug: "north-prairie-wind", technology_type: "Onshore Wind", capacity_mw: 400, state: "IA" },
  ];

  it("lists every project with a link and capacity", () => {
    const body = renderHome(projects).chunks.join("");
    expect(body).toContain("/project/mustang-ridge-solar");
    expect(body).toContain("Mustang Ridge Solar");
    expect(body).toContain("/project/north-prairie-wind");
    expect(body).toContain("400");
  });
  it("does not include a canonical link (home page uses origin)", () => {
    // Home page has no canonical param passed to head().
    const body = renderHome(projects).chunks.join("");
    expect(body).not.toContain('rel="canonical"');
  });
  it("handles an empty project list gracefully", () => {
    const body = renderHome([]).chunks.join("");
    expect(body).toContain("Featured projects");
  });
});

describe("renderAccount", () => {
  it("shows membership active and email for a member", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const body = renderAccount(true, { paid: true, sub: "user@example.com", exp }).chunks.join("");
    expect(body).toContain("Membership active");
    expect(body).toContain("user@example.com");
  });
  it("shows expiry date for a member", () => {
    const exp = Math.floor(new Date("2027-01-01").getTime() / 1000);
    const body = renderAccount(true, { paid: true, sub: null, exp }).chunks.join("");
    expect(body).toContain("2027-01-01");
  });
  it("shows free tier and unlock CTA for non-members", () => {
    const body = renderAccount(false, null).chunks.join("");
    expect(body).toContain("No active membership");
    expect(body).toContain("Unlock full access");
    expect(body).toContain(`${FREE_LIMIT} project views`);
  });
});

describe("renderNotFound", () => {
  it("contains a 404 heading and a link back to the home page", () => {
    const body = renderNotFound("https://x.test").chunks.join("");
    expect(body).toContain("404");
    expect(body).toContain('href="/"');
  });
  it("title contains 'Not found'", () => {
    expect(renderNotFound("https://x.test").title).toContain("Not found");
  });
});
