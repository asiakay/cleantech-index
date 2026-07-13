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

import { parseCookies, serializeCookie, signPayload, verifyPayload } from "./cookies.js";
import {
  renderProjectPage,
  renderDeveloperPage,
  renderPaywall,
  renderHome,
  renderAccount,
  renderNotFound,
  FREE_LIMIT,
} from "./render.js";
import {
  getProjectBySlug,
  getDeveloperBySlug,
  getFeaturedProjects,
  getAllSlugs,
  recordMember,
} from "./db.js";
import {
  verifyStripeSignature,
  createCheckoutSession,
  retrieveCheckoutSession,
} from "./stripe.js";
import { renderSitemap, renderRobots } from "./sitemap.js";

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
      if (path === "/" && method === "GET") return handleHome(env);
      if (path === "/robots.txt" && method === "GET")
        return text(renderRobots(origin), 200, { "cache-control": "public, max-age=86400" });
      if (path === "/sitemap.xml" && method === "GET") return handleSitemap(env, origin);
      if (path === "/account" && method === "GET") return handleAccount(request, env);

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

async function handleHome(env) {
  const data = await getFeaturedProjects(env);
  return html(renderHome(data).chunks, {
    headers: { "cache-control": "public, max-age=300" },
  });
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

// Metered project page — the core of the paywall.
async function handleProject(slug, request, env, origin) {
  const project = await getProjectBySlug(env, slug);
  if (!project) return html(renderNotFound(origin).chunks, { status: 404 });

  const cookies = parseCookies(request.headers.get("Cookie"));

  const session = await verifyPayload(env.SIGNING_SECRET, cookies[SESSION_COOKIE]);
  if (session && session.paid === true) {
    // Member: unlimited, meter untouched.
    return html(renderProjectPage(project, project.vendors, null, origin).chunks, {
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
  return html(renderProjectPage(project, project.vendors, FREE_LIMIT - newViews, origin).chunks, {
    headers: {
      "set-cookie": serializeCookie(VIEW_COOKIE, token),
      // Bots arrive cookieless each fetch (views=0), so the page stays crawlable.
      vary: "Cookie",
      "cache-control": "private, no-store",
    },
  });
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
