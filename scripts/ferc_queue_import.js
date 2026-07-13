#!/usr/bin/env node
/**
 * FERC ISO Interconnection Queue importer
 *
 * Downloads queue spreadsheets from MISO, PJM, CAISO, ERCOT, SPP, NYISO,
 * and ISO-NE, maps columns to the cleantech-index schema, and writes:
 *   ferc_queue.sql  (developers + projects, INSERT OR IGNORE)
 *
 * IMPORTANT: Column mappings are printed BEFORE any SQL is written so you
 * can review and interrupt (Ctrl-C) if the mappings look wrong.
 *
 * Requires: npm install --save-dev xlsx
 */

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, '.tmp-ferc');
const OUT_FILE = path.join(ROOT, 'ferc_queue.sql');

// ── ISO Definitions ───────────────────────────────────────────────────────────
// Each entry declares candidate column names for each schema field.
// The first match (exact, then partial) wins.

const ISOS = [
  {
    name: 'MISO',
    url: 'https://www.misoenergy.org/planning/generator-interconnection/GI_Queue/GI_Queue_Active.xlsx',
    sheetHint: /active|queue/i,
    cols: {
      projectName:   ['Project Name', 'Name'],
      queueId:       ['Queue ID', 'Queue Position', 'Project Number'],
      developer:     ['Interconnection Customer', 'Developer', 'Customer', 'Applicant'],
      capacityMw:    ['Capacity (MW) In-Service', 'Capacity (MW)', 'MW In-Service', 'Net MW', 'Proposed Net Summer Capacity (MW)'],
      technology:    ['Technology Type', 'Technology', 'Fuel Type', 'Resource Type'],
      status:        ['Queue Status', 'Status', 'Project Status'],
      state:         ['State', 'Plant State'],
      county:        ['County'],
      utility:       ['Transmission Owner', 'TO', 'Balancing Authority'],
      codDate:       ['In-Service Date', 'Commercial Operation Date', 'Proposed COD', 'Expected COD'],
    },
  },
  {
    name: 'PJM',
    // PJM rotates xlsx file paths; scrape their interconnection page for the current link
    url: null,
    scrapeUrl: 'https://www.pjm.com/planning/interconnection-planning',
    scrapeLinkPattern: /interconnection[^"]*queue[^"]*\.xlsx|pjm[^"]*queue[^"]*\.xlsx/i,
    sheetHint: /queue|active|generator/i,
    cols: {
      projectName:   ['Project Name', 'Name'],
      queueId:       ['Queue Position', 'Queue Number', 'Queue ID'],
      developer:     ['Customer Name', 'Interconnection Customer', 'Developer', 'Applicant'],
      capacityMw:    ['MW (Proposed)', 'Proposed Net MW', 'Net MW (AC)', 'Capacity (MW)', 'AC MW'],
      technology:    ['Fuel', 'Technology', 'Fuel Type', 'Resource Type'],
      status:        ['Status', 'Queue Status', 'Project Status'],
      state:         ['State', 'Plant State'],
      county:        ['County'],
      utility:       ['Transmission Owner', 'Zone', 'TO'],
      codDate:       ['Proposed In-Service Date', 'In-Service Date', 'Commercial Operation Date'],
    },
  },
  {
    name: 'CAISO',
    // CAISO interconnection queue — scrape their public page to find the current xlsx link
    url: null,
    scrapeUrl: 'https://www.caiso.com/planning/Pages/GeneratorInterconnection/Default.aspx',
    scrapeLinkPattern: /GeneratorInterconnection[^"]*Queue[^"]*\.xlsx|GI[^"]*Queue[^"]*\.xlsx/i,
    sheetHint: /queue|generator|active/i,
    cols: {
      projectName:   ['Project Name', 'Name'],
      queueId:       ['Queue Position', 'Application Number', 'Queue #'],
      developer:     ['Applicant', 'Developer', 'Customer', 'Interconnection Customer'],
      capacityMw:    ['MW', 'Capacity (MW)', 'Net MW', 'Proposed Net MW', 'Summer Capacity'],
      technology:    ['Technology', 'Fuel Type', 'Resource Type', 'Fuel'],
      status:        ['Status', 'Project Status', 'Queue Status'],
      state:         ['State', 'Plant State'],
      county:        ['County', 'Location'],
      utility:       ['Transmission Provider', 'Utility', 'TO', 'Balancing Authority'],
      codDate:       ['On-line Date', 'Proposed On-line Date', 'COD', 'In-Service Date'],
    },
  },
  {
    name: 'ERCOT',
    // ERCOT rotates paths by date; scrape the page to find the current link
    url: null,
    scrapeUrl: 'https://www.ercot.com/gridinfo/resource',
    scrapeLinkPattern: /ERCOT_Interconnection_Status\.xlsx|Interconnection_Status\.xlsx/i,
    sheetHint: /status|queue|project/i,
    skipHeaderRows: 0,
    cols: {
      projectName:   ['Project Name', 'INR ID', 'Name'],
      queueId:       ['INR ID', 'Queue ID', 'Application Number'],
      developer:     ['Developer', 'Applicant', 'Customer', 'Company Name'],
      capacityMw:    ['Capacity (MW)', 'MW', 'Net MW', 'Proposed MW'],
      technology:    ['Fuel Type', 'Technology', 'Fuel', 'Resource Type'],
      status:        ['Status', 'Project Status', 'Queue Status'],
      state:         ['State'],
      county:        ['County', 'Location'],
      utility:       ['Transmission Service Provider', 'TSP', 'TO', 'Utility'],
      codDate:       ['Expected Operation Date', 'Proposed COD', 'COD', 'In-Service Date'],
    },
  },
  {
    name: 'SPP',
    // SPP document IDs rotate; scrape the queue page for the current xlsx link
    url: null,
    scrapeUrl: 'https://www.spp.org/engineering/generator-interconnection/generator-interconnection-queue/',
    scrapeLinkPattern: /generator[^"]*interconnection[^"]*queue[^"]*\.xlsx/i,
    sheetHint: /queue|generator/i,
    cols: {
      projectName:   ['Project Name', 'Name', 'Gen Name'],
      queueId:       ['Queue ID', 'Request ID', 'Position'],
      developer:     ['Customer', 'Developer', 'Applicant', 'Interconnection Customer'],
      capacityMw:    ['MW', 'Capacity (MW)', 'Net MW', 'Proposed MW'],
      technology:    ['Fuel Type', 'Technology', 'Fuel', 'Resource Type'],
      status:        ['Status', 'Queue Status', 'Project Status'],
      state:         ['State', 'Plant State'],
      county:        ['County'],
      utility:       ['Transmission Owner', 'TO', 'Utility'],
      codDate:       ['Commercial Operation Date', 'COD', 'In-Service Date', 'Proposed COD'],
    },
  },
  {
    name: 'NYISO',
    // NYISO documents portal — scrape for the current interconnection queue xlsx
    url: null,
    scrapeUrl: 'https://www.nyiso.com/interconnections',
    scrapeLinkPattern: /NYISO[^"]*Interconnection[^"]*Queue[^"]*\.xlsx|Interconnection[^"]*Queue[^"]*\.xlsx/i,
    sheetHint: /queue|active|generator/i,
    cols: {
      projectName:   ['Project Name', 'Name'],
      queueId:       ['Queue ID', 'Queue Position', 'Application Number'],
      developer:     ['Developer', 'Applicant', 'Customer', 'Company Name'],
      capacityMw:    ['MW (Proposed)', 'Proposed MW', 'MW', 'Net MW'],
      technology:    ['Type/ Fuel', 'Fuel Type', 'Technology', 'Fuel', 'Resource Type'],
      status:        ['Status', 'Queue Status', 'Project Status'],
      state:         ['State', 'Plant State'],
      county:        ['County', 'Location'],
      utility:       ['Utility', 'TO', 'Transmission Owner', 'Zone'],
      codDate:       ['Proposed COD', 'COD', 'In-Service Date', 'Commercial Operation Date'],
    },
  },
  {
    name: 'ISO-NE',
    // ISO-NE publishes a static xlsx path; fall back to scraping the page if direct fails
    url: 'https://www.iso-ne.com/static-assets/documents/sitepages/gen-int/GIS_Generators_In_Interconnection_Queue.xlsx',
    scrapeUrl: 'https://www.iso-ne.com/system-planning/interconnection-service/interconnection-request-queue',
    scrapeLinkPattern: /GIS_Generators[^"]*\.xlsx|Interconnection[^"]*Queue[^"]*\.xlsx/i,
    sheetHint: /queue|generator/i,
    cols: {
      projectName:   ['Project Name', 'Name', 'Facility Name'],
      queueId:       ['Queue ID', 'Application Number', 'Request ID'],
      developer:     ['Applicant', 'Developer', 'Customer', 'Company Name'],
      capacityMw:    ['Summer Capacity (MW)', 'Capacity (MW)', 'MW', 'Net MW'],
      technology:    ['Fuel', 'Fuel Type', 'Technology', 'Resource Type'],
      status:        ['Status', 'Queue Status', 'Project Status'],
      state:         ['State', 'Plant State'],
      county:        ['County', 'Location'],
      utility:       ['TDSP', 'Transmission Owner', 'TO', 'Utility'],
      codDate:       ['Proposed In-Service Date', 'In-Service Date', 'Proposed COD', 'COD'],
    },
  },
];

// ── Technology mapping ────────────────────────────────────────────────────────

function mapTechnology(raw) {
  if (!raw) return null;
  const v = String(raw).toLowerCase().trim();
  if (v.includes('offshore')) return 'Offshore Wind';
  if (v.includes('solar') || v.includes('pv') || v.includes('photovoltaic')) return 'Solar PV';
  if (v.includes('wind')) return 'Onshore Wind';
  if (v.includes('batter') || v.includes('bess') || v.includes('storage') || v.includes('energy storage')) return 'Battery Storage';
  return null;
}

// ── Status mapping ────────────────────────────────────────────────────────────

function mapStatus(raw) {
  if (!raw) return 'Planned';
  const v = String(raw).toLowerCase().trim();
  if (v.includes('operational') || v.includes('in service') || v.includes('commercial') || v.includes('energized')) return 'Operational';
  if (v.includes('construction') || v.includes('under const') || v.includes('build') || v.includes('commissioning')) return 'Under Construction';
  if (v.includes('withdrawn') || v.includes('cancelled') || v.includes('terminated') || v.includes('suspended')) return 'SKIP';
  // Active, pending, study, executed, etc. → Planned
  return 'Planned';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeXlsxUrl(pageUrl, pattern) {
  const html = (await httpsGetBuf(pageUrl)).toString('utf8');
  // Match both href and src attributes containing .xlsx
  const hrefMatches = [...html.matchAll(/href="([^"]+\.xlsx[^"]*)"/gi)].map(m => m[1]);
  const srcMatches  = [...html.matchAll(/src="([^"]+\.xlsx[^"]*)"/gi)].map(m => m[1]);
  const all = [...hrefMatches, ...srcMatches];
  // Also look for bare URLs in script/data attributes
  const dataMatches = [...html.matchAll(/["']((?:https?:\/\/[^"']+|\/[^"']+)\.xlsx[^"']*?)["']/gi)].map(m => m[1]);
  const candidates = [...all, ...dataMatches];
  const hit = candidates.find(h => pattern.test(h));
  if (!hit) return null;
  return new URL(hit, pageUrl).href;
}

function httpsGetBuf(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const follow = (u, depth = 0) => {
      if (depth > 8) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 cleantech-index-importer/1.0',
          'Accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,*/*',
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const loc = res.headers.location;
          const next = loc.startsWith('http') ? loc : new URL(loc, u).href;
          return follow(next, depth + 1);
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

// ── Column resolver ───────────────────────────────────────────────────────────

function resolveColumns(header, colDef) {
  const resolved = {};
  for (const [field, candidates] of Object.entries(colDef)) {
    // Exact match first
    let found = candidates.find(c => header.includes(c)) ?? null;
    if (!found) {
      // Case-insensitive partial match
      const lowers = candidates.map(c => c.toLowerCase());
      found = header.find(h => lowers.some(l => String(h).toLowerCase().includes(l))) ?? null;
      if (found) {
        // will note this in mapping printout
        resolved[field] = { col: found, fuzzy: true };
        continue;
      }
    }
    resolved[field] = found ? { col: found, fuzzy: false } : null;
  }
  return resolved;
}

function printMapping(isoName, resolved, colDef) {
  console.log(`\n  ${isoName}:`);
  for (const [field, result] of Object.entries(resolved)) {
    if (!result) {
      console.log(`    ${field.padEnd(28)} ← !! NOT FOUND (candidates: ${colDef[field].join(', ')})`);
    } else {
      const tag = result.fuzzy ? ' [fuzzy match]' : '';
      console.log(`    ${field.padEnd(28)} ← "${result.col}"${tag}`);
    }
  }
}

// ── COD year extractor ────────────────────────────────────────────────────────

function extractYear(val) {
  if (!val) return null;
  const s = String(val);
  // Excel numeric date serial
  const num = parseFloat(s);
  if (!isNaN(num) && num > 1000 && num < 100000) {
    // Excel date serial to JS date
    const d = new Date(Date.UTC(1899, 11, 30) + num * 86400000);
    const y = d.getUTCFullYear();
    return y > 1990 && y < 2060 ? y : null;
  }
  // String date patterns
  const m = s.match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

// ── Process one ISO ───────────────────────────────────────────────────────────

async function processISO(iso, developers, projects) {
  let downloadUrl = iso.url;

  // ISOs with rotating URLs: scrape their page to find the current xlsx link
  if (!downloadUrl && iso.scrapeUrl) {
    console.log(`\n[${iso.name}] Scraping ${iso.scrapeUrl} for xlsx link...`);
    try {
      downloadUrl = await scrapeXlsxUrl(iso.scrapeUrl, iso.scrapeLinkPattern);
    } catch (err) {
      console.error(`  ERROR scraping page: ${err.message} — skipping ${iso.name}`);
      return;
    }
    if (!downloadUrl) {
      console.error(`  ERROR: no xlsx link found on page matching ${iso.scrapeLinkPattern} — skipping ${iso.name}`);
      return;
    }
    console.log(`  Found: ${downloadUrl}`);
  }

  // ISOs with a known direct URL but also a scrapeUrl fallback (e.g. ISO-NE)
  // We'll try the direct URL first; if it fails, fall back to scraping
  if (downloadUrl && iso.scrapeUrl) {
    // We'll handle fallback in the download block below
  }

  console.log(`\n[${iso.name}] Downloading ${downloadUrl}`);
  let buf;
  try {
    buf = await httpsGetBuf(downloadUrl);
    if (buf.length < 1000 && iso.scrapeUrl) {
      // Direct URL gave tiny/empty response; try scraping for a better URL
      console.log(`  Direct URL gave ${buf.length} bytes — trying scrape fallback...`);
      const fallback = await scrapeXlsxUrl(iso.scrapeUrl, iso.scrapeLinkPattern).catch(() => null);
      if (fallback && fallback !== downloadUrl) {
        console.log(`  Fallback URL: ${fallback}`);
        buf = await httpsGetBuf(fallback);
      }
    }
  } catch (err) {
    // Direct URL failed; try scrape fallback if available
    if (iso.scrapeUrl) {
      console.log(`  Direct URL failed (${err.message}) — trying scrape fallback from ${iso.scrapeUrl}`);
      try {
        const fallback = await scrapeXlsxUrl(iso.scrapeUrl, iso.scrapeLinkPattern);
        if (fallback) {
          console.log(`  Fallback URL: ${fallback}`);
          buf = await httpsGetBuf(fallback);
        } else {
          console.error(`  ERROR: no xlsx link found on fallback page — skipping ${iso.name}`);
          return;
        }
      } catch (err2) {
        console.error(`  ERROR: ${err2.message} — skipping ${iso.name}`);
        return;
      }
    } else {
      console.error(`  ERROR: ${err.message} — skipping ${iso.name}`);
      return;
    }
  }

  if (buf.length < 1000) {
    console.error(`  ERROR: Response too small (${buf.length} bytes) — likely not an Excel file, skipping`);
    return;
  }

  let wb;
  try {
    wb = XLSX.read(buf, { type: 'buffer', cellDates: false, raw: false });
  } catch (err) {
    console.error(`  ERROR parsing Excel: ${err.message} — skipping`);
    return;
  }

  const sheetName = wb.SheetNames.find(n => iso.sheetHint.test(n)) ?? wb.SheetNames[0];
  console.log(`  Sheet: "${sheetName}"`);
  const ws = wb.Sheets[sheetName];

  // Detect real header row (some ISOs have preamble rows before the column header row)
  const HEADER_KEYWORDS = ['project', 'queue', 'developer', 'capacity', 'technology', 'status',
    'fuel', 'mw', 'applicant', 'customer', 'interconnection', 'state'];
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: false });
  let headerRowIdx = 0;
  for (let r = 0; r < Math.min(10, rawRows.length); r++) {
    const rowStr = rawRows[r].map(c => String(c ?? '').toLowerCase()).join(' ');
    const hits = HEADER_KEYWORDS.filter(k => rowStr.includes(k)).length;
    if (hits >= 2) { headerRowIdx = r; break; }
  }
  if (headerRowIdx > 0) console.log(`  Detected header row at index ${headerRowIdx} (${headerRowIdx} preamble rows skipped)`);

  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false, range: headerRowIdx });

  if (!rows.length) { console.error('  ERROR: Sheet is empty — skipping'); return; }

  const header = Object.keys(rows[0]);
  const resolved = resolveColumns(header, iso.cols);

  // Print mapping (for user review)
  printMapping(iso.name, resolved, iso.cols);

  let kept = 0, skippedTech = 0, skippedStatus = 0, skippedCap = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // 1-indexed + header

    const get = (field) => {
      const r = resolved[field];
      return r ? row[r.col] : null;
    };
    const warn = (msg) => console.warn(`  WARN [${iso.name}] row ${rowNum}: ${msg}`);

    const techRaw = get('technology');
    const tech = mapTechnology(techRaw);
    if (!tech) {
      if (techRaw !== null && techRaw !== undefined && String(techRaw).trim())
        skippedTech++;
      continue;
    }

    const statusRaw = get('status');
    const status = mapStatus(statusRaw);
    if (status === 'SKIP') { skippedStatus++; continue; }

    const capRaw = parseFloat(get('capacityMw'));
    if (!capRaw || capRaw < 10) { skippedCap++; continue; }

    const devNameRaw = get('developer');
    const devName = devNameRaw ? String(devNameRaw).trim() : 'Unknown Developer';
    const devSlug = slugify(devName);

    const stateRaw = get('state');
    const devState = stateRaw ? String(stateRaw).trim().slice(0, 2).toUpperCase() : null;

    if (!developers.has(devSlug)) {
      developers.set(devSlug, { name: devName, state: devState, totalMw: 0 });
    }
    const dev = developers.get(devSlug);
    dev.totalMw = Math.round((dev.totalMw + capRaw) * 100) / 100;

    const projNameRaw = get('projectName');
    const queueId = get('queueId');
    const projName = [projNameRaw, queueId ? `(${queueId})` : ''].filter(Boolean).join(' ').trim() || `${iso.name} Project`;
    const projSlug = slugify(`${iso.name} ${projName}`);

    const county = get('county') ? String(get('county')).trim() : null;
    const state = devState;
    const utilRaw = get('utility');
    const interUtil = utilRaw ? String(utilRaw).trim() : null;
    const opYear = extractYear(get('codDate'));

    // Warn on null critical fields
    if (!devNameRaw) warn(`no developer name — using "Unknown Developer"`);
    if (!utilRaw) warn(`no interconnection_utility — inserting NULL`);
    if (!stateRaw) warn(`no state — inserting NULL`);

    projects.push({
      source: iso.name,
      devSlug,
      projectName: projName,
      slug: projSlug,
      technology: tech,
      capacity: capRaw,
      status,
      interUtil,
      opYear,
      county,
      state,
    });
    kept++;
  }

  console.log(`  Results: ${kept} kept, ${skippedTech} skipped (tech), ${skippedStatus} skipped (withdrawn), ${skippedCap} skipped (cap<10)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  console.log('=== FERC ISO INTERCONNECTION QUEUE IMPORTER ===');
  console.log(`Importing from ${ISOS.length} ISOs: ${ISOS.map(i => i.name).join(', ')}`);
  console.log('\nColumn mappings will be printed before any SQL is written.');
  console.log('Press Ctrl-C to abort if the mappings look wrong.\n');
  console.log('=== COLUMN MAPPINGS ===');

  const developers = new Map(); // slug → { name, state, totalMw }
  const projects = [];

  for (const iso of ISOS) {
    await processISO(iso, developers, projects);
    await sleep(600); // be polite to ISO servers
  }

  if (!projects.length) {
    console.warn('\nWARN: No projects collected — all ISOs may have failed. Check errors above. No SQL written.');
    process.exit(0); // non-fatal: EIA data may already be loaded
  }

  // ── Write ferc_queue.sql ──
  console.log('\n\n=== WRITING SQL ===');

  const lines = [
    `-- FERC ISO interconnection queue import, generated ${new Date().toISOString().slice(0, 10)}`,
    `-- Sources: MISO, PJM, CAISO, ERCOT, SPP, NYISO, ISO-NE`,
    `-- Run AFTER eia860_developers.sql (or standalone) with:`,
    `--   wrangler d1 execute cleantech_index --remote --file=ferc_queue.sql`,
    `--`,
    `-- Section 1: Developers`,
    `-- INSERT OR IGNORE means existing developers are preserved; new ones added.`,
    '',
  ];

  for (const [slug, d] of developers) {
    lines.push(
      `INSERT OR IGNORE INTO energy_developers (name, slug, headquarters_state, total_portfolio_mw) VALUES (${esc(d.name)}, ${esc(slug)}, ${esc(d.state)}, ${esc(d.totalMw)});`
    );
  }

  lines.push('', `-- Section 2: Projects`, '');

  for (const p of projects) {
    lines.push(
      `INSERT OR IGNORE INTO infrastructure_projects ` +
      `(developer_id, project_name, slug, technology_type, capacity_mw, status, interconnection_utility, commercial_operation_year, county, state) ` +
      `SELECT id, ${esc(p.projectName)}, ${esc(p.slug)}, ${esc(p.technology)}, ${esc(p.capacity)}, ${esc(p.status)}, ${esc(p.interUtil)}, ${esc(p.opYear)}, ${esc(p.county)}, ${esc(p.state)} ` +
      `FROM energy_developers WHERE slug = ${esc(p.devSlug)} LIMIT 1;`
    );
  }

  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n');
  console.log(`Wrote ${developers.size} developers + ${projects.length} projects → ${OUT_FILE}`);

  // ── Summary ──
  const byTech = {};
  const byStatus = {};
  const byISO = {};
  for (const p of projects) {
    byTech[p.technology] = (byTech[p.technology] ?? 0) + 1;
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
    byISO[p.source] = (byISO[p.source] ?? 0) + 1;
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Developers: ${developers.size}`);
  console.log(`Projects:   ${projects.length}`);
  console.log('\nBy ISO:');
  for (const [s, n] of Object.entries(byISO)) {
    console.log(`  ${s.padEnd(10)} ${n}`);
  }
  console.log('\nBy technology:');
  for (const [t, n] of Object.entries(byTech).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(20)} ${n}`);
  }
  console.log('\nBy status:');
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)} ${n}`);
  }

  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('\nDone.');
  console.log('  wrangler d1 execute cleantech_index --remote --file=ferc_queue.sql');
}

main().catch(err => { console.error(err.message); process.exit(1); });
