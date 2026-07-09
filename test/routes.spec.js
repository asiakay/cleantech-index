// End-to-end route + paywall tests through the real Worker (exports.default.fetch) with real D1.
import { exports } from "cloudflare:workers";
import { env } from "cloudflare:workers";
import { describe, it, expect, vi, afterEach } from "vitest";
import { signPayload } from "../src/cookies.js";
import { _signTestPayload } from "../src/stripe.js";

const BASE = "https://cleantech.test";
const call = (path, init) => exports.default.fetch(new Request(BASE + path, init));

// Minimal cookie jar: tracks name=value pairs across requests.
function jar() {
  const map = new Map();
  return {
    header: () => [...map.values()].join("; "),
    absorb(res) {
      const sc = res.headers.get("set-cookie");
      if (sc) {
        const pair = sc.split(";")[0];
        map.set(pair.split("=")[0], pair);
      }
      return res;
    },
  };
}

describe("basic routes", () => {
  it("GET /health", async () => {
    const r = await call("/health");
    expect(await r.text()).toBe("ok");
  });
  it("GET / lists seeded projects and is cacheable", async () => {
    const r = await call("/");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toMatch(/public/);
    expect(await r.text()).toContain("Mustang Ridge Solar");
  });
  it("GET /developer/:slug lists the developer's projects", async () => {
    const r = await call("/developer/helios-grid-partners");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("Helios Grid Partners");
    expect(body).toContain("Mustang Ridge Solar");
    expect(body).toContain("Llano Battery Hub");
  });
  it("GET unknown path renders styled 404", async () => {
    const r = await call("/nope");
    expect(r.status).toBe(404);
    expect(await r.text()).toContain("404");
  });
  it("GET /sitemap.xml includes project + developer urls", async () => {
    const r = await call("/sitemap.xml");
    expect(r.headers.get("content-type")).toMatch(/xml/);
    const xml = await r.text();
    expect(xml).toContain("/project/mustang-ridge-solar");
    expect(xml).toContain("/developer/helios-grid-partners");
  });
  it("GET /robots.txt references the sitemap", async () => {
    expect(await (await call("/robots.txt")).text()).toContain("Sitemap: https://cleantech.test/sitemap.xml");
  });
  it("GET /account without a session shows free tier", async () => {
    expect(await (await call("/account")).text()).toContain("No active membership");
  });
});

describe("project page + meta", () => {
  it("renders exact meta title and a Set-Cookie on first view", async () => {
    const r = await call("/project/mustang-ridge-solar");
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/ct_views=/);
    expect(r.headers.get("vary")).toMatch(/Cookie/);
    const body = await r.text();
    expect(body).toContain(
      "<title>Mustang Ridge Solar - 250 MW Solar PV Infrastructure | CleanTech Index</title>"
    );
    expect(body).toContain("2 free views left");
    expect(body).toContain("Sunterra Modules");
  });
  it("404s a missing project", async () => {
    expect((await call("/project/does-not-exist")).status).toBe(404);
  });
});

describe("3-view meter + paywall", () => {
  it("allows 3 views then blocks the 4th with 402", async () => {
    const j = jar();
    const slugs = [
      "/project/mustang-ridge-solar",
      "/project/llano-battery-hub",
      "/project/north-prairie-wind",
    ];
    // Views 1..3 succeed.
    for (let i = 0; i < 3; i++) {
      const r = j.absorb(await call(slugs[i], { headers: { Cookie: j.header() } }));
      expect(r.status).toBe(200);
    }
    // View 4 is blocked.
    const blocked = await call("/project/quincy-point-storage", { headers: { Cookie: j.header() } });
    expect(blocked.status).toBe(402);
    expect(await blocked.text()).toContain("free project views");
  });

  it("a valid signed session_token bypasses the meter entirely", async () => {
    const token = await signPayload(env.SIGNING_SECRET, {
      paid: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    // Even with an exhausted view cookie, the member is unlimited.
    const exhausted = await signPayload(env.SIGNING_SECRET, { v: 99 });
    const r = await call("/project/mustang-ridge-solar", {
      headers: { Cookie: `session_token=${token}; ct_views=${exhausted}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull(); // meter untouched
    expect(await r.text()).toContain("Member · unlimited access");
  });

  it("a tampered ct_views cookie is treated as 0 views (not blocked)", async () => {
    // Garbage signature → verifyPayload returns null → views defaults to 0.
    const r = await call("/project/mustang-ridge-solar", {
      headers: { Cookie: "ct_views=tampered.invalidsignature" },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("2 free views left");
  });

  it("an expired session_token is ignored and the meter applies normally", async () => {
    const expired = await signPayload(env.SIGNING_SECRET, {
      paid: true,
      exp: Math.floor(Date.now() / 1000) - 1,
    });
    const r = await call("/project/mustang-ridge-solar", {
      headers: { Cookie: `session_token=${expired}` },
    });
    // Treated as anonymous: first view succeeds and meter is set.
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toMatch(/ct_views=/);
  });
});

describe("account page", () => {
  it("GET /account without a session shows free tier", async () => {
    const body = await (await call("/account")).text();
    expect(body).toContain("No active membership");
  });

  it("GET /account with a valid member session shows membership active", async () => {
    const token = await signPayload(env.SIGNING_SECRET, {
      paid: true,
      sub: "member@test.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const r = await call("/account", { headers: { Cookie: `session_token=${token}` } });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("Membership active");
    expect(body).toContain("member@test.com");
  });

  it("GET /account is private and not cached", async () => {
    const cc = (await call("/account")).headers.get("cache-control");
    expect(cc).toMatch(/no-store/);
  });
});

describe("unknown developer", () => {
  it("GET /developer/:unknown returns 404", async () => {
    expect((await call("/developer/no-such-developer")).status).toBe(404);
  });
});

describe("unlock flow edge cases", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("GET /unlock/cancel redirects to /", async () => {
    const r = await call("/unlock/cancel", { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("https://cleantech.test/");
  });

  it("GET /unlock redirects to Stripe when configured", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ id: "cs_test", url: "https://checkout.stripe.test/pay/cs_test" }),
        { headers: { "content-type": "application/json" } }
      )
    );
    const r = await call("/unlock", { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("checkout.stripe.test");
  });

  it("GET /unlock/success without session_id returns 400", async () => {
    const r = await call("/unlock/success");
    expect(r.status).toBe(400);
  });

  it("GET /unlock/success with an unpaid Stripe session returns 402", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ id: "cs_unpaid", payment_status: "unpaid", customer_details: { email: null } }),
        { headers: { "content-type": "application/json" } }
      )
    );
    const r = await call("/unlock/success?session_id=cs_unpaid");
    expect(r.status).toBe(402);
  });
});
