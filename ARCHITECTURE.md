# Architecture

CleanTech Index is a single Cloudflare Worker backed by one D1 (SQLite) database. It
server-renders HTML at the edge, meters anonymous access with a signed cookie, and sells
unlimited access through Stripe Checkout. There are **zero runtime dependencies** — Stripe
is spoken to over REST with `fetch`, and all crypto uses the runtime's Web Crypto.

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
| `src/render.js` | Streamed HTML views. Owns the exact `<title>` format and `FREE_LIMIT`. |
| `src/cookies.js` | HMAC-SHA256 signed cookies (Web Crypto), with optional `exp` enforcement. |
| `src/stripe.js` | Stripe REST (checkout create/retrieve) + webhook signature verification. No SDK. |
| `src/sitemap.js` | `sitemap.xml` + `robots.txt` generation from slugs. |

## Two key design decisions

**1. The meter is a signed cookie, not a database row.** Anonymous view counting has no
identity to key on, and a per-request D1 write would be wasteful. Instead the count lives in
an HMAC-signed `ct_views` cookie: tamper-proof (a user can't forge `v: 0`), stateless, and
free. The block fires when the stored count reaches `FREE_LIMIT` (3 spent → the 4th request
is over the line).

**2. Metered pages stay SEO-safe.** The project handler sets `Vary: Cookie` and
`Cache-Control: private, no-store`. Search crawlers arrive without cookies on every fetch, so
they always compute `views = 0` and receive the full page — the paywall only affects returning
humans. Hub pages (home, developer, sitemap) are `public` and edge-cacheable.

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

`energy_developers` 1─┬─* `infrastructure_projects` *─┬─* `hardware_vendors`
                      │                                │
                      └────────────── `project_hardware` (junction) ┘

`members` is written only by the verified webhook and is otherwise independent.

## Testing

Tests run inside real `workerd` via `@cloudflare/vitest-pool-workers`, against a real D1
binding with schema + seed applied per file (`readD1Migrations` → `applyD1Migrations`).
Coverage spans pure logic (cookies, Stripe signatures, sitemap, render), the query layer, every
route, the full 3-view→402 meter progression, member bypass, and the Stripe webhook + checkout
flow (outbound Stripe calls mocked). See `README.md` → Testing.
