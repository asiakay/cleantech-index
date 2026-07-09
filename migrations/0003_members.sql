-- 0003_members.sql
-- Durable record of paid members, written by the verified Stripe webhook.
-- The paywall bypass itself uses the signed session_token cookie (stateless, edge-fast);
-- this table is the source of truth / audit trail and powers admin lookups.

CREATE TABLE members (
  id                 INTEGER PRIMARY KEY,
  email              TEXT,
  stripe_customer_id TEXT,
  stripe_session_id  TEXT NOT NULL UNIQUE,   -- idempotency key for INSERT OR IGNORE
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_members_customer ON members(stripe_customer_id);
