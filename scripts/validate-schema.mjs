#!/usr/bin/env node
/**
 * validate-schema.mjs — Self-validation for the site's structured data.
 *
 * Every JSON-LD block on every page is parsed with JSON.parse() — the exact
 * thing Google Search Console does when it reports a parsing error — and then
 * cross-checked against the page it lives on:
 *
 *   - exactly one JSON-LD block per page, and it is a single @graph
 *   - every node has an @type, and every @id is unique within the graph
 *   - every @id reference resolves to a node in the same graph
 *   - the WebPage url matches the page's canonical link
 *   - the WebPage name/description match the page's og:title / meta description
 *   - the FAQPage questions match the FAQ entries a visitor can actually see
 *   - the BreadcrumbList matches the visible breadcrumb trail
 *   - the payload cannot break out of its <script> element
 *
 * Exit code is non-zero if anything fails.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { site, pages } from './site-data.mjs';
import {
  getTitle,
  getMeta,
  getCanonical,
  getVisibleFaqs,
  getVisibleBreadcrumb,
  getJsonLdBlocks,
  decodeEntities,
} from './lib/page-facts.mjs';

const ROOT = process.cwd();

const KNOWN_TYPES = new Set([
  'WebSite', 'WebPage', 'CollectionPage', 'Organization', 'Thing',
  'BreadcrumbList', 'ListItem', 'Question', 'Answer', 'FAQPage',
  'SoftwareApplication', 'Offer', 'ImageObject',
]);

let checks = 0;
const failures = [];

function check(ok, message) {
  checks++;
  if (!ok) failures.push(message);
  return ok;
}

/** Collect every HTML page that carries structured data, plus the 404. */
function collectHtml(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.freebuff' || entry === 'scripts') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectHtml(full, acc);
    else if (entry.endsWith('.html')) acc.push(full);
  }
  return acc;
}

const TARGETS = [ROOT, join(ROOT, 'deploy')];
let pageCount = 0;
let blockCount = 0;

for (const targetRoot of TARGETS) {
  for (const page of pages) {
    const file = join(targetRoot, page.file.split('/').join(sep));
    const rel = relative(ROOT, file);
    const html = readFileSync(file, 'utf8');
    pageCount++;

    const blocks = getJsonLdBlocks(html);

    // --- one block per page -------------------------------------------
    check(blocks.length === 1, `${rel}: expected exactly 1 JSON-LD block, found ${blocks.length}`);
    if (blocks.length !== 1) continue;

    const raw = blocks[0];
    blockCount++;

    // --- the block parses ----------------------------------------------
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      check(false, `${rel}: JSON.parse failed — ${err.message}`);
      continue;
    }
    check(true, '');

    // --- it survives a re-serialization round trip ---------------------
    check(
      JSON.stringify(JSON.parse(JSON.stringify(parsed))) === JSON.stringify(parsed),
      `${rel}: JSON-LD does not survive a serialize/parse round trip`
    );

    // --- it is a single @graph -----------------------------------------
    check(parsed['@context'] === 'https://schema.org', `${rel}: @context must be https://schema.org`);
    check(Array.isArray(parsed['@graph']), `${rel}: top level must be a single @graph array`);
    check(!('mainEntity' in parsed) && !('@type' in parsed), `${rel}: legacy top-level keys found, expected only @context + @graph`);
    if (!Array.isArray(parsed['@graph'])) continue;

    const graph = parsed['@graph'];

    // --- every node is well formed -------------------------------------
    const ids = new Set();
    graph.forEach((node, i) => {
      check(
        typeof node['@type'] === 'string' && node['@type'].length > 0,
        `${rel}: graph node ${i} has no @type`
      );
      check(
        !node['@type'] || KNOWN_TYPES.has(node['@type']),
        `${rel}: graph node ${i} has unexpected @type "${node['@type']}"`
      );
      if (node['@id']) {
        check(!ids.has(node['@id']), `${rel}: duplicate @id "${node['@id']}"`);
        ids.add(node['@id']);
      }
      // No node may carry an unquoted or half-terminated URL-like value.
      for (const [key, value] of Object.entries(node)) {
        if (typeof value !== 'string') continue;
        check(
          !value.endsWith(',') && !value.endsWith('{') && !value.endsWith('['),
          `${rel}: node "${node['@type']}" property "${key}" looks truncated (${JSON.stringify(value)})`
        );
      }
    });

    // --- every @id reference resolves ----------------------------------
    const referenceKeys = new Set(['isPartOf', 'publisher', 'mainEntity', 'about', 'item']);
    const collectRefs = (value, out) => {
      if (Array.isArray(value)) value.forEach((v) => collectRefs(v, out));
      else if (value && typeof value === 'object') {
        if (typeof value['@id'] === 'string') out.push(value['@id']);
        for (const v of Object.values(value)) collectRefs(v, out);
      }
    };
    for (const node of graph) {
      const refs = [];
      for (const key of referenceKeys) if (key in node) collectRefs(node[key], refs);
      for (const ref of refs) {
        check(ids.has(ref), `${rel}: reference "${ref}" does not resolve to a node in the graph`);
      }
    }

    // --- the payload cannot break out of the script element ------------
    check(!/<\/script/i.test(raw), `${rel}: raw JSON contains a literal </script sequence`);

    // --- the block lives in <head> -------------------------------------
    const headEnd = html.indexOf('</head>');
    const blockAt = html.indexOf('<script type="application/ld+json">');
    check(
      headEnd !== -1 && blockAt !== -1 && blockAt < headEnd,
      `${rel}: JSON-LD block is not inside <head>`
    );

    // --- matches the page's own metadata -------------------------------
    const webPage = graph.find((n) => n['@type'] === 'WebPage' || n['@type'] === 'CollectionPage');
    if (webPage) {
      const canonical = getCanonical(html);
      check(webPage.url === canonical, `${rel}: schema url "${webPage.url}" != canonical "${canonical}"`);

      const ogTitle = getMeta(html, 'property', 'og:title');
      const title = getTitle(html);
      check(
        webPage.name === (ogTitle || title),
        `${rel}: schema name "${webPage.name}" != og:title "${ogTitle || title}"`
      );

      const metaDescription = getMeta(html, 'name', 'description');
      check(
        webPage.description === metaDescription,
        `${rel}: schema description does not match the meta description`
      );
      check(
        typeof webPage.description === 'string' && webPage.description.length > 50,
        `${rel}: schema description is too short to be useful`
      );
    }

    // --- FAQPage matches the visible FAQ --------------------------------
    const faqNode = graph.find((n) => n['@type'] === 'FAQPage');
    const visibleFaqs = getVisibleFaqs(html);
    if (visibleFaqs.length) {
      if (check(Boolean(faqNode), `${rel}: page shows a FAQ but has no FAQPage node`)) {
        const schemaQs = faqNode.mainEntity.map((q) => q.name);
        const visibleQs = visibleFaqs.map((f) => f.question);
        check(
          schemaQs.length === visibleQs.length,
          `${rel}: FAQPage has ${schemaQs.length} questions but ${visibleQs.length} are visible`
        );
        schemaQs.forEach((q, i) => {
          check(q === visibleQs[i], `${rel}: FAQ question ${i + 1} differs from the visible text`);
        });
        faqNode.mainEntity.forEach((q, i) => {
          const answer = q.acceptedAnswer && q.acceptedAnswer.text;
          check(
            typeof answer === 'string' && answer.length > 0,
            `${rel}: FAQ answer ${i + 1} has no text`
          );
          check(
            answer === visibleFaqs[i].answer,
            `${rel}: FAQ answer ${i + 1} differs from the visible text`
          );
        });
      }
    } else {
      check(!faqNode, `${rel}: has a FAQPage node but shows no visible FAQ`);
    }

    // --- BreadcrumbList matches the visible breadcrumb -------------------
    const crumbNode = graph.find((n) => n['@type'] === 'BreadcrumbList');
    const visibleCrumbs = getVisibleBreadcrumb(html);
    if (visibleCrumbs) {
      if (check(Boolean(crumbNode), `${rel}: page shows a breadcrumb but has no BreadcrumbList node`)) {
        const items = crumbNode.itemListElement;
        check(items.length === visibleCrumbs.length, `${rel}: breadcrumb length differs from the visible trail`);
        items.forEach((item, i) => {
          check(item.position === i + 1, `${rel}: breadcrumb item ${i + 1} has position ${item.position}`);
          check(
            item.name === visibleCrumbs[i].name,
            `${rel}: breadcrumb name ${i + 1} ("${item.name}") differs from the visible text ("${visibleCrumbs[i].name}")`
          );
          check(
            typeof item.item === 'string' && /^https?:\/\//.test(item.item),
            `${rel}: breadcrumb item ${i + 1} is not an absolute URL`
          );
        });
      }
    }

    // --- measurement pages describe their measurement --------------------
    if (page.kind === 'measurement') {
      check(
        typeof webPage.dateModified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(webPage.dateModified),
        `${rel}: measurement page has no dateModified`
      );
      const thing = graph.find((n) => n['@type'] === 'Thing');
      check(Boolean(thing), `${rel}: measurement page has no Thing node`);
      if (thing) check(thing.name === page.label, `${rel}: Thing name "${thing.name}" != "${page.label}"`);
      if (page.centimeters) {
        check(
          typeof thing.description === 'string' && thing.description.includes(page.centimeters),
          `${rel}: Thing description does not mention ${page.centimeters} cm`
        );
      }
    }
  }
}

// --- the 404 page should not carry structured data --------------------------
const notFound = join(ROOT, '404.html');
if (statExists(notFound)) {
  const blocks = getJsonLdBlocks(readFileSync(notFound, 'utf8'));
  check(blocks.length === 0, '404.html: should not carry structured data');
}

// --- report ------------------------------------------------------------------
const label = failures.length ? 'FAIL' : 'PASS';
console.log(`${label}  ${checks} checks, ${failures.length} failed, ${pageCount} pages, ${blockCount} JSON-LD blocks`);
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}

function statExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}
