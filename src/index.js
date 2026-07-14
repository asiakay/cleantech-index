// index.js — CleanTech Index edge engine.
// Cloudflare Worker (ES modules) + D1. No runtime dependencies.
//
// Bindings (see wrangler.toml / .dev.vars):
//   env.DB                    -> D1 database binding (required)
//   env.SIGNING_SECRET        -> HMAC secret for signed cookies (required)
//   env.STRIPE_SECRET_KEY     -> Stripe API key           (optional; /unlock returns 501 without it)
//   env.STRIPE_WEBHOOK_SECRET -> whsec_ signing secret     (optional; webhook returns 501 without it)
//   env.STRIPE_PRICE_ID       -> price to charge           (optional; falls back to STRIPE_UNLOCK_AMOUNT_CENTS)
//   env.PUBLIC_ORIGIN         -> canonical origin override (optional; else request origin)
//   env.MEMBER_TOKEN_TTL_DAYS -> member cookie lifetime    (optional; default 365)
//   env.RESEND_API_KEY        -> Resend API key            (required for magic-link login)
//   env.EMAIL_FROM            -> From address for magic links (optional; defaults to noreply@cleantech-index.com)

import { parseCookies, serializeCookie, signPayload, verifyPayload } from "./cookies.js";
import {
  renderProjectPage,
  renderDeveloperPage,
  renderPaywall,
  renderHome,
  renderAccount,
  renderLogin,
  renderDashboard,
  renderSaveFilterForm,
  renderNotFound,
  FREE_LIMIT,
} from "./render.js";
import {
  getProjectBySlug,
  getDeveloperBySlug,
  getFeaturedProjects,
  getAllSlugs,
  recordMember,
  toggleBookmark,
  isBookmarked,
  getUserWatchlists,
  createWatchlist,
  deleteWatchlist,
  toggleWatchlistItem,
  saveNote,
  getNote,
  getDashboardData,
  saveFilter,
  deleteFilter,
} from "./db.js";
import {
  verifyStripeSignature,
  createCheckoutSession,
  retrieveCheckoutSession,
} from "./stripe.js";
import { renderSitemap, renderRobots } from "./sitemap.js";
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
} from "./auth.js";
import { sendMagicLink } from "./email.js";

const VIEW_COOKIE = "ct_views";
const SESSION_COOKIE = "session_token";

const html = (chunks, { status = 200, headers = {} } = {}) => {
  const encoder = new TextEncoder();
  const it = chunks[Symbol.iterator]();
  const body = new ReadableStream({
    pull(controller) {
      const { value, done } = it.next();
      if (done) return controller.close();
      controller.enqueue(encoder.encode(value));
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
};

const text = (body, status = 200, headers = {}) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } });

const publicOrigin = (url, env) => env.PUBLIC_ORIGIN || url.origin;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();
    const origin = publicOrigin(url, env);

    if (!env.SIGNING_SECRET) return text("Server misconfigured: SIGNING_SECRET is not set.", 500);

    try {
      if (path === "/health") return text("ok");
      if (path === "/" && method === "GET") return handleHome(request, env, url);
      if (path === "/robots.txt" && method === "GET")
        return text(renderRobots(origin), 200, { "cache-control": "public, max-age=86400" });
      if (path === "/sitemap.xml" && method === "GET") return handleSitemap(env, origin);
      if (path === "/account" && method === "GET") return handleAccount(request, env);

      // Auth — magic link
      if (path === "/login" && method === "GET") return handleLoginPage(request, url);
      if (path === "/auth/login" && method === "POST") return handleAuthLogin(request, env, origin);
      if (path === "/auth/verify" && method === "GET") return handleAuthVerify(url, env, origin, ctx);
      if (path === "/auth/logout" && method === "POST") return handleAuthLogout(request, env, origin);

      // User dashboard
      if (path === "/dashboard" && method === "GET") return handleDashboard(request, env, origin);

      // Bookmarks
      if (path === "/bookmarks" && method === "POST") return handleToggleBookmark(request, env, origin);

      // Watchlists
      if (path === "/watchlists" && method === "POST") return handleCreateWatchlist(request, env, origin);
      if (path === "/watchlists/add" && method === "POST") return handleAddToWatchlist(request, env, origin);
      const wlDel = path.match(/^\/watchlists\/(\d+)\/delete$/);
      if (wlDel && method === "POST") return handleDeleteWatchlist(wlDel[1], request, env, origin);

      // Notes
      const noteSlug = path.match(/^\/notes\/([a-z0-9-]+)$/i);
      if (noteSlug && method === "POST") return handleSaveNote(noteSlug[1], request, env, origin);

      // Saved filters
      if (path === "/saved-filters" && method === "POST") return handleSaveFilterPrompt(request, env, origin);
      if (path === "/saved-filters/confirm" && method === "POST") return handleSaveFilterConfirm(request, env, origin);
      const filterDel = path.match(/^\/saved-filters\/(\d+)\/delete$/);
      if (filterDel && method === "POST") return handleDeleteFilter(filterDel[1], request, env, origin);

      // Stripe unlock flow
      if (path === "/unlock" && method === "GET") return handleUnlock(url, env);
      if (path === "/unlock/success" && method === "GET") return handleUnlockSuccess(url, env);
      if (path === "/unlock/cancel" && method === "GET") return Response.redirect(`${origin}/`, 303);
      if (path === "/webhook/stripe" && method === "POST") return handleStripeWebhook(request, env);

      const proj = path.match(/^\/project\/([a-z0-9-]+)$/i);
      if (proj && method === "GET") return handleProject(proj[1], request, env, origin);

      const dev = path.match(/^\/developer\/([a-z0-9-]+)$/i);
      if (dev && method === "GET") return handleDeveloper(dev[1], env, origin);

      return html(renderNotFound(origin).chunks, { status: 404 });
    } catch (err) {
      // Never leak internals; log for the operator.
      console.error("unhandled", err);
      return text("Internal error", 500);
    }
  },
};

const VALID_SORTS = new Set(["capacity", "status", "technology", "state", "name"]);
const VALID_DIRS  = new Set(["asc", "desc"]);

const VALID_STATUSES = new Set(["Operational", "Under Construction", "Planned"]);

async function handleHome(request, env, url) {
  const page   = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const sort   = VALID_SORTS.has(url.searchParams.get("sort")) ? url.searchParams.get("sort") : "capacity";
  const dir    = VALID_DIRS.has(url.searchParams.get("dir"))   ? url.searchParams.get("dir")  : "desc";
  const status = VALID_STATUSES.has(url.searchParams.get("status")) ? url.searchParams.get("status") : "";
  const user   = await resolveUser(request, env);
  const data   = await getFeaturedProjects(env, page, 20, sort, dir, status);
  const cacheControl = user ? "private, no-store" : "public, max-age=300";
  return html(renderHome(data, user).chunks, { headers: { "cache-control": cacheControl } });
}

async function handleSitemap(env, origin) {
  const slugs = await getAllSlugs(env);
  return new Response(renderSitemap(origin, slugs), {
    status: 200,
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

async function handleDeveloper(slug, env, origin) {
  const data = await getDeveloperBySlug(env, slug);
  if (!data) return html(renderNotFound(origin).chunks, { status: 404 });
  return html(renderDeveloperPage(data.dev, data.projects, origin).chunks, {
    headers: { "cache-control": "public, max-age=300" },
  });
}

async function handleAccount(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const session = await verifyPayload(env.SIGNING_SECRET, cookies[SESSION_COOKIE]);
  const isMember = !!(session && session.paid === true);
  return html(renderAccount(isMember, session).chunks, { headers: { "cache-control": "private, no-store" } });
}

/** Resolve the logged-in user from ct_user session cookie. Returns user row or null. */
async function resolveUser(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const token = getUserSessionToken(cookies);
  return getSessionUser(env, token);
}

// Metered project page — the core of the paywall.
async function handleProject(slug, request, env, origin) {
  const project = await getProjectBySlug(env, slug);
  if (!project) return html(renderNotFound(origin).chunks, { status: 404 });

  const cookies = parseCookies(request.headers.get("Cookie"));
  const user = await resolveUser(request, env);

  const session = await verifyPayload(env.SIGNING_SECRET, cookies[SESSION_COOKIE]);
  if (session && session.paid === true) {
    // Member: unlimited, meter untouched.
    const userCtx = user ? await buildUserProjectCtx(env, user, slug) : null;
    return html(renderProjectPage(project, project.vendors, null, origin, userCtx).chunks, {
      headers: { "cache-control": "private, no-store" },
    });
  }

  const viewData = await verifyPayload(env.SIGNING_SECRET, cookies[VIEW_COOKIE]);
  const views = viewData && Number.isInteger(viewData.v) && viewData.v >= 0 ? viewData.v : 0;

  // Absolute block: once FREE_LIMIT views are spent, this request is over the line → paywall.
  if (views >= FREE_LIMIT) {
    return html(renderPaywall(origin).chunks, { status: 402, headers: { "cache-control": "private, no-store" } });
  }

  // Allowed view → consume one and re-sign the incremented count.
  const newViews = views + 1;
  const token = await signPayload(env.SIGNING_SECRET, { v: newViews });
  const userCtx = user ? await buildUserProjectCtx(env, user, slug) : null;
  return html(renderProjectPage(project, project.vendors, FREE_LIMIT - newViews, origin, userCtx).chunks, {
    headers: {
      "set-cookie": serializeCookie(VIEW_COOKIE, token),
      // Bots arrive cookieless each fetch (views=0), so the page stays crawlable.
      vary: "Cookie",
      "cache-control": "private, no-store",
    },
  });
}

async function buildUserProjectCtx(env, user, slug) {
  const [bookmarked, note, watchlists] = await Promise.all([
    isBookmarked(env, user.id, slug),
    getNote(env, user.id, slug),
    getUserWatchlists(env, user.id),
  ]);
  return { user, bookmarked, note, watchlists };
}

async function handleUnlock(url, env) {
  if (!env.STRIPE_SECRET_KEY) return text("Payments not configured.", 501);
  const origin = publicOrigin(url, env);
  const session = await createCheckoutSession(env, {
    successUrl: `${origin}/unlock/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/unlock/cancel`,
  });
  return Response.redirect(session.url, 303);
}

async function handleUnlockSuccess(url, env) {
  if (!env.STRIPE_SECRET_KEY) return text("Payments not configured.", 501);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return text("Missing session_id.", 400);

  const session = await retrieveCheckoutSession(env, sessionId);
  if (session.payment_status !== "paid") return text("Payment not completed.", 402);

  const ttlDays = parseInt(env.MEMBER_TOKEN_TTL_DAYS || "365", 10);
  const exp = Math.floor(Date.now() / 1000) + ttlDays * 86400;
  const token = await signPayload(env.SIGNING_SECRET, {
    paid: true,
    sub: session.customer_details?.email || session.customer || null,
    exp,
  });

  const headers = new Headers({ Location: `${publicOrigin(url, env)}/` });
  headers.append("Set-Cookie", serializeCookie(SESSION_COOKIE, token, { maxAge: ttlDays * 86400 }));
  return new Response(null, { status: 303, headers });
}

// ─── Auth handlers ───────────────────────────────────────────────────────────

function handleLoginPage(request, url) {
  const sent = url.searchParams.get("sent") === "1";
  const flash = url.searchParams.get("flash") || null;
  return html(renderLogin({ sent, flash }).chunks, { headers: { "cache-control": "private, no-store" } });
}

async function handleAuthLogin(request, env, origin) {
  if (!env.RESEND_API_KEY) return text("Email not configured (RESEND_API_KEY missing).", 501);

  const form = await request.formData();
  const raw = (form.get("email") || "").toString().trim().toLowerCase();

  if (!raw || !raw.includes("@")) {
    return html(renderLogin({ error: "Please enter a valid email address." }).chunks, {
      status: 400,
      headers: { "cache-control": "private, no-store" },
    });
  }

  const ip = request.headers.get("CF-Connecting-IP");
  const allowed = await checkRateLimit(env, ip);
  if (!allowed) {
    return html(renderLogin({ error: "Too many sign-in attempts. Please wait 15 minutes and try again." }).chunks, {
      status: 429,
      headers: { "cache-control": "private, no-store", "Retry-After": "900" },
    });
  }

  const userId = await upsertUser(env, raw);
  const token = await createMagicToken(env, userId);
  const magicUrl = `${origin}/auth/verify?token=${encodeURIComponent(token)}`;

  try {
    await sendMagicLink(env, { to: raw, magicUrl });
  } catch (err) {
    console.error("sendMagicLink failed", err);
    return html(renderLogin({ error: "Failed to send email. Please try again." }).chunks, {
      status: 500,
      headers: { "cache-control": "private, no-store" },
    });
  }

  return Response.redirect(`${origin}/login?sent=1`, 303);
}

async function handleAuthVerify(url, env, origin, ctx) {
  const token = url.searchParams.get("token") || "";
  const userId = await consumeMagicToken(env, token);

  if (!userId) {
    return html(
      renderLogin({ error: "This sign-in link is invalid or has expired. Please request a new one." }).chunks,
      { status: 400, headers: { "cache-control": "private, no-store" } }
    );
  }

  const sessionToken = await createSession(env, userId);
  // Prune old rate-limit rows after the response is sent — fire-and-forget.
  ctx.waitUntil(cleanupOldRateLimits(env));
  const headers = new Headers({ Location: `${origin}/dashboard` });
  headers.append("Set-Cookie", sessionCookieHeader(sessionToken));
  return new Response(null, { status: 303, headers });
}

async function handleAuthLogout(request, env, origin) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const token = getUserSessionToken(cookies);
  await deleteSession(env, token);
  const headers = new Headers({ Location: `${origin}/` });
  headers.append("Set-Cookie", clearSessionCookieHeader());
  return new Response(null, { status: 303, headers });
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function handleDashboard(request, env, origin) {
  const user = await resolveUser(request, env);
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const data = await getDashboardData(env, user.id);
  const flash = new URL(request.url).searchParams.get("flash") || null;
  return html(renderDashboard(user, data, flash).chunks, { headers: { "cache-control": "private, no-store" } });
}

// ─── Bookmark ────────────────────────────────────────────────────────────────

async function handleToggleBookmark(request, env, origin) {
  const user = await resolveUser(request, env);
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const form = await request.formData();
  const slug = (form.get("slug") || "").toString().trim();
  if (!slug) return text("Missing slug.", 400);
  await toggleBookmark(env, user.id, slug);
  const ref = request.headers.get("Referer") || `${origin}/project/${slug}`;
  return Response.redirect(ref, 303);
}

// ─── Watchlists ──────────────────────────────────────────────────────────────

async function handleCreateWatchlist(request, env, origin) {
  const user = await resolveUser(request, env);
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const form = await request.formData();
  const name = (form.get("name") || "").toString().trim().slice(0, 80);
  if (!name) return Response.redirect(`${origin}/dashboard`, 303);
  await createWatchlist(env, user.id, name);
  return Response.redirect(`${origin}/dashboard?flash=${encodeURIComponent("Watchlist created.")}`, 303);
}

async function handleAddToWatchlist(request, env, origin) {
  const user = await resolveUser(request, env);
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const form = await request.formData();
  const slug = (form.get("slug") || "").toString().trim();
  const watchlistId = parseInt(form.get("watchlist_id") || "0", 10);
  if (!slug || !watchlistId) return text("Missing fields.", 400);
  await toggleWatchlistItem(env, user.id, watchlistId, slug);
  const ref = request.headers.get("Referer") || `${origin}/project/${slug}`;
  return Response.redirect(ref, 303);
}

async function handleDeleteWatchlist(idStr, request, env, origin) {
  const user = await resolveUser(request, env);
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const id = parseInt(idStr, 10);
  if (!id) return text("Invalid id.", 400);
  await deleteWatchlist(env, user.id, id);
  return Response.redirect(`${origin}/dashboard?flash=${encodeURIComponent("Watchlist deleted.")}`, 303);
}

// ─── Notes ───────────────────────────────────────────────────────────────────

async function handleSaveNote(slug, request, env, origin) {
  const user = await resolveUser(request, env);
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const form = await request.formData();
  const note = (form.get("note") || "").toString().slice(0, 4000);
  await saveNote(env, user.id, slug, note);
  const ref = request.headers.get("Referer") || `${origin}/project/${slug}`;
  return Response.redirect(ref, 303);
}

// ─── Saved filters ───────────────────────────────────────────────────────────

async function handleSaveFilterPrompt(request, env, origin) {
  const user = await resolveUser(request, env);
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const form = await request.formData();
  const params = {};
  for (const key of ["sort", "dir", "status", "page"]) {
    const v = (form.get(key) || "").toString();
    if (v) params[key] = v;
  }
  return html(renderSaveFilterForm(user, params).chunks, { headers: { "cache-control": "private, no-store" } });
}

async function handleSaveFilterConfirm(request, env, origin) {
  const user = await resolveUser(request, env);
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const form = await request.formData();
  const name = (form.get("name") || "").toString().trim().slice(0, 60);
  if (!name) return Response.redirect(`${origin}/dashboard`, 303);
  const params = {};
  for (const key of ["sort", "dir", "status", "page"]) {
    const v = (form.get(key) || "").toString();
    if (v) params[key] = v;
  }
  await saveFilter(env, user.id, name, JSON.stringify(params));
  return Response.redirect(`${origin}/dashboard?flash=${encodeURIComponent(`Filter "${name}" saved.`)}`, 303);
}

async function handleDeleteFilter(idStr, request, env, origin) {
  const user = await resolveUser(request, env);
  if (!user) return Response.redirect(`${origin}/login`, 303);
  const id = parseInt(idStr, 10);
  if (!id) return text("Invalid id.", 400);
  await deleteFilter(env, user.id, id);
  return Response.redirect(`${origin}/dashboard?flash=${encodeURIComponent("Filter removed.")}`, 303);
}

// ─── Stripe ──────────────────────────────────────────────────────────────────

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) return text("Webhook not configured.", 501);

  const raw = await request.text(); // exact raw bytes — required for signature verification
  const sig = request.headers.get("Stripe-Signature");
  const result = await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, raw, sig);
  if (!result.ok) return text(`Signature verification failed: ${result.reason}`, 400);

  const event = result.event;
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    await recordMember(env, {
      email: s.customer_details?.email || null,
      stripeCustomerId: s.customer || null,
      stripeSessionId: s.id,
    });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
