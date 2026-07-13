#!/usr/bin/env node
/**
 * EIA Form 860 Schedule 3 importer
 *
 * Downloads the most recent annual EIA 860 zip, extracts the generator
 * schedule Excel file, filters to clean-energy technologies >= 10 MW,
 * and writes two SQL files ready for:
 *   wrangler d1 execute cleantech_index --remote --file=eia860_developers.sql
 *   wrangler d1 execute cleantech_index --remote --file=eia860_projects.sql
 *
 * Requires: npm install --save-dev xlsx
 */

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP_DIR = path.join(ROOT, '.tmp-eia860');
const OUT_DIR = ROOT;

// ── Technology mapping ────────────────────────────────────────────────────────

const TECH_MAP = {
  'Solar Photovoltaic': 'Solar PV',
  'Onshore Wind Turbine': 'Onshore Wind',
  'Offshore Wind Turbine': 'Offshore Wind',
  'Batteries': 'Battery Storage',
  // Variants seen in older EIA releases
  'All Other': null,
  'Natural Gas': null,
};

function mapTechnology(raw) {
  if (!raw) return null;
  const key = String(raw).trim();
  if (Object.prototype.hasOwnProperty.call(TECH_MAP, key)) return TECH_MAP[key];
  const lower = key.toLowerCase();
  if (lower.includes('solar') || lower.includes('photovoltaic')) return 'Solar PV';
  if (lower.includes('offshore wind')) return 'Offshore Wind';
  if (lower.includes('wind')) return 'Onshore Wind';
  if (lower.includes('batter') || lower.includes('storage')) return 'Battery Storage';
  return null;
}

// ── Status mapping ────────────────────────────────────────────────────────────

const STATUS_MAP = {
  OP: 'Operational',
  SB: 'Operational',   // standby — treat as operational
  OS: 'Operational',   // out-of-service — treat as operational
  TS: 'Under Construction',
  U: 'Under Construction',
  V: 'Under Construction',
  P: 'Planned',
  T: 'Planned',
  L: 'Planned',
  RE: 'Planned',
  CN: null,            // cancelled — skip
};

function mapStatus(raw) {
  if (!raw) return 'Planned';
  const key = String(raw).trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(STATUS_MAP, key)) return STATUS_MAP[key];
  console.warn(`WARN status "${raw}" has no mapping — defaulting to Planned`);
  return 'Planned';
}

// ── Slug helpers ──────────────────────────────────────────────────────────────

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const follow = (u, depth = 0) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'cleantech-index-importer/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) {
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

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, depth = 0) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      https.get(u, { headers: { 'User-Agent': 'cleantech-index-importer/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

// ── Column finder (fuzzy) ─────────────────────────────────────────────────────

function findCol(header, candidates) {
  for (const c of candidates) {
    const exact = header.find(h => String(h).trim() === c);
    if (exact !== undefined) return exact;
  }
  // Partial match fallback
  const lower = candidates.map(c => c.toLowerCase());
  const match = header.find(h => lower.some(l => String(h).toLowerCase().includes(l)));
  if (match !== undefined) {
    console.warn(`WARN column fuzzy-matched "${match}" for candidates [${candidates.join(', ')}]`);
    return match;
  }
  return null;
}

// ── SQL escaping ──────────────────────────────────────────────────────────────

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });

  // 1. Discover latest zip URL
  const PAGE_URL = 'https://www.eia.gov/electricity/data/eia860/';
  console.log('Fetching EIA 860 data page...');
  const html = (await httpsGet(PAGE_URL)).toString('utf8');
  // Match any zip href that contains "eia860" followed by a 4-digit year anywhere in the name
  const matches = [...html.matchAll(/href="([^"]*eia860[^"]*\d{4}[^"]*\.zip)"/gi)];
  if (!matches.length) throw new Error('Could not find EIA 860 zip link on page');

  // Resolve all hrefs against the page URL, then pick the one with the highest year number
  const zipLinks = matches
    .map(m => new URL(m[1], PAGE_URL).href)
    .sort()
    .reverse();
  const zipUrl = zipLinks[0];
  console.log(`Found zip: ${zipUrl}`);

  // 2. Download zip
  const zipPath = path.join(TMP_DIR, 'eia860.zip');
  console.log('Downloading zip (this may take a moment)...');
  await downloadToFile(zipUrl, zipPath);
  console.log(`Downloaded ${(fs.statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB`);

  // 3. Extract generator schedule file
  console.log('Extracting generator schedule file...');

  // List zip contents first so we know what to look for
  let zipContents = '';
  try {
    zipContents = execSync(`unzip -l "${zipPath}"`, { stdio: 'pipe' }).toString();
  } catch (e) {
    zipContents = e.stdout?.toString() || '';
  }
  // Find generator schedule entries
  const generatorEntries = zipContents.split('\n')
    .map(l => l.trim().split(/\s+/).pop())
    .filter(f => f && /3_1_generator/i.test(f) && /\.(xlsx|xls)$/i.test(f));
  console.log(`Zip generator entries: ${generatorEntries.length ? generatorEntries.join(', ') : '(none found — will extract all)'}`);

  if (generatorEntries.length) {
    // Extract only the generator file(s)
    for (const entry of generatorEntries) {
      try {
        execSync(`unzip -o "${zipPath}" "${entry}" -d "${TMP_DIR}"`, { stdio: 'inherit' });
      } catch { /* ignore */ }
    }
  } else {
    // No generator file found by name — extract everything and we'll search
    console.log('Extracting all xlsx files from zip...');
    execSync(`unzip -o "${zipPath}" "*.xlsx" "*.xls" -d "${TMP_DIR}"`, { stdio: 'inherit' });
  }

  // Walk TMP_DIR recursively to find generator xlsx
  function findXlsx(dir) {
    const results = [];
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) results.push(...findXlsx(full));
      else if (/\.(xlsx|xls)$/i.test(f)) results.push(full);
    }
    return results;
  }
  const allXlsx = findXlsx(TMP_DIR);
  console.log(`All xlsx files found: ${allXlsx.map(f => path.relative(TMP_DIR, f)).join(', ') || '(none)'}`);

  let xlsxPath = allXlsx.find(f => /3_1_generator/i.test(path.basename(f)));
  if (!xlsxPath) {
    // Fall back to any xlsx that looks like a generator schedule
    xlsxPath = allXlsx.find(f => /generator/i.test(path.basename(f)));
  }
  if (!xlsxPath && allXlsx.length) {
    console.warn(`WARN no generator-named file found; trying first xlsx: ${allXlsx[0]}`);
    xlsxPath = allXlsx[0];
  }
  if (!xlsxPath) throw new Error('No xlsx files found after extraction');

  console.log(`Parsing: ${path.relative(TMP_DIR, xlsxPath)}`);

  // 4. Parse Excel
  const wb = XLSX.readFile(xlsxPath, { cellDates: true });
  console.log(`Sheet names: ${wb.SheetNames.join(', ')}`);

  // Look for the "Operable" sheet (Schedule 3 generators)
  const sheetName = wb.SheetNames.find(n => /operable/i.test(n)) ?? wb.SheetNames[0];
  console.log(`Using sheet: "${sheetName}"`);
  const ws = wb.Sheets[sheetName];

  // EIA 860 often has 1-2 header rows before the actual column headers; detect by
  // finding the first row that contains "Plant Name" or "Generator ID" etc.
  const rawRows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false, header: 1 });
  let headerRowIdx = 0;
  for (let i = 0; i < Math.min(10, rawRows.length); i++) {
    const r = rawRows[i].map(c => String(c ?? '').toLowerCase());
    if (r.some(c => c.includes('plant name') || c.includes('generator id') || c.includes('nameplate') || c.includes('technology'))) {
      headerRowIdx = i;
      break;
    }
  }
  console.log(`Header row detected at index ${headerRowIdx}`);

  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false, range: headerRowIdx });
  if (!rows.length) throw new Error('Sheet is empty after header detection');
  const header = Object.keys(rows[0]);
  console.log(`Rows: ${rows.length}, Columns: ${header.length}`);
  console.log(`First 40 column names: ${header.slice(0, 40).join(' | ')}`);

  // Map column names (fuzzy) — candidates ordered most-likely first
  const COL = {
    plantName:    findCol(header, ['Plant Name', 'Facility Name', 'Plant', 'Plant Id']),
    generatorId:  findCol(header, ['Generator ID', 'Gen ID', 'Generator Id', 'Generator']),
    utilityName:  findCol(header, ['Utility Name', 'Entity Name', 'Respondent Name', 'Company', 'Owner', 'Operator Name']),
    technology:   findCol(header, ['Technology', 'Technology Description', 'Prime Mover', 'Energy Source 1']),
    capacity:     findCol(header, ['Nameplate Capacity (MW)', 'Nameplate Capacity', 'Summer Capacity (MW)', 'MW Nameplate', 'Capacity (MW)', 'Net Summer Capacity (MW)']),
    status:       findCol(header, ['Status', 'Generator Status', 'Operating Status', 'Unit Status']),
    county:       findCol(header, ['County', 'County Name']),
    state:        findCol(header, ['State', 'Plant State', 'State of Plant']),
    utility:      findCol(header, ['Balancing Authority Code', 'Balancing Authority', 'BA Code', 'Transmission Owner', 'Utility Name']),
    opYear:       findCol(header, ['Operating Year', 'Commercial Operation Year', 'Operating Year (planned)', 'Year']),
  };

  // Always log resolved column mapping
  console.log('\nColumn mapping:');
  for (const [k, v] of Object.entries(COL)) {
    console.log(`  ${k.padEnd(14)} ← ${v ? `"${v}"` : '!! NOT FOUND'}`);
  }

  // Warn about missing critical columns
  for (const [k, v] of Object.entries(COL)) {
    if (!v) console.warn(`WARN column not found for field "${k}"`);
  }

  // Log a sample row so column mismatches are immediately visible
  if (rows.length > 0) {
    const sample = rows[0];
    console.log('\nFirst data row sample (first 15 fields):');
    Object.entries(sample).slice(0, 15).forEach(([k, v]) => console.log(`  "${k}": ${JSON.stringify(v)}`));
  }

  // 5. Filter and collect
  const developers = new Map(); // slug → { name, state, totalMw }
  const projects = [];
  let skippedTech = 0, skippedCap = 0, skippedStatus = 0;

  for (const row of rows) {
    const techRaw = row[COL.technology];
    const techMapped = mapTechnology(techRaw);
    if (!techMapped) { skippedTech++; continue; }

    const capRaw = parseFloat(row[COL.capacity]);
    if (!capRaw || capRaw < 10) { skippedCap++; continue; }

    const statusRaw = row[COL.status];
    const statusMapped = mapStatus(statusRaw);
    if (!statusMapped) { skippedStatus++; continue; } // cancelled

    const devName = String(row[COL.utilityName] || 'Unknown Developer').trim();
    const devSlug = slugify(devName);
    const devState = String(row[COL.state] || '').trim().slice(0, 2).toUpperCase() || null;

    if (!developers.has(devSlug)) {
      developers.set(devSlug, { name: devName, state: devState, totalMw: 0 });
    }
    const dev = developers.get(devSlug);
    dev.totalMw = Math.round((dev.totalMw + capRaw) * 100) / 100;

    const plantName = String(row[COL.plantName] || 'Unknown Plant').trim();
    const genId = String(row[COL.generatorId] || '').trim();
    const projectSlug = slugify(`${plantName} ${genId}`);
    const county = row[COL.county] ? String(row[COL.county]).trim() : null;
    const state = devState;
    const interUtil = row[COL.utility] ? String(row[COL.utility]).trim() : null;
    const opYearRaw = row[COL.opYear];
    let opYear = null;
    if (opYearRaw) {
      const y = parseInt(opYearRaw, 10);
      if (y > 1950 && y < 2100) opYear = y;
    }

    projects.push({
      devSlug,
      projectName: plantName + (genId ? ` (${genId})` : ''),
      slug: projectSlug,
      technology: techMapped,
      capacity: capRaw,
      status: statusMapped,
      interUtil,
      opYear,
      county,
      state,
    });
  }

  console.log(`\nFilter results:`);
  console.log(`  Kept:             ${projects.length} generators`);
  console.log(`  Skipped (tech):   ${skippedTech}`);
  console.log(`  Skipped (cap<10): ${skippedCap}`);
  console.log(`  Skipped (cancelled): ${skippedStatus}`);

  // 6. Write eia860_developers.sql
  const devOut = path.join(OUT_DIR, 'eia860_developers.sql');
  const devLines = [
    `-- EIA Form 860 developers, generated ${new Date().toISOString().slice(0, 10)}`,
    `-- Source: https://www.eia.gov/electricity/data/eia860/`,
    `-- Run: wrangler d1 execute cleantech_index --remote --file=eia860_developers.sql`,
    '',
  ];
  for (const [slug, d] of developers) {
    devLines.push(
      `INSERT OR IGNORE INTO energy_developers (name, slug, headquarters_state, total_portfolio_mw) VALUES (${esc(d.name)}, ${esc(slug)}, ${esc(d.state)}, ${esc(d.totalMw)});`
    );
  }
  fs.writeFileSync(devOut, devLines.join('\n') + '\n');
  console.log(`\nWrote ${developers.size} developers → ${devOut}`);

  // 7. Write eia860_projects.sql
  const projOut = path.join(OUT_DIR, 'eia860_projects.sql');
  const projLines = [
    `-- EIA Form 860 infrastructure projects, generated ${new Date().toISOString().slice(0, 10)}`,
    `-- Source: https://www.eia.gov/electricity/data/eia860/`,
    `-- Run: wrangler d1 execute cleantech_index --remote --file=eia860_projects.sql`,
    `-- NOTE: Run eia860_developers.sql first so developer_id subselects resolve.`,
    '',
  ];
  for (const p of projects) {
    projLines.push(
      `INSERT OR IGNORE INTO infrastructure_projects ` +
      `(developer_id, project_name, slug, technology_type, capacity_mw, status, interconnection_utility, commercial_operation_year, county, state) ` +
      `SELECT id, ${esc(p.projectName)}, ${esc(p.slug)}, ${esc(p.technology)}, ${esc(p.capacity)}, ${esc(p.status)}, ${esc(p.interUtil)}, ${esc(p.opYear)}, ${esc(p.county)}, ${esc(p.state)} ` +
      `FROM energy_developers WHERE slug = ${esc(p.devSlug)} LIMIT 1;`
    );
  }
  fs.writeFileSync(projOut, projLines.join('\n') + '\n');
  console.log(`Wrote ${projects.length} projects → ${projOut}`);

  // 8. Summary
  const byTech = {};
  const byStatus = {};
  for (const p of projects) {
    byTech[p.technology] = (byTech[p.technology] ?? 0) + 1;
    byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
  }

  console.log('\n=== SUMMARY ===');
  console.log(`Developers: ${developers.size}`);
  console.log(`Projects:   ${projects.length}`);
  console.log('\nBy technology:');
  for (const [t, n] of Object.entries(byTech).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t.padEnd(20)} ${n}`);
  }
  console.log('\nBy status:');
  for (const [s, n] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${s.padEnd(20)} ${n}`);
  }

  // Cleanup tmp dir
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  console.log('\nDone. Next steps:');
  console.log('  wrangler d1 execute cleantech_index --remote --file=eia860_developers.sql');
  console.log('  wrangler d1 execute cleantech_index --remote --file=eia860_projects.sql');
}

main().catch(err => { console.error(err.message); process.exit(1); });
