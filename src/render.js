// render.js — server-side HTML via template literals, streamed chunk-by-chunk so the
// <head> (meta tags) flushes to crawlers/browsers before the body finishes assembling.

const FREE_LIMIT = 3;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

// 250.0 -> "250", 3100.5 -> "3100.5"
const num = (n) => (n == null ? "" : n % 1 === 0 ? String(Math.trunc(n)) : String(n));

const CSS = `
:root{--ink:#12211c;--mut:#5b6b64;--line:#e2e8e4;--bg:#fbfcfb;--accent:#137a4b;--warn:#8a4b00}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:16px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:720px;margin:0 auto;padding:28px 20px 64px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.crumb{font-size:13px;color:var(--mut);margin-bottom:18px}
h1{font-size:27px;line-height:1.2;margin:0 0 6px}
.sub{color:var(--mut);margin:0 0 22px}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;
border:1px solid var(--line);background:#fff}
.pill.warn{color:var(--warn);border-color:#f0d9bf;background:#fff8f0}
.pill.ok{color:var(--accent);border-color:#c9e6d5;background:#f1faf4}
table.spec{width:100%;border-collapse:collapse;margin:8px 0 26px}
.spec td{padding:10px 0;border-bottom:1px solid var(--line);vertical-align:top}
.spec td.k{color:var(--mut);width:42%;font-size:14px}
.spec td.v{font-weight:600}
.status{display:inline-block;font-size:12px;font-weight:700;padding:2px 9px;border-radius:6px}
.s-op{background:#e7f6ec;color:#0f6a3d}.s-uc{background:#fff2df;color:#8a4b00}.s-pl{background:#eef1ff;color:#334a9e}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:var(--mut);margin:26px 0 10px}
ul.v{list-style:none;padding:0;margin:0}
ul.v li{padding:9px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;gap:12px}
ul.v li span{color:var(--mut);font-size:14px}
.foot{margin-top:34px;font-size:12px;color:var(--mut)}
.gate{max-width:520px;margin:9vh auto;text-align:center;padding:0 20px}
.gate h1{font-size:25px}.gate p{color:var(--mut)}
.cta{display:inline-block;margin-top:18px;padding:12px 22px;border-radius:10px;
background:var(--accent);color:#fff;font-weight:700}
`;

const statusClass = (s) =>
  s === "Operational" ? "s-op" : s === "Under Construction" ? "s-uc" : "s-pl";

// Safe JSON for inline <script> blocks: unicode-escape < and > so a value like
// "</script>" in a project name can never terminate the surrounding script tag.
const safeJson = (obj) =>
  JSON.stringify(obj).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");

/** Build the streaming <head>. Meta title uses the exact required format. */
function head(title, description, canonical, jsonLd, wrapClass = "wrap") {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ""}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>` : ""}
<style>${CSS}</style>
</head><body><div class="${wrapClass}">`;
}

const tail = `</div></body></html>`;

/**
 * Project page. `p` is the flat DB row (with `p.vendors` array); `freeViewsLeft` is
 * int, or null for a member (unlimited).
 */
export function renderProjectPage(p, vendors, freeViewsLeft, origin) {
  const capStr = p.capacity_mw != null ? `${num(p.capacity_mw)} MW` : "";
  // Required meta format: "Project Name - Capacity MW Technology Type Infrastructure | CleanTech Index"
  const title =
    `${p.project_name} - ${capStr ? capStr + " " : ""}${p.technology_type} Infrastructure | CleanTech Index`;
  const description =
    `${p.project_name} is a ${capStr ? capStr + " " : ""}${p.technology_type} project by ` +
    `${p.developer_name} — ${p.status}${p.county ? `, ${p.county} County` : ""}` +
    `${p.state ? `, ${p.state}` : ""}${p.commercial_operation_year ? ` (COD ${p.commercial_operation_year})` : ""}.`;
  const canonical = `${origin}/project/${p.slug}`;

  const jsonLd = safeJson({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "CleanTech Index", item: origin },
      { "@type": "ListItem", position: 2, name: p.developer_name, item: `${origin}/developer/${p.developer_slug}` },
      { "@type": "ListItem", position: 3, name: p.project_name, item: canonical },
    ],
  });

  const meter =
    freeViewsLeft == null
      ? `<span class="pill ok">Member · unlimited access</span>`
      : `<span class="pill warn" id="view-meter" data-left="${freeViewsLeft}">${freeViewsLeft} free view${freeViewsLeft === 1 ? "" : "s"} left</span>`;

  const row = (k, v) => (v ? `<tr><td class="k">${esc(k)}</td><td class="v">${v}</td></tr>` : "");

  const vendorList = vendors.length
    ? `<h2>Hardware &amp; suppliers</h2><ul class="v">${vendors
        .map((v) => `<li><span>${esc(v.type || "Component")}</span> ${esc(v.name)}</li>`)
        .join("")}</ul>`
    : "";

  const chunks = [
    head(title, description, canonical, jsonLd),
    `<div class="crumb"><a href="/">CleanTech Index</a> › <a href="/developer/${esc(p.developer_slug)}">${esc(p.developer_name)}</a> › ${esc(p.project_name)}</div>
     <div style="margin-bottom:14px">${meter}</div>
     <h1>${esc(p.project_name)}</h1>
     <p class="sub">${esc(capStr)} ${esc(p.technology_type)} · developed by <a href="/developer/${esc(p.developer_slug)}">${esc(p.developer_name)}</a></p>`,
    `<table class="spec">
      <tr><td class="k">Status</td><td class="v"><span class="status ${statusClass(p.status)}">${esc(p.status)}</span></td></tr>
      ${row("Technology", esc(p.technology_type))}
      ${row("Nameplate capacity", esc(capStr))}
      ${row("Location", esc([p.county && p.county + " County", p.state].filter(Boolean).join(", ")))}
      ${row("Interconnection", esc(p.interconnection_utility))}
      ${row("Commercial operation", esc(p.commercial_operation_year))}
      ${row("Developer HQ", esc(p.headquarters_state))}
      ${row("Developer portfolio", p.total_portfolio_mw != null ? esc(num(p.total_portfolio_mw)) + " MW" : "")}
     </table>`,
    vendorList,
    `<div class="foot">Data listing for ${esc(p.project_name)}. Part of the CleanTech Index directory.</div>`,
    tail,
  ];

  return { title, chunks };
}

/** Developer hub page: developer facts + all their projects. Not metered. */
export function renderDeveloperPage(dev, projects, origin) {
  const title = `${dev.name} — Clean Energy Project Portfolio | CleanTech Index`;
  const description =
    `${dev.name} operates ${projects.length} tracked project${projects.length === 1 ? "" : "s"}` +
    `${dev.total_portfolio_mw != null ? ` totaling ${num(dev.total_portfolio_mw)} MW` : ""}` +
    `${dev.headquarters_state ? `, HQ ${dev.headquarters_state}` : ""}.`;
  const canonical = `${origin}/developer/${dev.slug}`;

  const jsonLd = safeJson({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "CleanTech Index", item: origin },
      { "@type": "ListItem", position: 2, name: dev.name, item: canonical },
    ],
  });

  const list = projects.length
    ? `<ul class="v">${projects
        .map(
          (p) =>
            `<li><a href="/project/${esc(p.slug)}">${esc(p.project_name)}</a>
             <span>${esc(num(p.capacity_mw))} MW · ${esc(p.technology_type)} · ${esc(p.status)}${p.state ? " · " + esc(p.state) : ""}</span></li>`
        )
        .join("")}</ul>`
    : `<p class="sub">No projects tracked yet.</p>`;

  return {
    title,
    chunks: [
      head(title, description, canonical, jsonLd),
      `<div class="crumb"><a href="/">CleanTech Index</a> › ${esc(dev.name)}</div>
       <h1>${esc(dev.name)}</h1>
       <p class="sub">${esc([dev.headquarters_state && "HQ " + dev.headquarters_state,
         dev.total_portfolio_mw != null && num(dev.total_portfolio_mw) + " MW portfolio"].filter(Boolean).join(" · "))}</p>
       <h2>Projects (${projects.length})</h2>`,
      list,
      tail,
    ],
  };
}

/** Hard paywall shown once free views are exhausted. */
export function renderPaywall(origin) {
  const title = "View limit reached | CleanTech Index";
  const description = "You've reached the free view limit for the CleanTech Index directory.";
  return {
    title,
    chunks: [
      head(title, description, null, null, "gate"),
      `<h1>You've used your ${FREE_LIMIT} free project views</h1>
       <p>The CleanTech Index tracks developers, capacity, interconnection, and hardware
       suppliers across the full project pipeline. Unlock unlimited access to continue.</p>
       <a class="cta" href="/unlock">Unlock full access</a>
       <p style="margin-top:26px;font-size:13px">Already a member? Your access restores automatically on this device.</p>`,
      tail,
    ],
  };
}

/** Minimal home page (does not consume free views). */
export function renderHome(projects) {
  const title = "CleanTech Index — U.S. clean energy infrastructure directory";
  const description =
    "Browse solar, wind, and battery storage projects: capacity, status, interconnection, and hardware suppliers.";
  const items = projects
    .map(
      (p) =>
        `<li><a href="/project/${esc(p.slug)}">${esc(p.project_name)}</a>
         <span>${esc(num(p.capacity_mw))} MW · ${esc(p.technology_type)} · ${esc(p.state || "")}</span></li>`
    )
    .join("");
  return {
    title,
    chunks: [
      head(title, description, null, null),
      `<h1>CleanTech Index</h1><p class="sub">Clean energy infrastructure, one project at a time.</p>
       <h2>Featured projects</h2><ul class="v">${items}</ul>`,
      tail,
    ],
  };
}

/** Membership status page. */
export function renderAccount(isMember, session) {
  const title = "Your access | CleanTech Index";
  const description = "CleanTech Index membership status.";
  const body = isMember
    ? `<h1>Membership active</h1>
       <p class="sub">You have unlimited access on this device${session?.sub ? ` (${esc(session.sub)})` : ""}.</p>
       ${session?.exp ? `<p style="font-size:13px;color:var(--mut)">Access valid until ${esc(new Date(session.exp * 1000).toISOString().slice(0, 10))}.</p>` : ""}`
    : `<h1>No active membership</h1>
       <p class="sub">You're on the free tier (${FREE_LIMIT} project views).</p>
       <a class="cta" href="/unlock">Unlock full access</a>`;
  return { title, chunks: [head(title, description, null, null, "gate"), body, tail] };
}

/** Styled 404. */
export function renderNotFound(origin) {
  const title = "Not found | CleanTech Index";
  return {
    title,
    chunks: [
      head(title, "Page not found.", null, null, "gate"),
      `<h1>404 — not found</h1><p class="sub">That page isn't in the index.</p>
       <a class="cta" href="/">Back to CleanTech Index</a>`,
      tail,
    ],
  };
}

export { FREE_LIMIT };
