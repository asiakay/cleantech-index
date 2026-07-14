// db.js — every SQL query lives here, parameterized. No string interpolation into SQL.

const VENDOR_ROW = "¶"; // separates vendor records in GROUP_CONCAT
const VENDOR_FIELD = "§"; // separates fields within a vendor record

function parseVendors(concat) {
  return (concat || "")
    .split(VENDOR_ROW)
    .filter(Boolean)
    .map((s) => {
      const [name, type] = s.split(VENDOR_FIELD);
      return { name, type: type || null };
    });
}

/**
 * Load a project with its parent developer and ALL hardware vendors in ONE query.
 * GROUP_CONCAT folds the junction rows into a single string we split in JS.
 * Returns a flat object with a parsed `vendors` array, or null if not found.
 */
export async function getProjectBySlug(env, slug) {
  const row = await env.DB.prepare(
    `SELECT
        p.id, p.project_name, p.slug, p.technology_type, p.capacity_mw, p.status,
        p.interconnection_utility, p.commercial_operation_year, p.county, p.state,
        d.name  AS developer_name,
        d.slug  AS developer_slug,
        d.headquarters_state,
        d.total_portfolio_mw,
        GROUP_CONCAT(v.company_name || '${VENDOR_FIELD}' || COALESCE(v.component_type,''), '${VENDOR_ROW}') AS vendors
      FROM infrastructure_projects p
      JOIN energy_developers d       ON d.id = p.developer_id
      LEFT JOIN project_hardware ph  ON ph.project_id = p.id
      LEFT JOIN hardware_vendors v   ON v.id = ph.vendor_id
      WHERE p.slug = ?
      GROUP BY p.id`
  )
    .bind(slug)
    .first();

  if (!row) return null;
  row.vendors = parseVendors(row.vendors);
  return row;
}

/**
 * Load a developer and its projects. Two statements sent as ONE round trip via batch().
 * Returns { dev, projects } or null.
 */
export async function getDeveloperBySlug(env, slug) {
  const [devRes, projRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT id, name, slug, headquarters_state, total_portfolio_mw
         FROM energy_developers WHERE slug = ?`
    ).bind(slug),
    env.DB.prepare(
      `SELECT project_name, slug, technology_type, capacity_mw, status, state, commercial_operation_year
         FROM infrastructure_projects
        WHERE developer_id = (SELECT id FROM energy_developers WHERE slug = ?)
        ORDER BY capacity_mw DESC`
    ).bind(slug),
  ]);

  const dev = devRes.results[0];
  if (!dev) return null;
  return { dev, projects: projRes.results };
}

const SORT_COLS = {
  capacity: "capacity_mw",
  status: "status",
  technology: "technology_type",
  state: "state",
  name: "project_name",
};

const VALID_STATUSES = new Set(["Operational", "Under Construction", "Planned"]);

/** Paginated + sorted projects + index-wide stats for the home page, one batch round-trip. */
export async function getFeaturedProjects(env, page = 1, pageSize = 20, sort = "capacity", dir = "desc", status = "") {
  const col = SORT_COLS[sort] ?? "capacity_mw";
  const order = dir === "asc" ? "ASC" : "DESC";
  // Secondary sort keeps results stable across pages
  const orderSql = col === "capacity_mw"
    ? `${col} ${order}, project_name ASC`
    : `${col} ${order}, capacity_mw DESC`;
  const offset = (page - 1) * pageSize;
  const where = VALID_STATUSES.has(status) ? "WHERE status = ?" : "";
  const binds = VALID_STATUSES.has(status) ? [status] : [];
  const [projRes, statsRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT project_name, slug, technology_type, capacity_mw, status, state
         FROM infrastructure_projects
         ${where}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`
    ).bind(...binds, pageSize, offset),
    env.DB.prepare(
      `SELECT
         COUNT(*)                                      AS total_projects,
         ROUND(SUM(capacity_mw) / 1000.0, 1)          AS total_gw,
         COUNT(DISTINCT state)                         AS total_states,
         COUNT(DISTINCT technology_type)               AS total_tech_types,
         SUM(CASE WHEN status = 'Operational'        THEN 1 ELSE 0 END) AS count_operational,
         SUM(CASE WHEN status = 'Under Construction' THEN 1 ELSE 0 END) AS count_under_construction,
         SUM(CASE WHEN status = 'Planned'            THEN 1 ELSE 0 END) AS count_planned
       FROM infrastructure_projects`
    ),
  ]);
  const total = VALID_STATUSES.has(status)
    ? projRes.results.length + offset  // approximate from current page for filtered view
    : (statsRes.results[0].total_projects ?? 0);
  // For filtered queries, get accurate count
  let filteredTotal = total;
  if (VALID_STATUSES.has(status)) {
    const countRes = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM infrastructure_projects WHERE status = ?`
    ).bind(status).first();
    filteredTotal = countRes?.n ?? 0;
  }
  return {
    projects: projRes.results,
    stats: statsRes.results[0],
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(filteredTotal / pageSize)),
    sort,
    dir,
    status,
  };
}

/** All slugs for the sitemap. */
export async function getAllSlugs(env) {
  const [projRes, devRes] = await env.DB.batch([
    env.DB.prepare(`SELECT slug FROM infrastructure_projects ORDER BY slug`),
    env.DB.prepare(`SELECT slug FROM energy_developers ORDER BY slug`),
  ]);
  return {
    projects: projRes.results.map((r) => r.slug),
    developers: devRes.results.map((r) => r.slug),
  };
}

/** Idempotent member insert driven by the Stripe webhook (unique on stripe_session_id). */
export async function recordMember(env, { email, stripeCustomerId, stripeSessionId }) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO members (email, stripe_customer_id, stripe_session_id)
       VALUES (?, ?, ?)`
  )
    .bind(email ?? null, stripeCustomerId ?? null, stripeSessionId)
    .run();
}

/** Lookup used by tests / an admin view. */
export async function getMemberBySessionId(env, stripeSessionId) {
  return env.DB.prepare(`SELECT * FROM members WHERE stripe_session_id = ?`)
    .bind(stripeSessionId)
    .first();
}

// ─── User saved data ────────────────────────────────────────────────────────

/** Toggle a bookmark. Returns true if now bookmarked, false if removed. */
export async function toggleBookmark(env, userId, projectSlug) {
  const existing = await env.DB.prepare(
    `SELECT id FROM bookmarks WHERE user_id = ? AND project_slug = ?`
  ).bind(userId, projectSlug).first();
  if (existing) {
    await env.DB.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND project_slug = ?`)
      .bind(userId, projectSlug).run();
    return false;
  }
  await env.DB.prepare(`INSERT INTO bookmarks (user_id, project_slug) VALUES (?, ?)`)
    .bind(userId, projectSlug).run();
  return true;
}

/** Check if a project is bookmarked by a user. */
export async function isBookmarked(env, userId, projectSlug) {
  const row = await env.DB.prepare(
    `SELECT 1 FROM bookmarks WHERE user_id = ? AND project_slug = ?`
  ).bind(userId, projectSlug).first();
  return !!row;
}

/** All bookmarks for a user, joined with project names. */
export async function getUserBookmarks(env, userId) {
  return (await env.DB.prepare(
    `SELECT b.project_slug, p.project_name, p.technology_type, p.capacity_mw, p.status, p.state
       FROM bookmarks b
       LEFT JOIN infrastructure_projects p ON p.slug = b.project_slug
      WHERE b.user_id = ?
      ORDER BY b.created_at DESC`
  ).bind(userId).all()).results;
}

/** All watchlists for a user. */
export async function getUserWatchlists(env, userId) {
  return (await env.DB.prepare(
    `SELECT id, name, created_at FROM watchlists WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(userId).all()).results;
}

/** Items in a watchlist, joined with project names. */
export async function getWatchlistItems(env, watchlistId) {
  return (await env.DB.prepare(
    `SELECT wi.project_slug, p.project_name, p.technology_type, p.capacity_mw, p.status, p.state
       FROM watchlist_items wi
       LEFT JOIN infrastructure_projects p ON p.slug = wi.project_slug
      WHERE wi.watchlist_id = ?
      ORDER BY wi.created_at DESC`
  ).bind(watchlistId).all()).results;
}

/** Create a new watchlist. Returns the new id. */
export async function createWatchlist(env, userId, name) {
  const res = await env.DB.prepare(
    `INSERT INTO watchlists (user_id, name) VALUES (?, ?)`
  ).bind(userId, name).run();
  return res.meta.last_row_id;
}

/** Delete a watchlist (cascades items). Verifies ownership. */
export async function deleteWatchlist(env, userId, watchlistId) {
  await env.DB.prepare(
    `DELETE FROM watchlists WHERE id = ? AND user_id = ?`
  ).bind(watchlistId, userId).run();
}

/** Toggle a project in a watchlist. Returns true if added, false if removed. Verifies ownership. */
export async function toggleWatchlistItem(env, userId, watchlistId, projectSlug) {
  const wl = await env.DB.prepare(
    `SELECT id FROM watchlists WHERE id = ? AND user_id = ?`
  ).bind(watchlistId, userId).first();
  if (!wl) return null;

  const existing = await env.DB.prepare(
    `SELECT 1 FROM watchlist_items WHERE watchlist_id = ? AND project_slug = ?`
  ).bind(watchlistId, projectSlug).first();
  if (existing) {
    await env.DB.prepare(
      `DELETE FROM watchlist_items WHERE watchlist_id = ? AND project_slug = ?`
    ).bind(watchlistId, projectSlug).run();
    return false;
  }
  await env.DB.prepare(
    `INSERT INTO watchlist_items (watchlist_id, project_slug) VALUES (?, ?)`
  ).bind(watchlistId, projectSlug).run();
  return true;
}

/** Upsert a note for a project. Empty string deletes it. */
export async function saveNote(env, userId, projectSlug, note) {
  if (!note.trim()) {
    await env.DB.prepare(
      `DELETE FROM project_notes WHERE user_id = ? AND project_slug = ?`
    ).bind(userId, projectSlug).run();
    return;
  }
  await env.DB.prepare(
    `INSERT INTO project_notes (user_id, project_slug, note, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, project_slug)
       DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`
  ).bind(userId, projectSlug, note.trim()).run();
}

/** Get a note for a specific project. */
export async function getNote(env, userId, projectSlug) {
  const row = await env.DB.prepare(
    `SELECT note FROM project_notes WHERE user_id = ? AND project_slug = ?`
  ).bind(userId, projectSlug).first();
  return row?.note || "";
}

/** All notes for a user, joined with project names. */
export async function getUserNotes(env, userId) {
  return (await env.DB.prepare(
    `SELECT n.project_slug, n.note, n.updated_at, p.project_name
       FROM project_notes n
       LEFT JOIN infrastructure_projects p ON p.slug = n.project_slug
      WHERE n.user_id = ?
      ORDER BY n.updated_at DESC`
  ).bind(userId).all()).results;
}

/** Save a named filter. Returns new id. */
export async function saveFilter(env, userId, name, filterJson) {
  const res = await env.DB.prepare(
    `INSERT INTO saved_filters (user_id, name, filter_json) VALUES (?, ?, ?)`
  ).bind(userId, name, filterJson).run();
  return res.meta.last_row_id;
}

/** Delete a saved filter. Verifies ownership. */
export async function deleteFilter(env, userId, filterId) {
  await env.DB.prepare(
    `DELETE FROM saved_filters WHERE id = ? AND user_id = ?`
  ).bind(filterId, userId).run();
}

/** All saved filters for a user. */
export async function getUserFilters(env, userId) {
  return (await env.DB.prepare(
    `SELECT id, name, filter_json, created_at FROM saved_filters WHERE user_id = ? ORDER BY created_at DESC`
  ).bind(userId).all()).results;
}

/** Full dashboard payload in one batch. */
export async function getDashboardData(env, userId) {
  const [bookmarks, notes, filters, watchlists] = await Promise.all([
    getUserBookmarks(env, userId),
    getUserNotes(env, userId),
    getUserFilters(env, userId),
    getUserWatchlists(env, userId),
  ]);
  // Fetch items for each watchlist
  const watchlistsWithItems = await Promise.all(
    watchlists.map(async (wl) => ({
      ...wl,
      items: await getWatchlistItems(env, wl.id),
    }))
  );
  return { bookmarks, notes, filters, watchlists: watchlistsWithItems };
}
