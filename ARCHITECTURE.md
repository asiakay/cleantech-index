# Architecture

CleanTech Index is a single Cloudflare Worker backed by one D1 (SQLite) database. It
server-renders HTML at the edge, meters anonymous access with a signed cookie, sells
unlimited access through Stripe Checkout, and supports user accounts with saved data.
There are **zero runtime dependencies** — Stripe and Resend are spoken to over REST
with `fetch`, and all crypto uses the runtime's Web Crypto API.

## Request flow

```
                         ┌────────────────────────── Cloudflare Worker (src/index.js) ──────────────────────────┐
   GET /project/:slug    │  router → handleProject()                                                            │
        │                │     1. getProjectBySlug()  ──►  D1 (one JOIN + GROUP_CONCAT folds vendors)           │
        ▼                │     2. session_token cookie valid & paid?  ──► render unlimited (meter untouched)    │
   browser / crawler ───►│     3. else read signed ct_views cookie                                             │
        ▲                │        views ≥ 3  ──► 402 paywall                                                    │
        │                │        views < 3  ──► render + Set-Cookie(ct_views = signed(v+1)), Vary: Cookie      │
        └── HTML (streamed; <head> flushes first) ◄───────────────────────────────────────────────────────────┘
```

## Components

| File | Responsibility |
|------|----------------|
| `src/index.js` | Router + handlers. The only place that reads/writes cookies and sets headers. |
| `src/db.js` | Every SQL statement, parameterized. Single source of DB truth. |
| `src/auth.js` | Magic-link token lifecycle, user-session D1 CRUD, cookie helpers, rate limiting. |
| `src/email.js` | Resend REST call for magic-link emails. |
| `src/render.js` | Streamed HTML views. Owns the exact `<title>` format and `FREE_LIMIT`. |
| `src/cookies.js` | HMAC-SHA256 signed cookies (Web Crypto), with optional `exp` enforcement. |
| `src/stripe.js` | Stripe REST (checkout create/retrieve) + webhook signature verification. No SDK. |
| `src/sitemap.js` | `sitemap.xml` + `robots.txt` generation from slugs. |

## Two-session architecture

The Worker maintains **two independent session systems** that can coexist:

| Cookie | Backing store | Purpose |
|--------|---------------|---------|
| `session_token` | HMAC-signed, stateless | Stripe paid-member access (unlimited project views) |
| `ct_user` | D1 `user_sessions` table | Logged-in user identity (bookmarks, notes, watchlists, filters) |

A user can be simultaneously a paid Stripe member **and** logged in, or either one alone.
`handleProject` checks both: if `session_token` is valid and paid, the meter is skipped; if
`ct_user` is valid, user-specific UI (bookmark button, note textarea) is layered in.

## Auth flow: magic link

```
POST /auth/login
  │  validate email + rate-limit (5 req / IP / 15-min bucket in D1)
  │  upsertUser → INSERT OR IGNORE users
  │  createMagicToken → 32-byte random hex, 15-min TTL stored in magic_link_tokens
  │  sendMagicLink → Resend REST API
  └► 303 /login?sent=1

GET /auth/verify?token=<hex>
  │  consumeMagicToken → verify token, expiry, used=0; mark used=1
  │  createSession → 32-byte random hex, 30-day TTL stored in user_sessions
  │  ctx.waitUntil(cleanupOldRateLimits)  ← fire-and-forget after response
  └► 303 /dashboard   Set-Cookie: ct_user=<token>; HttpOnly; Secure; SameSite=Lax
```

**CSRF**: SameSite=Lax on `ct_user` prevents cross-site POST forgery without needing
explicit CSRF tokens. The paywall `session_token` uses the same mitigation.

## Rate limiting

Magic-link requests are limited to **5 per IP per 15-minute window**. Each row in
`auth_rate_limits` is keyed `"${ip}:${bucketId}"` where `bucketId =
floor(Date.now() / 900_000)`. A single `INSERT … ON CONFLICT DO UPDATE RETURNING count`
is atomic in SQLite. Old rows are pruned asynchronously in `ctx.waitUntil` after each
successful `/auth/verify` response.

## Key design decisions

**1. The view meter is a signed cookie, not a database row.** Anonymous view counting has
no identity to key on, and a per-request D1 write would be wasteful. Instead the count
lives in an HMAC-signed `ct_views` cookie: tamper-proof (a user can't forge `v: 0`),
stateless, and free. The block fires when the stored count reaches `FREE_LIMIT` (3 spent →
the 4th request is over the line).

**2. Metered pages stay SEO-safe.** The project handler sets `Vary: Cookie` and
`Cache-Control: private, no-store`. Search crawlers arrive without cookies on every fetch,
so they always compute `views = 0` and receive the full page — the paywall only affects
returning humans. Hub pages (home, developer, sitemap) are `public` and edge-cacheable,
**except when a user is logged in**, where they switch to `private, no-store`.

**3. No ORM, no query builder.** Every SQL statement is in `src/db.js`, parameterized
with `?` placeholders. There is no string interpolation into SQL anywhere in the codebase.

## Payment model

Access is granted by a signed `session_token` cookie carrying `{ paid: true, exp }`. It is
minted in two places that agree:

- **`GET /unlock/success`** — after Checkout, Stripe redirects here with `session_id`. The
  Worker retrieves the session server-side, confirms `payment_status === "paid"`, and mints the
  cookie. This gives the buyer immediate access on their device.
- **`POST /webhook/stripe`** — the durable source of truth. The Worker verifies the Stripe
  signature (HMAC-SHA256 over `{timestamp}.{rawBody}`, v1 scheme only, 300s replay tolerance,
  constant-time compare) and records the member in D1 (`INSERT OR IGNORE`, idempotent on
  `stripe_session_id`).

The cookie is the fast, stateless access credential at the edge; the `members` table is the
audit trail and powers `/account`-style lookups.

## Data model

```
energy_developers 1─┬─* infrastructure_projects *─┬─* hardware_vendors
                    │                              │
                    └────── project_hardware ───────┘   (junction)

members          (Stripe member audit log)

users 1─┬─* magic_link_tokens   (one-time 15-min login tokens)
         ├─* user_sessions       (30-day HttpOnly session tokens)
         ├─* bookmarks           (project_slug, unique per user)
         ├─* watchlists 1─* watchlist_items
         ├─* project_notes       (one note per user+project, upserted)
         └─* saved_filters       (named JSON snapshots of filter params)

auth_rate_limits  (ephemeral per-IP 15-min buckets; pruned async)
```

## CI / secrets management

Secrets are stored in **GitHub Actions secrets** and synced to Cloudflare on every deploy.
The workflow (`ci.yml`) passes secrets exclusively via `env:` fields in each step — never
via inline `${{ secrets.X }}` interpolation inside `run:` blocks, which evaluates to an
empty string when a secret is absent and would silently overwrite the real value.

A "Validate required secrets" step runs before any Cloudflare interaction and fails fast
if `SIGNING_SECRET` or `RESEND_API_KEY` are missing, ensuring no empty value is ever
uploaded. Optional Stripe secrets are guarded by `[ -n "$VAR" ] && ...` in the same step.

## Testing

Tests run inside real `workerd` via `@cloudflare/vitest-pool-workers`, against a real D1
binding with schema + seed applied per file (`readD1Migrations` → `applyD1Migrations`).
Coverage spans:

| File | What it covers |
|------|----------------|
| `test/unit.spec.js` | Signed cookies, Stripe sigs, sitemap, all render functions including auth views, XSS guards |
| `test/db.spec.js` | Core query layer (projects, developers, members) |
| `test/db-user.spec.js` | All user-data DB functions: bookmarks, watchlists, notes, filters, dashboard aggregate |
| `test/auth.spec.js` | upsertUser, magic token lifecycle, session CRUD, cookie helpers, rate limiting |
| `test/routes.spec.js` | All core routes, 3-view meter, member bypass, Stripe unlock flow (fetch mocked) |
| `test/routes-auth.spec.js` | Auth routes, data mutation routes, XSS guard on user content in HTML |
| `test/stripe.spec.js` | Stripe webhook + checkout flow (fetch mocked) |
