#!/usr/bin/env node
/**
 * Splits a SQL file into chunks of at most CHUNK_LINES statements and applies
 * each chunk to a D1 database via `wrangler d1 execute --remote --file=`.
 *
 * Usage: node scripts/split-and-apply.js <sql-file> <database-name>
 *
 * Designed for GitHub Actions where CLOUDFLARE_API_TOKEN and
 * CLOUDFLARE_ACCOUNT_ID are set as environment variables.
 *
 * D1's --file flag has a practical limit of ~10 MB per call; chunking keeps
 * each batch well under that ceiling even for large EIA/FERC datasets.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHUNK_LINES = 2000; // statements per wrangler call

const [, , sqlFile, dbName] = process.argv;
if (!sqlFile || !dbName) {
  console.error('Usage: node scripts/split-and-apply.js <sql-file> <database-name>');
  process.exit(1);
}

if (!fs.existsSync(sqlFile)) {
  console.error(`File not found: ${sqlFile}`);
  process.exit(1);
}

const content = fs.readFileSync(sqlFile, 'utf8');

// Split on statement boundaries (lines ending with ;)
// Comments and blank lines are kept with the next real statement.
const lines = content.split('\n');
const chunks = [];
let current = [];

for (const line of lines) {
  current.push(line);
  // A line that ends with ; (after trimming) closes a statement
  if (line.trimEnd().endsWith(';')) {
    if (current.length >= CHUNK_LINES) {
      chunks.push(current.join('\n'));
      current = [];
    }
  }
}
if (current.some(l => l.trim())) {
  chunks.push(current.join('\n'));
}

if (!chunks.length) {
  console.log(`${sqlFile}: nothing to apply.`);
  process.exit(0);
}

const totalStatements = (content.match(/;$/gm) || []).length;
console.log(`${sqlFile}: ${totalStatements} statements → ${chunks.length} chunk(s)`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-d1-'));

for (let i = 0; i < chunks.length; i++) {
  const chunkFile = path.join(tmpDir, `chunk-${i + 1}.sql`);
  fs.writeFileSync(chunkFile, chunks[i]);
  const chunkStatements = (chunks[i].match(/;$/gm) || []).length;
  process.stdout.write(`  chunk ${i + 1}/${chunks.length} (${chunkStatements} statements)... `);

  try {
    execSync(
      `npx wrangler d1 execute ${dbName} --remote --file="${chunkFile}"`,
      { stdio: 'pipe', env: process.env }
    );
    console.log('ok');
  } catch (err) {
    console.log('FAILED');
    console.error(err.stderr?.toString() || err.message);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`Done applying ${sqlFile} to ${dbName}.`);
