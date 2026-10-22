#!/usr/bin/env node
/**
 * build-site-data.mjs — Derive the structured-data model from the rendered site.
 *
 * Reads the pages that actually exist on disk and writes scripts/site-data.mjs,
 * the single source of truth used by generate-schema.mjs. Because the facts
 * are read out of the HTML (title, meta description, canonical, visible FAQ,
 * visible breadcrumb), the structured data cannot drift from page content.
 *
 * Usage:
 *   node scripts/build-site-data.mjs          # write scripts/site-data.mjs
 *   node scripts/build-site-data.mjs --check  # fail if site-data.mjs is stale
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  getTitle,
  getMeta,
  getCanonical,
  getVisibleFaqs,
  getVisibleBreadcrumb,
  getDateModified,
  getJsonLdBlocks,
} from './lib/page-facts.mjs';

const ROOT = process.cwd();
const OUT = join(ROOT, 'scripts', 'site-data.mjs');
const CHECK_ONLY = process.argv.includes('--check');

/** Collect every page that should carry structured data. */
function collectPages() {
  const pages = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === '.freebuff') continue;
      if (entry === 'deploy' || entry === 'scripts') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'index.html') pages.push(full);
    }
  };
  walk(ROOT);
  return pages.sort();
}

const SITE = {
  name: 'How Long Is Inch?',
  origin: 'https://howlongisinch.com',
  description:
    'Visualize measurements with actual-size rulers. See inches at their true actual size and compare them with familiar everyday objects.',
};

/**
 * Parse the JSON-LD blocks on a page and flatten them into individual nodes.
 *
 * Pages now carry a single @graph, but legacy pages carry flat top-level
 * blocks, and a page may carry several of either. Both shapes are flattened
 * to the same list of nodes so the extractor does not depend on the layout.
 */
function parseBlocksTolerantly(html) {
  const nodes = [];
  for (const raw of getJsonLdBlocks(html)) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Legacy blocks that lost a closing quote — the data is re-derived from
      // the visible page below, so a failed parse is not fatal here.
      continue;
    }
    if (Array.isArray(parsed['@graph'])) {
      nodes.push(...parsed['@graph']);
    } else {
      nodes.push(parsed);
    }
  }
  return nodes;
}

/** Pull the label ("5 inches") and centimetre value from a measurement page. */
function deriveMeasurementMeta(html, url, title) {
  const cmMatch = (title || '').match(/\(([\d.]+)\s*cm\)/i);
  const centimeters = cmMatch ? cmMatch[1] : null;

  const crumbs = getVisibleBreadcrumb(html);
  let label = crumbs && crumbs.length ? crumbs[crumbs.length - 1].name : null;
  if (!label) {
    const slug = url.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    const num = slug.match(/(\d+)-inch(?:es)?$/);
    label = num ? `${num[1]} ${num[1] === '1' ? 'inch' : 'inches'}` : slug;
  }
  return { label, centimeters };
}

/** Build the model for one page file. */
function buildPage(file) {
  const html = readFileSync(file, 'utf8');
  const rel = relative(ROOT, file).split(sep).join('/');
  const url = getCanonical(html);
  const title = getTitle(html);
  // og:title matches <title> on every page except the hand-built 9-inch page,
  // where it carries the richer, already-published description. Using it keeps
  // the WebPage name aligned with the social metadata across the whole site.
  const socialTitle = getMeta(html, 'property', 'og:title') || title;
  const description = getMeta(html, 'name', 'description');
  const blocks = parseBlocksTolerantly(html);

  const base = { file: rel, url, title, socialTitle, description };

  if (rel === 'index.html') {
    const app = blocks.find((b) => b['@type'] === 'SoftwareApplication');
    return {
      ...base,
      kind: 'home',
      featureList: app && Array.isArray(app.featureList) ? app.featureList : [],
    };
  }

  if (rel === 'about/index.html') {
    return { ...base, kind: 'about' };
  }

  if (rel === 'measurements/index.html') {
    return { ...base, kind: 'collection' };
  }

  const faqs = getVisibleFaqs(html);
  const crumbs = getVisibleBreadcrumb(html);
  const { label, centimeters } = deriveMeasurementMeta(html, url || '', socialTitle);

  return {
    ...base,
    kind: 'measurement',
    label,
    centimeters,
    dateModified: getDateModified(html),
    faqs,
    breadcrumb: crumbs
      ? crumbs.map((c) => ({
          name: c.name,
          href: c.href ? new URL(c.href, SITE.origin + '/').href : url,
        }))
      : null,
  };
}

const pages = collectPages().map(buildPage);
const model = { site: SITE, pages };

const js = `/**
 * site-data.mjs — GENERATED FILE. Do not edit by hand.
 *
 * Regenerate with:  node scripts/build-site-data.mjs
 * Verify with:      node scripts/build-site-data.mjs --check
 *
 * Every field here is derived from the rendered HTML, so the structured data
 * always describes what a visitor actually sees.
 */
export const site = ${JSON.stringify(model.site, null, 2)};

export const pages = ${JSON.stringify(model.pages, null, 2)};

export default pages;
`;

if (CHECK_ONLY) {
  if (!existsSync(OUT)) {
    console.error('FAIL: scripts/site-data.mjs does not exist. Run build-site-data.mjs.');
    process.exit(1);
  }
  const current = readFileSync(OUT, 'utf8');
  if (current !== js) {
    console.error('FAIL: scripts/site-data.mjs is stale — page content changed.');
    console.error('      Run: node scripts/build-site-data.mjs');
    process.exit(1);
  }
  console.log('OK: scripts/site-data.mjs is up to date.');
  process.exit(0);
}

writeFileSync(OUT, js);
console.log(`Wrote ${relative(ROOT, OUT)} (${pages.length} pages)`);
for (const p of pages) {
  const extra =
    p.kind === 'measurement'
      ? `  faqs=${p.faqs.length}  label="${p.label}"${p.centimeters ? `  cm=${p.centimeters}` : ''}${p.breadcrumb ? '' : '  [NO BREADCRUMB]'}${p.faqs.length ? '' : '  [NO FAQ]'}`
      : '';
  console.log(`  ${p.file.padEnd(34)} ${p.kind.padEnd(12)}${extra}`);
}
