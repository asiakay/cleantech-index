# CleanTech Index

A programmatic-SEO directory of U.S. clean energy infrastructure — solar, wind, and battery
storage projects, their developers, and hardware suppliers — running as a single **Cloudflare
Worker + D1** app.

- **Zero runtime dependencies.** Server-rendered HTML (streamed so `<head>` reaches crawlers
  first). Stripe over REST via `fetch`; all crypto via Web Crypto.
- **3-view metered paywall** enforced with an HMAC-signed cookie — tamper-proof and
  crawler-safe (bots always see full pages).
- **Real Stripe unlock flow** — Checkout + signature-verified webhook, no SDK.
- **Tested in real `workerd` + D1** (38 tests), deployed via GitHub Actions.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the design.

## Quick start

```bash
npm install

# 1. Create the D1 database and paste the printed database_id into wrangler.toml
npm run db:create

# 2. Apply schema + seed locally
npm run migrate:local

# 3. Set local secrets: copy the example and fill in a signing secret
cp .dev.vars.example .dev.vars
#   openssl rand -hex 32   → paste as SIGNING_SECRET

# 4. Run
npm run dev            # http://localhost:8787
npm test               # full suite in workerd + D1
```

## Configuration

Non-secret config lives in `wrangler.toml` under `[vars]`. Secrets are set with
`wrangler secret put` (production) or `.dev.vars` (local, git-ignored).

| Name | Kind | Required | Purpose |
|------|------|----------|---------|
| `DB` | D1 binding | ✅ | Database. Set `database_id` in `wrangler.toml`. |
| `SIGNING_SECRET` | secret | ✅ | HMAC key for signed cookies. Generate with `openssl rand -hex 32`. |
| `STRIPE_SECRET_KEY` | secret | — | Enables `/unlock`. Without it, `/unlock` returns `501`. |
| `STRIPE_WEBHOOK_SECRET` | secret | — | `whsec_…`. Enables the webhook. Without it, the webhook returns `501`. |
| `STRIPE_PRICE_ID` | var | — | Price to charge. If unset, a one-time price is built from the amount below. |
| `STRIPE_UNLOCK_AMOUNT_CENTS` | var | — | Fallback unlock price in cents (default `900` = $9). |
| `PUBLIC_ORIGIN` | var | — | Canonical origin for URLs/redirects. Defaults to the request origin. |
| `MEMBER_TOKEN_TTL_DAYS` | var | — | Access cookie lifetime (default `365`). |

The Worker **fails fast** with `500` if `SIGNING_SECRET` is missing — it will not silently serve
unsigned cookies.

## Routes

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/` | Home. Featured projects. `public, max-age=300`. |
| GET | `/project/:slug` | **Metered.** Full project page; consumes one free view (or unlimited for members). |
| GET | `/developer/:slug` | Developer hub + their projects. Not metered. |
| GET | `/sitemap.xml` | All project + developer URLs. |
| GET | `/robots.txt` | Points crawlers at the sitemap. |
| GET | `/account` | Membership status from the session cookie. |
| GET | `/unlock` | Creates a Stripe Checkout Session → `303` to Stripe. |
| GET | `/unlock/success` | Verifies payment, mints the access cookie → `303` home. |
| POST | `/webhook/stripe` | Verifies signature, records the member. |
| GET | `/health` | `ok`. |
| * | (anything else) | Styled `404`. |

## Stripe setup

1. Create a product/price (or rely on `STRIPE_UNLOCK_AMOUNT_CENTS`).
2. `wrangler secret put STRIPE_SECRET_KEY`
3. Add a webhook endpoint in the Stripe Dashboard pointing at
   `https://<your-worker>/webhook/stripe`, subscribed to `checkout.session.completed`, and
   `wrangler secret put STRIPE_WEBHOOK_SECRET` with its signing secret.
4. Local webhook testing: `stripe listen --forward-to localhost:8787/webhook/stripe` and put the
   printed `whsec_…` in `.dev.vars`.

The webhook enforces the Stripe scheme exactly: HMAC-SHA256 over `{timestamp}.{rawBody}`, only
the `v1` signature is trusted, a 300-second timestamp tolerance blocks replays, and comparison is
constant-time.

## Testing

Tests execute inside the real Workers runtime (`workerd`) via
`@cloudflare/vitest-pool-workers`, against a real D1 binding with schema **and seed** applied per
test file. Outbound Stripe calls are mocked; nothing hits the network.

```bash
npm test          # run once
npm run test:watch
```

| File | Covers |
|------|--------|
| `test/unit.spec.js` | Signed cookies (incl. `exp`), Stripe signature (valid/replay/tamper/wrong-secret/v0-ignore), sitemap, meta format. |
| `test/db.spec.js` | The JOIN + vendor fold, batched developer query, slug lists, idempotent member insert. |
| `test/routes.spec.js` | Every route, the 3-view→`402` progression, member bypass, `Vary`/cache headers. |
| `test/stripe.spec.js` | Verified webhook writes a member; bad/wrong-secret signatures rejected; checkout + success mints an unlocking cookie. |

## Deployment (GitHub Actions)

`.github/workflows/ci.yml` runs the suite on every push/PR and, on `main`, applies remote D1
migrations and deploys. Add two repository secrets:

- `CLOUDFLARE_API_TOKEN` — a token with **Workers Scripts: Edit** and **D1: Edit**.
- `CLOUDFLARE_ACCOUNT_ID`.

Then set your Worker secrets once (`wrangler secret put …`) — they persist across deploys.

## Project structure

```
src/            Worker source (index, db, render, cookies, stripe, sitemap)
migrations/     0001 schema · 0002 seed · 0003 members
test/           vitest-pool-workers suite (+ apply-migrations setup)
wrangler.toml   Worker + D1 config and documented vars/secrets
vitest.config.js  cloudflareTest() plugin + D1 migration wiring
```

## Data note

Seed data (`migrations/0002_seed.sql`) is fictional placeholder content for developers,
projects, and vendors. Replace it with a real source before publishing.
