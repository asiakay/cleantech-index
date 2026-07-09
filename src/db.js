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

/** Featured projects for the home page. */
export async function getFeaturedProjects(env, limit = 25) {
  const { results } = await env.DB.prepare(
    `SELECT project_name, slug, technology_type, capacity_mw, state
       FROM infrastructure_projects
       ORDER BY capacity_mw DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return results;
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
