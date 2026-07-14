// auth.js — magic-link token + user-session management.

const USER_SESSION_COOKIE = "ct_user";
const SESSION_TTL_DAYS = 30;
const MAGIC_LINK_TTL_MINUTES = 15;

function randomHex(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function nowPlusMins(mins) {
  return new Date(Date.now() + mins * 60 * 1000).toISOString();
}

function nowPlusDays(days) {
  return new Date(Date.now() + days * 86400 * 1000).toISOString();
}

/** Upsert user by email (creates on first login), return user id. */
export async function upsertUser(env, email) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (email) VALUES (?)`
  ).bind(email).run();
  const row = await env.DB.prepare(`SELECT id FROM users WHERE email = ?`).bind(email).first();
  return row.id;
}

/** Create a one-time magic-link token for the user. */
export async function createMagicToken(env, userId) {
  const token = randomHex(32);
  const expiresAt = nowPlusMins(MAGIC_LINK_TTL_MINUTES);
  await env.DB.prepare(
    `INSERT INTO magic_link_tokens (user_id, token, expires_at) VALUES (?, ?, ?)`
  ).bind(userId, token, expiresAt).run();
  return token;
}

/**
 * Verify and consume a magic-link token.
 * Returns userId on success, null if invalid/expired/used.
 */
export async function consumeMagicToken(env, token) {
  const row = await env.DB.prepare(
    `SELECT id, user_id, expires_at, used FROM magic_link_tokens WHERE token = ?`
  ).bind(token).first();

  if (!row || row.used) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  await env.DB.prepare(`UPDATE magic_link_tokens SET used = 1 WHERE id = ?`)
    .bind(row.id).run();

  return row.user_id;
}

/** Create a new user session in D1 and return the session token. */
export async function createSession(env, userId) {
  const token = randomHex(32);
  const expiresAt = nowPlusDays(SESSION_TTL_DAYS);
  await env.DB.prepare(
    `INSERT INTO user_sessions (user_id, token, expires_at) VALUES (?, ?, ?)`
  ).bind(userId, token, expiresAt).run();
  return token;
}

/**
 * Resolve a session token to a user row.
 * Returns { id, email } or null.
 */
export async function getSessionUser(env, token) {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(token).first();
  return row || null;
}

/** Delete a session (logout). */
export async function deleteSession(env, token) {
  if (!token) return;
  await env.DB.prepare(`DELETE FROM user_sessions WHERE token = ?`).bind(token).run();
}

/** Build a Set-Cookie header value for the user session. */
export function sessionCookieHeader(token) {
  const maxAge = SESSION_TTL_DAYS * 86400;
  return `${USER_SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** Build a Set-Cookie that clears the user session. */
export function clearSessionCookieHeader() {
  return `${USER_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/** Read the user session token from a parsed cookie map. */
export function getUserSessionToken(cookies) {
  return cookies[USER_SESSION_COOKIE] || null;
}
