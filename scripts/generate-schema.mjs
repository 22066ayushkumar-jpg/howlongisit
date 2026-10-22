#!/usr/bin/env node
/**
 * generate-schema.mjs — Write the structured data into the pages.
 *
 * For each page it removes every existing <script type="application/ld+json">
 * block and inserts exactly one, built by scripts/lib/schema.mjs and
 * serialized with JSON.stringify(). The output is a single @graph per page.
 *
 * Usage:
 *   node scripts/generate-schema.mjs           # rewrite pages in place
 *   node scripts/generate-schema.mjs --check   # fail if pages are out of date
 *   node scripts/generate-schema.mjs --root    # only the site root
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { pages } from './site-data.mjs';
import { applySchema, renderBlock } from './lib/inject.mjs';

const ROOT = process.cwd();
const CHECK_ONLY = process.argv.includes('--check');
const ROOT_ONLY = process.argv.includes('--root');

/** Where the site is published from. */
const TARGETS = ROOT_ONLY ? [ROOT] : [ROOT, join(ROOT, 'deploy')];

/** Resolve a model page to its file inside a given target root. */
function targetFile(targetRoot, page) {
  return join(targetRoot, page.file.split('/').join(sep));
}

let changed = 0;
let unchanged = 0;
let missing = 0;
const problems = [];

for (const targetRoot of TARGETS) {
  if (!existsSync(targetRoot)) continue;
  for (const page of pages) {
    const file = targetFile(targetRoot, page);
    if (!existsSync(file)) {
      missing++;
      problems.push(`MISSING  ${relative(ROOT, file)}`);
      continue;
    }
    const original = readFileSync(file, 'utf8');
    const updated = applySchema(original, renderBlock(page));

    if (updated === original) {
      unchanged++;
      continue;
    }
    changed++;
    if (!CHECK_ONLY) {
      writeFileSync(file, updated);
      console.log(`  updated  ${relative(ROOT, file)}`);
    } else {
      problems.push(`STALE    ${relative(ROOT, file)}`);
    }
  }
}

if (CHECK_ONLY) {
  if (problems.length) {
    console.error('FAIL: structured data is out of date.');
    for (const p of problems) console.error(`  ${p}`);
    console.error('  Run: node scripts/generate-schema.mjs');
    process.exit(1);
  }
  console.log('OK: structured data is up to date.');
  process.exit(0);
}

console.log('');
console.log(`changed:   ${changed}`);
console.log(`unchanged: ${unchanged}`);
console.log(`missing:   ${missing}`);
if (missing) {
  console.error('');
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
