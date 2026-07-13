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

/** Paginated + sorted projects + index-wide stats for the home page, one batch round-trip. */
export async function getFeaturedProjects(env, page = 1, pageSize = 20, sort = "capacity", dir = "desc") {
  const col = SORT_COLS[sort] ?? "capacity_mw";
  const order = dir === "asc" ? "ASC" : "DESC";
  // Secondary sort keeps results stable across pages
  const orderSql = col === "capacity_mw"
    ? `${col} ${order}, project_name ASC`
    : `${col} ${order}, capacity_mw DESC`;
  const offset = (page - 1) * pageSize;
  const [projRes, statsRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT project_name, slug, technology_type, capacity_mw, status, state
         FROM infrastructure_projects
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`
    ).bind(pageSize, offset),
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
  const total = statsRes.results[0].total_projects ?? 0;
  return {
    projects: projRes.results,
    stats: statsRes.results[0],
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    sort,
    dir,
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
