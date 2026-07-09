// Query-layer tests against a REAL D1 binding (seeded via migrations).
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import {
  getProjectBySlug,
  getDeveloperBySlug,
  getFeaturedProjects,
  getAllSlugs,
  recordMember,
  getMemberBySessionId,
} from "../src/db.js";

describe("getProjectBySlug (single JOIN query)", () => {
  it("returns project + developer + all vendors", async () => {
    const p = await getProjectBySlug(env, "llano-battery-hub");
    expect(p.project_name).toBe("Llano Battery Hub");
    expect(p.developer_name).toBe("Helios Grid Partners");
    expect(p.capacity_mw).toBe(150);
    // Llano is seeded with three vendors.
    const names = p.vendors.map((v) => v.name).sort();
    expect(names).toEqual(["Cellwave Energy", "GridLink Controls", "VoltCore Systems"]);
    expect(p.vendors.every((v) => typeof v.type === "string")).toBe(true);
  });
  it("returns null for an unknown slug", async () => {
    expect(await getProjectBySlug(env, "nope")).toBeNull();
  });
});

describe("getDeveloperBySlug (batched)", () => {
  it("returns developer and their projects newest-capacity-first", async () => {
    const d = await getDeveloperBySlug(env, "helios-grid-partners");
    expect(d.dev.name).toBe("Helios Grid Partners");
    const slugs = d.projects.map((p) => p.slug);
    expect(slugs).toContain("mustang-ridge-solar");
    expect(slugs).toContain("llano-battery-hub");
    // ordered by capacity desc: 250 before 150
    expect(d.projects[0].capacity_mw).toBeGreaterThanOrEqual(d.projects[1].capacity_mw);
  });
  it("returns null for an unknown developer", async () => {
    expect(await getDeveloperBySlug(env, "nope")).toBeNull();
  });
});

describe("sitemap + featured helpers", () => {
  it("getAllSlugs returns seeded slugs", async () => {
    const s = await getAllSlugs(env);
    expect(s.projects).toContain("mustang-ridge-solar");
    expect(s.developers).toContain("prairie-wind-development");
  });
  it("getFeaturedProjects respects the limit", async () => {
    const r = await getFeaturedProjects(env, 2);
    expect(r.length).toBe(2);
  });
});

describe("recordMember (idempotent)", () => {
  it("inserts once and ignores duplicates", async () => {
    await recordMember(env, { email: "a@b.co", stripeCustomerId: "cus_1", stripeSessionId: "cs_dup" });
    await recordMember(env, { email: "a@b.co", stripeCustomerId: "cus_1", stripeSessionId: "cs_dup" });
    const m = await getMemberBySessionId(env, "cs_dup");
    expect(m.email).toBe("a@b.co");
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM members WHERE stripe_session_id = ?"
    ).bind("cs_dup").all();
    expect(results[0].n).toBe(1);
  });
});
