-- 0005_auth_rate_limits.sql
-- Lightweight per-IP rate limiting for the magic-link endpoint.
-- Each row is a 15-minute bucket keyed by "${ip}:${bucket_id}".
-- Rows accumulate until the async cleanup in /auth/verify prunes old ones.

CREATE TABLE auth_rate_limits (
  window_key TEXT PRIMARY KEY,
  count      INTEGER NOT NULL DEFAULT 0
);
