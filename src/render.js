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
ul.v li{padding:9px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}
ul.v li span{color:var(--mut);font-size:14px}
.foot{margin-top:34px;font-size:12px;color:var(--mut)}
.gate{max-width:520px;margin:9vh auto;text-align:center;padding:0 20px}
.gate h1{font-size:25px}.gate p{color:var(--mut)}
.cta{display:inline-block;margin-top:18px;padding:12px 22px;border-radius:10px;
background:var(--accent);color:#fff;font-weight:700}
.stats-bar{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 28px}
.stat{flex:1 1 120px;background:#fff;border:1px solid var(--line);border-radius:10px;
padding:14px 16px;min-width:100px}
.stat-n{font-size:22px;font-weight:700;color:var(--ink);line-height:1}
.stat-l{font-size:12px;color:var(--mut);margin-top:3px}
.filter-bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:18px}
.filter-bar input{flex:1 1 200px;padding:8px 12px;border:1px solid var(--line);
border-radius:8px;font-size:14px;background:#fff;color:var(--ink);outline:none}
.filter-bar input:focus{border-color:var(--accent)}
.filter-bar select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;
font-size:14px;background:#fff;color:var(--ink);outline:none;cursor:pointer}
.filter-bar select:focus{border-color:var(--accent)}
.tech-group{margin-bottom:8px}
.tech-group h2{cursor:pointer;user-select:none}
.no-results{padding:18px 0;color:var(--mut);font-size:14px}
.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:28px;font-size:14px}
.pager a{display:inline-block;padding:8px 16px;border:1px solid var(--line);border-radius:8px;color:var(--accent)}
.pager a:hover{background:var(--line);text-decoration:none}
.pager .pager-info{color:var(--mut)}
.sort-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:16px}
.sort-label{font-size:13px;color:var(--mut);margin-right:2px}
.sort-btn{font-size:13px;padding:4px 10px;border:1px solid var(--line);border-radius:6px;
color:var(--ink);background:#fff;text-decoration:none;white-space:nowrap}
.sort-btn:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.sort-active{background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600}
.sort-active:hover{color:#fff}
.nav-bar{display:flex;justify-content:flex-end;gap:12px;font-size:13px;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--line)}
.nav-bar a{color:var(--mut)}
.btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;border-radius:8px;
border:1px solid var(--line);background:#fff;color:var(--ink);font-size:13px;cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.btn.active{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn.active:hover{color:#fff}
.btn-sm{padding:4px 10px;font-size:12px}
.user-panel{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-top:28px}
.user-panel h2{margin-top:0}
textarea.note-box{width:100%;min-height:80px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;
font:14px/1.5 inherit;color:var(--ink);background:#fff;resize:vertical;outline:none}
textarea.note-box:focus{border-color:var(--accent)}
.form-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
.form-row input[type=text],.form-row input[type=email]{flex:1 1 200px;padding:8px 12px;border:1px solid var(--line);
border-radius:8px;font-size:14px;background:#fff;color:var(--ink);outline:none}
.form-row input:focus{border-color:var(--accent)}
.dash-section{margin-bottom:32px}
.dash-section h2{margin-bottom:10px}
.wl-card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.wl-card h3{margin:0 0 8px;font-size:15px}
.wl-card ul{margin:0;padding:0;list-style:none}
.wl-card ul li{padding:6px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;font-size:14px}
.wl-card ul li:last-child{border-bottom:none}
.tag{font-size:11px;color:var(--mut);background:var(--line);padding:2px 7px;border-radius:999px}
.msg{padding:10px 14px;border-radius:8px;font-size:14px;margin-bottom:14px}
.msg.ok{background:#f1faf4;border:1px solid #c9e6d5;color:#0f6a3d}
.msg.err{background:#fff8f0;border:1px solid #f0d9bf;color:var(--warn)}
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
</head><body><div class="${wrapClass}">`
}

function navBar(user) {
  if (user) {
    return `<nav class="nav-bar">
      <a href="/dashboard">My saved items</a>
      <a href="/account">Account</a>
      <form method="POST" action="/auth/logout" style="margin:0"><button class="btn btn-sm" type="submit">Sign out</button></form>
    </nav>`;
  }
  return `<nav class="nav-bar"><a href="/login">Sign in</a></nav>`;
}

const tail = `</div></body></html>`;

/**
 * Project page. `p` is the flat DB row (with `p.vendors` array); `freeViewsLeft` is
 * int, or null for a member (unlimited). `userCtx` is { user, bookmarked, note, watchlists } or null.
 */
export function renderProjectPage(p, vendors, freeViewsLeft, origin, userCtx = null) {
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

  // User panel: bookmark + note + watchlist controls
  let userPanel = "";
  if (userCtx?.user) {
    const { bookmarked, note, watchlists } = userCtx;
    const bmLabel = bookmarked ? "★ Bookmarked" : "☆ Bookmark";
    const bmClass = bookmarked ? "btn active" : "btn";

    const watchlistOptions = watchlists.length
      ? watchlists.map(
          (wl) =>
            `<option value="${esc(String(wl.id))}">${esc(wl.name)}</option>`
        ).join("")
      : `<option value="" disabled>No watchlists yet</option>`;

    const watchlistDropdown = `
      <form method="POST" action="/watchlists/add" style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap">
        <input type="hidden" name="slug" value="${esc(p.slug)}">
        <select name="watchlist_id" style="padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:#fff;color:var(--ink)">
          ${watchlistOptions}
        </select>
        <button class="btn btn-sm" type="submit"${watchlists.length ? "" : " disabled"}>Add to watchlist</button>
      </form>`;

    userPanel = `<div class="user-panel">
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">
        <form method="POST" action="/bookmarks" style="margin:0">
          <input type="hidden" name="slug" value="${esc(p.slug)}">
          <button class="${bmClass}" type="submit">${bmLabel}</button>
        </form>
        ${watchlistDropdown}
        <a href="/dashboard" class="btn btn-sm">My saved items →</a>
      </div>
      <h2 style="margin-top:0">Private note</h2>
      <form method="POST" action="/notes/${esc(p.slug)}">
        <textarea class="note-box" name="note" placeholder="Add a private note about this project…">${esc(note)}</textarea>
        <div class="form-row"><button class="btn btn-sm" type="submit">Save note</button></div>
      </form>
    </div>`;
  } else {
    userPanel = `<div class="foot" style="margin-top:20px"><a href="/login">Sign in</a> to bookmark projects and save notes.</div>`;
  }

  const chunks = [
    head(title, description, canonical, jsonLd),
    navBar(userCtx?.user),
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
    userPanel,
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

const TECH_ICONS = {
  "Solar PV": "☀️",
  "Battery Storage": "🔋",
  "Onshore Wind": "🌬️",
  "Offshore Wind": "🌊",
};

/** Home page with stats bar, sort controls, tech-grouped list, client-side filter, and pagination. */
export function renderHome({ projects, stats, page = 1, totalPages = 1, sort = "capacity", dir = "desc", status = "" }, user = null) {
  const title = "CleanTech Index — U.S. clean energy infrastructure directory";
  const description =
    "Browse solar, wind, and battery storage projects: capacity, status, interconnection, and hardware suppliers.";

  const statTile = (n, label) =>
    `<div class="stat"><div class="stat-n">${esc(n)}</div><div class="stat-l">${label}</div></div>`;

  const gwStr = stats.total_gw != null ? `${num(stats.total_gw)} GW` : "—";
  const statsBar = `<div class="stats-bar">
    ${statTile(stats.total_projects ?? "—", "projects tracked")}
    ${statTile(gwStr, "total capacity")}
    ${statTile(stats.total_states ?? "—", "states covered")}
    ${statTile(stats.count_operational ?? 0, "operational")}
    ${statTile(stats.count_under_construction ?? 0, "under construction")}
    ${statTile(stats.count_planned ?? 0, "planned")}
  </div>`;

  // Sort controls — clicking the active col toggles direction; others default to their natural dir
  const statusQs = status ? `&status=${encodeURIComponent(status)}` : "";

  const SORT_OPTS = [
    { key: "capacity",   label: "Capacity",   defaultDir: "desc" },
    { key: "name",       label: "Name",        defaultDir: "asc"  },
    { key: "status",     label: "Status",      defaultDir: "asc"  },
    { key: "technology", label: "Technology",  defaultDir: "asc"  },
    { key: "state",      label: "State",       defaultDir: "asc"  },
  ];
  const sortBar = `<div class="sort-bar">
    <span class="sort-label">Sort:</span>
    ${SORT_OPTS.map(({ key, label, defaultDir }) => {
      const isActive = key === sort;
      const nextDir = isActive ? (dir === "asc" ? "desc" : "asc") : defaultDir;
      const arrow = isActive ? (dir === "asc" ? " ↑" : " ↓") : "";
      return `<a href="/?sort=${key}&dir=${nextDir}&page=1${statusQs}" class="sort-btn${isActive ? " sort-active" : ""}">${esc(label)}${arrow}</a>`;
    }).join("")}
  </div>`;

  const projectRow = (p) =>
    `<li data-slug="${esc(p.slug)}" data-tech="${esc(p.technology_type)}" data-state="${esc(p.state || "")}" data-status="${esc(p.status || "")}">
       <a href="/project/${esc(p.slug)}">${esc(p.project_name)}</a>
       <span><span class="status ${statusClass(p.status)}">${esc(p.status)}</span>&nbsp; ${esc(num(p.capacity_mw))} MW · ${esc(p.state || "")}</span>
     </li>`;

  // Group by technology only when sorted by technology or capacity (natural grouping);
  // otherwise show a flat list so the chosen sort order is clearly visible.
  let listHtml;
  if (sort === "technology" || sort === "capacity") {
    const groups = {};
    for (const p of projects) {
      const key = p.technology_type || "Other";
      if (!groups[key]) groups[key] = [];
      groups[key].push(p);
    }
    listHtml = Object.entries(groups)
      .map(([tech, items]) => {
        const icon = TECH_ICONS[tech] || "⚡";
        return `<div class="tech-group" data-tech="${esc(tech)}">
          <h2>${icon} ${esc(tech)} <span style="font-weight:400;text-transform:none;font-size:13px">(${items.length})</span></h2>
          <ul class="v">${items.map(projectRow).join("")}</ul>
        </div>`;
      })
      .join("");
  } else {
    listHtml = `<div class="tech-group" data-tech="">
      <ul class="v">${projects.map(projectRow).join("")}</ul>
    </div>`;
  }

  // Pagination links preserve current sort+dir+status
  const pageLink = (p) => `/?page=${p}&sort=${sort}&dir=${dir}${statusQs}`;
  const pager = totalPages > 1
    ? `<nav class="pager" aria-label="Pagination">
         ${page > 1 ? `<a href="${pageLink(page - 1)}">← Previous</a>` : `<span></span>`}
         <span class="pager-info">Page ${page} of ${totalPages}</span>
         ${page < totalPages ? `<a href="${pageLink(page + 1)}">Next →</a>` : `<span></span>`}
       </nav>`
    : "";

  const filterScript = `<script>
(function(){
  var inp=document.getElementById('fi');
  function applyFilter(){
    var q=(inp.value||'').toLowerCase();
    var groups=document.querySelectorAll('.tech-group');
    groups.forEach(function(g){
      var items=g.querySelectorAll('li');
      var vis=0;
      items.forEach(function(li){
        var show=!q||li.querySelector('a').textContent.toLowerCase().includes(q)||
          (li.dataset.state||'').toLowerCase().includes(q);
        li.style.display=show?'':'none';
        if(show)vis++;
      });
      g.style.display=vis===0?'none':'';
    });
    var any=document.querySelectorAll('.tech-group:not([style*="display: none"])').length>0;
    var nr=document.getElementById('no-results');
    if(nr)nr.style.display=any?'none':'';
  }
  inp.addEventListener('input',applyFilter);
})();
</script>`;

  const saveFilterBtn = user
    ? `<form method="POST" action="/saved-filters" style="display:inline">
         <input type="hidden" name="sort" value="${esc(sort)}">
         <input type="hidden" name="dir" value="${esc(dir)}">
         <input type="hidden" name="status" value="${esc(status)}">
         <input type="hidden" name="page" value="${esc(String(page))}">
         <button class="btn btn-sm" type="submit" title="Save current sort &amp; filter as a named view">Save filter…</button>
       </form>`
    : "";

  return {
    title,
    chunks: [
      head(title, description, null, null),
      navBar(user),
      `<h1>CleanTech Index</h1>
       <p class="sub">U.S. clean energy infrastructure — solar, wind, and battery storage projects with capacity, status, and hardware suppliers.</p>
       ${statsBar}
       <div class="filter-bar">
         <input id="fi" type="search" placeholder="Filter by name or state…" aria-label="Filter projects">
         <select id="fs" aria-label="Filter by status" onchange="var v=this.value;window.location.href='/?sort=${esc(sort)}&dir=${esc(dir)}&page=1'+(v?'&status='+encodeURIComponent(v):'')">
           <option value=""${!status ? " selected" : ""}>All statuses</option>
           <option value="Operational"${status === "Operational" ? " selected" : ""}>Operational</option>
           <option value="Under Construction"${status === "Under Construction" ? " selected" : ""}>Under Construction</option>
           <option value="Planned"${status === "Planned" ? " selected" : ""}>Planned</option>
         </select>
         ${saveFilterBtn}
       </div>
       ${sortBar}
       <p id="no-results" class="no-results" style="display:none">No projects match your filter.</p>
       ${listHtml}
       ${pager}`,
      filterScript,
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

/** Login page — shows email form or a "check your email" confirmation. */
export function renderLogin(opts = {}) {
  const { sent = false, error = null, flash = null } = opts;
  const title = "Sign in | CleanTech Index";
  const description = "Sign in to CleanTech Index to save projects, build watchlists, and add notes.";
  const body = sent
    ? `<h1>Check your email</h1>
       <p class="sub">We sent a sign-in link to your address. Click it to log in — it expires in 15 minutes.</p>
       <p style="font-size:13px;color:var(--mut)">Wrong address? <a href="/login">Try again</a>.</p>`
    : `<h1>Sign in to CleanTech Index</h1>
       <p class="sub">Enter your email and we'll send you a one-time sign-in link.</p>
       ${error ? `<p class="msg err">${esc(error)}</p>` : ""}
       ${flash ? `<p class="msg ok">${esc(flash)}</p>` : ""}
       <form method="POST" action="/auth/login" style="max-width:360px;margin-top:8px">
         <div style="display:flex;flex-direction:column;gap:10px">
           <input type="email" name="email" placeholder="you@example.com" required autocomplete="email"
                  style="width:100%;padding:10px 14px;border:1px solid var(--line);border-radius:8px;font-size:15px;background:#fff;color:var(--ink);outline:none">
           <button class="cta" type="submit" style="text-align:center">Send sign-in link</button>
         </div>
       </form>
       <p style="font-size:13px;color:var(--mut);margin-top:18px">No password needed. Free to create an account.</p>`;
  return { title, chunks: [head(title, description, null, null, "gate"), body, tail] };
}

/** Dashboard — user's bookmarks, watchlists, notes, saved filters. */
export function renderDashboard(user, data, flash = null) {
  const { bookmarks, watchlists, notes, filters } = data;
  const title = "My saved items | CleanTech Index";
  const description = "Your bookmarked projects, watchlists, notes, and saved filters.";

  const projectLink = (slug, name) =>
    slug ? `<a href="/project/${esc(slug)}">${esc(name || slug)}</a>` : esc(name || slug);

  const bmSection = `<div class="dash-section">
    <h2>Bookmarks (${bookmarks.length})</h2>
    ${bookmarks.length
      ? `<ul class="v">${bookmarks.map((b) =>
          `<li>${projectLink(b.project_slug, b.project_name)}
           <span>${esc(b.technology_type || "")} · ${esc(b.state || "")}</span></li>`
        ).join("")}</ul>`
      : `<p class="sub">No bookmarks yet. Browse <a href="/">projects</a> and click Bookmark.</p>`
    }
  </div>`;

  const wlSection = `<div class="dash-section">
    <h2>Watchlists (${watchlists.length})</h2>
    ${watchlists.map((wl) => `
      <div class="wl-card">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3>${esc(wl.name)}</h3>
          <form method="POST" action="/watchlists/${esc(String(wl.id))}/delete" style="margin:0">
            <button class="btn btn-sm" type="submit" style="color:var(--warn);border-color:#f0d9bf">Delete</button>
          </form>
        </div>
        ${wl.items.length
          ? `<ul>${wl.items.map((it) =>
              `<li>${projectLink(it.project_slug, it.project_name)}
               <span>${esc(it.technology_type || "")} · ${esc(it.state || "")}</span></li>`
            ).join("")}</ul>`
          : `<p style="font-size:14px;color:var(--mut);margin:0">Empty — add projects from their project pages.</p>`
        }
      </div>`).join("")}
    <form method="POST" action="/watchlists" class="form-row" style="margin-top:12px">
      <input type="text" name="name" placeholder="New watchlist name…" required>
      <button class="btn" type="submit">Create watchlist</button>
    </form>
  </div>`;

  const notesSection = `<div class="dash-section">
    <h2>Notes (${notes.length})</h2>
    ${notes.length
      ? `<ul class="v">${notes.map((n) =>
          `<li style="flex-direction:column;align-items:flex-start;gap:4px">
             <div>${projectLink(n.project_slug, n.project_name)} <span class="tag">${esc(n.updated_at?.slice(0, 10) || "")}</span></div>
             <p style="margin:0;font-size:14px;color:var(--mut);white-space:pre-wrap">${esc(n.note)}</p>
           </li>`
        ).join("")}</ul>`
      : `<p class="sub">No notes yet. Add private notes from any project page.</p>`
    }
  </div>`;

  const filtersSection = `<div class="dash-section">
    <h2>Saved filters (${filters.length})</h2>
    ${filters.length
      ? `<ul class="v">${filters.map((f) => {
          const params = (() => { try { return JSON.parse(f.filter_json); } catch { return {}; } })();
          const qs = new URLSearchParams(params).toString();
          return `<li>
            <a href="/?${esc(qs)}">${esc(f.name)}</a>
            <form method="POST" action="/saved-filters/${esc(String(f.id))}/delete" style="margin:0">
              <button class="btn btn-sm" type="submit" style="color:var(--warn);border-color:#f0d9bf">Remove</button>
            </form>
          </li>`;
        }).join("")}</ul>`
      : `<p class="sub">No saved filters. Use the Save filter button on the home page.</p>`
    }
  </div>`;

  return {
    title,
    chunks: [
      head(title, description, null, null),
      navBar(user),
      flash ? `<p class="msg ok">${esc(flash)}</p>` : "",
      `<h1>My saved items</h1><p class="sub">${esc(user.email)}</p>`,
      bmSection,
      wlSection,
      notesSection,
      filtersSection,
      tail,
    ],
  };
}

/** Save filter name prompt — shown when user clicks "Save filter" */
export function renderSaveFilterForm(user, params) {
  const title = "Save filter | CleanTech Index";
  return {
    title,
    chunks: [
      head(title, "Name and save your current filter.", null, null, "gate"),
      navBar(user),
      `<h1>Name this filter</h1>
       <form method="POST" action="/saved-filters/confirm" style="max-width:360px">
         ${Object.entries(params).map(([k, v]) =>
           `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`
         ).join("")}
         <div class="form-row" style="flex-direction:column;align-items:stretch">
           <input type="text" name="name" placeholder="e.g. Operational Solar" required style="width:100%">
           <button class="cta" type="submit" style="margin-top:10px;text-align:center">Save</button>
         </div>
       </form>`,
      tail,
    ],
  };
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
