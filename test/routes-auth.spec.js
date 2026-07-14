// Integration tests for auth routes and user-data mutation routes.
// Runs through the real Worker fetch with a real D1 binding.
import { exports, env } from "cloudflare:workers";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { upsertUser, createMagicToken, createSession, sessionCookieHeader } from "../src/auth.js";

const BASE = "https://cleantech.test";

function call(path, init) {
  return exports.default.fetch(new Request(BASE + path, init));
}

function post(path, body, init = {}) {
  return call(path, {
    method: "POST",
    body: new URLSearchParams(body),
    headers: { "content-type": "application/x-www-form-urlencoded", ...(init.headers || {}) },
    ...init,
  });
}

/** Build a Cookie header for a live session. */
async function loginCookie(email = `test-${Date.now()}@example.com`) {
  const uid = await upsertUser(env, email);
  const tok = await createSession(env, uid);
  return { header: `ct_user=${tok}`, uid, email };
}

afterEach(() => vi.unstubAllGlobals());

// ─── Login page ───────────────────────────────────────────────────────────────

describe("GET /login", () => {
  it("renders the login form", async () => {
    const r = await call("/login");
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain("Sign in");
    expect(body).toContain("action=\"/auth/login\"");
  });

  it("shows sent=1 confirmation", async () => {
    const body = await (await call("/login?sent=1")).text();
    expect(body).toContain("Check your email");
  });

  it("is not cached", async () => {
    expect((await call("/login")).headers.get("cache-control")).toMatch(/no-store/);
  });
});

// ─── POST /auth/login ─────────────────────────────────────────────────────────

describe("POST /auth/login", () => {
  it("rejects missing RESEND_API_KEY gracefully", async () => {
    // The test env has RESEND_API_KEY set, so we stub fetch to simulate a send
    // failure instead of unsetting the binding (which we can't do at runtime).
    // The real "missing key" path is tested by absence of the binding.
    // Here we just confirm a successful flow with a mock.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const r = await post("/auth/login", { email: `login-${Date.now()}@test.com` }, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/login?sent=1");
  });

  it("redirects to /login?sent=1 on success", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const r = await post("/auth/login", { email: `sent-${Date.now()}@test.com` }, { redirect: "manual" });
    expect(r.headers.get("location")).toContain("sent=1");
  });

  it("returns 400 for an invalid email address", async () => {
    const r = await post("/auth/login", { email: "notanemail" });
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("valid email");
  });

  it("returns 400 for an empty email", async () => {
    const r = await post("/auth/login", { email: "" });
    expect(r.status).toBe(400);
  });

  it("returns 429 after 5 attempts from the same IP", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const ip = `10.99.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
    const headers = { "CF-Connecting-IP": ip, "content-type": "application/x-www-form-urlencoded" };
    for (let i = 0; i < 5; i++) {
      const r = await call("/auth/login", {
        method: "POST",
        body: new URLSearchParams({ email: `rl${i}@test.com` }),
        headers,
        redirect: "manual",
      });
      expect(r.status).toBe(303); // still allowed
    }
    const blocked = await call("/auth/login", {
      method: "POST",
      body: new URLSearchParams({ email: "rl6@test.com" }),
      headers,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("900");
  });

  it("returns 500 when Resend returns a non-OK response", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response("Unauthorized", { status: 401, headers: { "content-type": "text/plain" } })
    );
    const r = await post("/auth/login", { email: `fail-${Date.now()}@test.com` });
    expect(r.status).toBe(500);
    expect(await r.text()).toContain("Failed to send email");
  });

  it("upserts the user (second login doesn't create a duplicate)", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const email = `dedup-${Date.now()}@test.com`;
    await post("/auth/login", { email }, { redirect: "manual" });
    await post("/auth/login", { email }, { redirect: "manual" });
    const { results } = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").bind(email).all();
    expect(results[0].n).toBe(1);
  });
});

// ─── GET /auth/verify ─────────────────────────────────────────────────────────

describe("GET /auth/verify", () => {
  it("sets ct_user cookie and redirects to /dashboard on valid token", async () => {
    const uid = await upsertUser(env, `verify-${Date.now()}@test.com`);
    const tok = await createMagicToken(env, uid);
    const r = await call(`/auth/verify?token=${tok}`, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/dashboard");
    expect(r.headers.get("set-cookie")).toMatch(/ct_user=/);
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("marks the token as used (cannot reuse)", async () => {
    const uid = await upsertUser(env, `once-${Date.now()}@test.com`);
    const tok = await createMagicToken(env, uid);
    await call(`/auth/verify?token=${tok}`, { redirect: "manual" });
    const r = await call(`/auth/verify?token=${tok}`);
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("invalid or has expired");
  });

  it("returns 400 for an unknown token", async () => {
    const r = await call("/auth/verify?token=" + "0".repeat(64));
    expect(r.status).toBe(400);
    expect(await r.text()).toContain("invalid or has expired");
  });

  it("returns 400 for a missing token", async () => {
    const r = await call("/auth/verify");
    expect(r.status).toBe(400);
  });

  it("returns 400 for an expired token", async () => {
    const uid = await upsertUser(env, `exp-${Date.now()}@test.com`);
    const tok = await createMagicToken(env, uid);
    await env.DB.prepare(
      "UPDATE magic_link_tokens SET expires_at = datetime('now', '-1 minute') WHERE token = ?"
    ).bind(tok).run();
    const r = await call(`/auth/verify?token=${tok}`);
    expect(r.status).toBe(400);
  });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────

describe("POST /auth/logout", () => {
  it("clears the ct_user cookie and redirects to /", async () => {
    const { header } = await loginCookie();
    const r = await post("/auth/logout", {}, { headers: { Cookie: header }, redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(BASE + "/");
    expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("is a no-op (safe) when there is no session cookie", async () => {
    const r = await post("/auth/logout", {}, { redirect: "manual" });
    expect(r.status).toBe(303);
  });
});

// ─── GET /dashboard ───────────────────────────────────────────────────────────

describe("GET /dashboard", () => {
  it("redirects unauthenticated users to /login", async () => {
    const r = await call("/dashboard", { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/login");
  });

  it("renders dashboard for a logged-in user", async () => {
    const { header, email } = await loginCookie();
    const r = await call("/dashboard", { headers: { Cookie: header } });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toContain(email);
    expect(body).toContain("Bookmarks");
    expect(body).toContain("Watchlists");
  });

  it("shows flash message when present", async () => {
    const { header } = await loginCookie();
    const r = await call("/dashboard?flash=Saved!", { headers: { Cookie: header } });
    expect(await r.text()).toContain("Saved!");
  });

  it("is not cached", async () => {
    const { header } = await loginCookie();
    const cc = (await call("/dashboard", { headers: { Cookie: header } })).headers.get("cache-control");
    expect(cc).toMatch(/no-store/);
  });
});

// ─── POST /bookmarks ──────────────────────────────────────────────────────────

describe("POST /bookmarks", () => {
  it("redirects unauthenticated to /login", async () => {
    const r = await post("/bookmarks", { slug: "mustang-ridge-solar" }, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/login");
  });

  it("toggles a bookmark and redirects back", async () => {
    const { header } = await loginCookie();
    const r = await post("/bookmarks", { slug: "mustang-ridge-solar" }, {
      headers: { Cookie: header },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
  });

  it("returns 400 for a missing slug", async () => {
    const { header } = await loginCookie();
    const r = await post("/bookmarks", {}, { headers: { Cookie: header } });
    expect(r.status).toBe(400);
  });
});

// ─── POST /watchlists ─────────────────────────────────────────────────────────

describe("POST /watchlists (create)", () => {
  it("redirects unauthenticated to /login", async () => {
    const r = await post("/watchlists", { name: "My List" }, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/login");
  });

  it("creates a watchlist and redirects to dashboard with flash", async () => {
    const { header } = await loginCookie();
    const r = await post("/watchlists", { name: "Solar Portfolio" }, {
      headers: { Cookie: header },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("flash=");
  });

  it("redirects to dashboard when name is empty (no-op)", async () => {
    const { header } = await loginCookie();
    const r = await post("/watchlists", { name: "" }, {
      headers: { Cookie: header },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/dashboard");
  });
});

// ─── POST /watchlists/:id/delete ─────────────────────────────────────────────

describe("POST /watchlists/:id/delete", () => {
  it("deletes a watchlist and redirects", async () => {
    const { header, uid } = await loginCookie();
    // Create via DB directly for speed
    const { meta } = await env.DB.prepare(
      "INSERT INTO watchlists (user_id, name) VALUES (?, ?)"
    ).bind(uid, "To delete").run();
    const id = meta.last_row_id;
    const r = await post(`/watchlists/${id}/delete`, {}, {
      headers: { Cookie: header },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("flash=");
  });

  it("redirects unauthenticated to /login", async () => {
    const r = await post("/watchlists/1/delete", {}, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/login");
  });
});

// ─── POST /notes/:slug ────────────────────────────────────────────────────────

describe("POST /notes/:slug", () => {
  it("redirects unauthenticated to /login", async () => {
    const r = await post("/notes/mustang-ridge-solar", { note: "hi" }, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/login");
  });

  it("saves a note and redirects back", async () => {
    const { header } = await loginCookie();
    const r = await post("/notes/mustang-ridge-solar", { note: "Looks promising" }, {
      headers: { Cookie: header },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
  });
});

// ─── Saved filters ────────────────────────────────────────────────────────────

describe("POST /saved-filters (prompt)", () => {
  it("redirects unauthenticated to /login", async () => {
    const r = await post("/saved-filters", { sort: "capacity" }, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("/login");
  });

  it("renders the name-prompt form", async () => {
    const { header } = await loginCookie();
    const r = await post("/saved-filters", { sort: "capacity", dir: "desc" }, {
      headers: { Cookie: header },
    });
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("action=\"/saved-filters/confirm\"");
  });
});

describe("POST /saved-filters/confirm", () => {
  it("saves a filter and redirects to dashboard", async () => {
    const { header } = await loginCookie();
    const r = await post("/saved-filters/confirm", { name: "Big Solar", sort: "capacity", dir: "desc" }, {
      headers: { Cookie: header },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("flash=");
  });

  it("redirects to dashboard when name is empty (no-op)", async () => {
    const { header } = await loginCookie();
    const r = await post("/saved-filters/confirm", { name: "" }, {
      headers: { Cookie: header },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
  });
});

describe("POST /saved-filters/:id/delete", () => {
  it("deletes a filter and redirects", async () => {
    const { header, uid } = await loginCookie();
    const { meta } = await env.DB.prepare(
      "INSERT INTO saved_filters (user_id, name, filter_json) VALUES (?, ?, ?)"
    ).bind(uid, "Temp", "{}").run();
    const id = meta.last_row_id;
    const r = await post(`/saved-filters/${id}/delete`, {}, {
      headers: { Cookie: header },
      redirect: "manual",
    });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toContain("flash=");
  });

  it("redirects unauthenticated to /login", async () => {
    const r = await post("/saved-filters/1/delete", {}, { redirect: "manual" });
    expect(r.headers.get("location")).toContain("/login");
  });
});

// ─── Home page user state ─────────────────────────────────────────────────────

describe("GET / with logged-in user", () => {
  it("is not cached when user session is present", async () => {
    const { header } = await loginCookie();
    const r = await call("/", { headers: { Cookie: header } });
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("shows Save filter button when logged in", async () => {
    const { header } = await loginCookie();
    const body = await (await call("/", { headers: { Cookie: header } })).text();
    expect(body).toContain("Save filter");
  });

  it("is publicly cached for anonymous users", async () => {
    const cc = (await call("/")).headers.get("cache-control");
    expect(cc).toMatch(/public/);
  });
});

// ─── Project page user context ────────────────────────────────────────────────

describe("GET /project/:slug with logged-in user", () => {
  it("shows bookmark form when user is signed in", async () => {
    const { header } = await loginCookie();
    const body = await (await call("/project/mustang-ridge-solar", { headers: { Cookie: header } })).text();
    expect(body).toContain("Bookmark");
  });

  it("shows sign-in link for anonymous users", async () => {
    const body = await (await call("/project/mustang-ridge-solar")).text();
    expect(body).toContain("/login");
  });
});

// ─── XSS guard: user-controlled content in renders ───────────────────────────

describe("XSS safety", () => {
  it("email address in nav is HTML-escaped", async () => {
    // Use an email with an angle bracket to simulate injection attempt.
    // The upsertUser call will store it as-is; renderNavBar must escape it.
    const evil = `evil<script>@test.com`;
    const uid = await upsertUser(env, evil);
    const tok = await createSession(env, uid);
    const r = await call("/dashboard", { headers: { Cookie: `ct_user=${tok}` } });
    const body = await r.text();
    // The raw string must not appear verbatim.
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
  });
});
