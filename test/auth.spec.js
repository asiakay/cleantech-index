// Unit + integration tests for src/auth.js against a real D1 binding.
import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach } from "vitest";
import {
  upsertUser,
  createMagicToken,
  consumeMagicToken,
  createSession,
  getSessionUser,
  deleteSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  getUserSessionToken,
  checkRateLimit,
  cleanupOldRateLimits,
} from "../src/auth.js";
import { parseCookies } from "../src/cookies.js";

// Each test file gets a fresh D1 per the setupFile, but tests within a file
// share the same DB.  We use unique emails / IPs to avoid cross-test pollution.

let uid; // shared user for session tests

describe("upsertUser", () => {
  it("creates a new user and returns an integer id", async () => {
    const id = await upsertUser(env, "alpha@test.com");
    expect(typeof id).toBe("number");
    expect(id).toBeGreaterThan(0);
  });

  it("returns the same id on a second call (idempotent)", async () => {
    const a = await upsertUser(env, "beta@test.com");
    const b = await upsertUser(env, "beta@test.com");
    expect(a).toBe(b);
  });

  it("normalises email via caller convention (stores exactly what is passed)", async () => {
    const id = await upsertUser(env, "gamma@test.com");
    const row = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(id).first();
    expect(row.email).toBe("gamma@test.com");
  });
});

describe("magic link tokens", () => {
  beforeEach(async () => {
    uid = await upsertUser(env, `ml-${Date.now()}@test.com`);
  });

  it("createMagicToken returns a 64-char hex string", async () => {
    const tok = await createMagicToken(env, uid);
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });

  it("consumeMagicToken returns userId and marks token used", async () => {
    const tok = await createMagicToken(env, uid);
    const resolved = await consumeMagicToken(env, tok);
    expect(resolved).toBe(uid);
    // Second consume must fail (token is used)
    expect(await consumeMagicToken(env, tok)).toBeNull();
  });

  it("consumeMagicToken returns null for unknown token", async () => {
    expect(await consumeMagicToken(env, "0".repeat(64))).toBeNull();
  });

  it("consumeMagicToken returns null for an expired token", async () => {
    const tok = await createMagicToken(env, uid);
    // Manually backdate expires_at to the past.
    await env.DB.prepare(
      "UPDATE magic_link_tokens SET expires_at = datetime('now', '-1 minute') WHERE token = ?"
    ).bind(tok).run();
    expect(await consumeMagicToken(env, tok)).toBeNull();
  });

  it("multiple tokens for the same user are independent", async () => {
    const t1 = await createMagicToken(env, uid);
    const t2 = await createMagicToken(env, uid);
    expect(t1).not.toBe(t2);
    // Consuming t1 does not affect t2.
    await consumeMagicToken(env, t1);
    expect(await consumeMagicToken(env, t2)).toBe(uid);
  });
});

describe("user sessions", () => {
  beforeEach(async () => {
    uid = await upsertUser(env, `sess-${Date.now()}@test.com`);
  });

  it("createSession returns a 64-char hex token", async () => {
    const tok = await createSession(env, uid);
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
  });

  it("getSessionUser resolves to { id, email } for a valid token", async () => {
    const tok = await createSession(env, uid);
    const user = await getSessionUser(env, tok);
    expect(user).not.toBeNull();
    expect(user.id).toBe(uid);
    expect(typeof user.email).toBe("string");
  });

  it("getSessionUser returns null for an unknown token", async () => {
    expect(await getSessionUser(env, "0".repeat(64))).toBeNull();
  });

  it("getSessionUser returns null for null", async () => {
    expect(await getSessionUser(env, null)).toBeNull();
  });

  it("getSessionUser returns null for an expired session", async () => {
    const tok = await createSession(env, uid);
    await env.DB.prepare(
      "UPDATE user_sessions SET expires_at = datetime('now', '-1 second') WHERE token = ?"
    ).bind(tok).run();
    expect(await getSessionUser(env, tok)).toBeNull();
  });

  it("deleteSession removes the session", async () => {
    const tok = await createSession(env, uid);
    await deleteSession(env, tok);
    expect(await getSessionUser(env, tok)).toBeNull();
  });

  it("deleteSession is a no-op on a null token", async () => {
    await expect(deleteSession(env, null)).resolves.toBeUndefined();
  });

  it("two sessions for the same user are independent", async () => {
    const t1 = await createSession(env, uid);
    const t2 = await createSession(env, uid);
    await deleteSession(env, t1);
    expect(await getSessionUser(env, t2)).not.toBeNull();
  });
});

describe("cookie helpers", () => {
  it("sessionCookieHeader contains the token and security flags", () => {
    const h = sessionCookieHeader("abc123");
    expect(h).toContain("ct_user=abc123");
    expect(h).toMatch(/Max-Age=\d+/);
    expect(h).toContain("HttpOnly");
    expect(h).toContain("Secure");
    expect(h).toContain("SameSite=Lax");
  });

  it("clearSessionCookieHeader sets Max-Age=0", () => {
    const h = clearSessionCookieHeader();
    expect(h).toContain("ct_user=");
    expect(h).toContain("Max-Age=0");
  });

  it("getUserSessionToken reads ct_user from parsed cookies", () => {
    const cookies = parseCookies("ct_user=tok123; other=val");
    expect(getUserSessionToken(cookies)).toBe("tok123");
  });

  it("getUserSessionToken returns null when cookie is absent", () => {
    expect(getUserSessionToken({})).toBeNull();
  });
});

describe("rate limiting", () => {
  it("allows requests below the limit", async () => {
    const ip = `192.0.2.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimit(env, ip)).toBe(true);
    }
  });

  it("blocks the 6th request from the same IP in the same window", async () => {
    const ip = `10.0.0.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < 5; i++) await checkRateLimit(env, ip);
    expect(await checkRateLimit(env, ip)).toBe(false);
  });

  it("different IPs have independent counters", async () => {
    const ipA = "172.16.0.1";
    const ipB = "172.16.0.2";
    for (let i = 0; i < 5; i++) await checkRateLimit(env, ipA);
    // ipA is exhausted, ipB should still pass
    expect(await checkRateLimit(env, ipB)).toBe(true);
  });

  it("allows all requests when ip is null (dev/test bypass)", async () => {
    for (let i = 0; i < 10; i++) {
      expect(await checkRateLimit(env, null)).toBe(true);
    }
  });

  it("cleanupOldRateLimits does not throw and removes nothing in current window", async () => {
    const ip = "198.51.100.1";
    await checkRateLimit(env, ip);
    await expect(cleanupOldRateLimits(env)).resolves.toBeUndefined();
    // Row in current bucket must survive.
    const { results } = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM auth_rate_limits WHERE window_key LIKE ?"
    ).bind(`${ip}:%`).all();
    expect(results[0].n).toBeGreaterThan(0);
  });

  it("cleanupOldRateLimits removes rows from old buckets", async () => {
    const oldBucket = Math.floor(Date.now() / (15 * 60 * 1000)) - 5;
    const staleKey = `203.0.113.1:${oldBucket}`;
    await env.DB.prepare(
      "INSERT INTO auth_rate_limits (window_key, count) VALUES (?, 3)"
    ).bind(staleKey).run();
    await cleanupOldRateLimits(env);
    const row = await env.DB.prepare(
      "SELECT * FROM auth_rate_limits WHERE window_key = ?"
    ).bind(staleKey).first();
    expect(row).toBeNull();
  });
});
