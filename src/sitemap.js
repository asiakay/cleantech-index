// sitemap.js — programmatic sitemap + robots for full pSEO crawl coverage.

const xmlEscape = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c])
  );

/**
 * Build sitemap XML from slug lists.
 * @param {string} origin e.g. https://cleantech.example
 * @param {{projects:string[], developers:string[]}} slugs
 */
export function renderSitemap(origin, { projects = [], developers = [] }) {
  const url = (loc, priority) =>
    `<url><loc>${xmlEscape(loc)}</loc><priority>${priority}</priority></url>`;

  const entries = [
    url(`${origin}/`, "1.0"),
    ...developers.map((s) => url(`${origin}/developer/${s}`, "0.7")),
    ...projects.map((s) => url(`${origin}/project/${s}`, "0.8")),
  ];

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries.join("\n") +
    `\n</urlset>\n`
  );
}

/** robots.txt that points crawlers at the sitemap. */
export function renderRobots(origin) {
  return `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`;
}
