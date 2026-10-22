#!/usr/bin/env node
/**
 * audit-schema.mjs — Diagnostic pass over every JSON-LD block in the site.
 *
 * Extracts each <script type="application/ld+json"> block and attempts a
 * strict JSON.parse(). Reports the failing pages and the exact syntax error
 * so we know precisely what is broken before we refactor anything.
 *
 * Usage: node scripts/audit-schema.mjs [--include-deploy]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const INCLUDE_DEPLOY = process.argv.includes('--include-deploy');

const LD_RE = /<script\s+type="application\/ld\+json"\s*>([\s\S]*?)<\/script>/gi;

/** Recursively collect .html files. */
function collectHtml(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.freebuff') continue;
    if (entry === 'deploy' && !INCLUDE_DEPLOY) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectHtml(full, acc);
    else if (entry.endsWith('.html')) acc.push(full);
  }
  return acc;
}

const files = collectHtml(ROOT).sort();
let totalBlocks = 0;
let okBlocks = 0;
const failures = [];
const perFile = [];

for (const file of files) {
  const html = readFileSync(file, 'utf8');
  const blocks = [...html.matchAll(LD_RE)];
  if (blocks.length === 0) continue;
  const rel = relative(ROOT, file);
  const fileResults = [];

  blocks.forEach((m, i) => {
    totalBlocks++;
    const raw = m[1];
    const label = `${rel} [block ${i + 1}/${blocks.length}]`;
    try {
      const parsed = JSON.parse(raw);
      okBlocks++;
      fileResults.push({
        label,
        ok: true,
        types: parsed['@type'] || (parsed['@graph'] ? `@graph(${(parsed['@graph'] || []).map((n) => n['@type']).join(',')})` : 'unknown'),
      });
    } catch (err) {
      failures.push({ label, ok: false, error: err.message, raw });
      fileResults.push({ label, ok: false, types: 'INVALID' });
    }
  });

  perFile.push({ rel, count: blocks.length, fileResults });
}

console.log('='.repeat(78));
console.log('JSON-LD AUDIT');
console.log('='.repeat(78));
console.log(`Files scanned : ${files.length}`);
console.log(`Blocks found  : ${totalBlocks}`);
console.log(`Valid (JSON.parse OK) : ${okBlocks}`);
console.log(`INVALID               : ${totalBlocks - okBlocks}`);
console.log('');

if (failures.length) {
  console.log('--- FAILURES ---');
  for (const f of failures) {
    console.log(`\n[FAIL] ${f.label}`);
    console.log(`       ${f.error}`);
    // Show the offending region: find the first suspicious spot by scanning
    // for a string that is never closed before a comma/brace.
    const m = /"([^"]*)",/.exec(f.raw);
    const suspect = f.raw.match(/"[^"]*"(?:,|:|\})/g);
    console.log(`       raw len: ${f.raw.length}`);
  }
  console.log('');
}

console.log('--- PER FILE ---');
for (const pf of perFile) {
  const bad = pf.fileResults.filter((r) => !r.ok).length;
  const types = pf.fileResults.map((r) => r.types).join(' | ');
  console.log(`${bad ? 'FAIL' : ' ok '} ${pf.rel}  (${pf.count} blocks)  ${types}`);
}

console.log('');
console.log('='.repeat(78));
process.exit(failures.length ? 1 : 0);
