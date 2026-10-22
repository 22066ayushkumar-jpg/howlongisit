/**
 * schema.test.mjs — Unit tests for the structured-data builders.
 *
 * The point of these tests is that no input can produce invalid JSON. Copy
 * that contains quotes, backslashes, newlines, emoji or a literal
 * "</script>" must all serialize into a payload that JSON.parse() accepts.
 *
 * Run: node --test scripts/test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGraph,
  serializeGraph,
  websiteNode,
  publisherNode,
  webPageNode,
  thingNode,
  breadcrumbNode,
  faqNode,
  softwareApplicationNode,
  collectionPageNode,
  slugify,
} from '../lib/schema.mjs';
import { applySchema, renderBlock, graphForPage } from '../lib/inject.mjs';
import { pages } from '../site-data.mjs';

/** Every hostile string a page's copy could contain. */
const HOSTILE = [
  'plain text',
  'a "double quoted" string',
  "it's got an apostrophe",
  'back\\slash and a trailing backslash\\',
  'line one\nline two\r\nline three',
  'tab\tseparated\tvalues',
  '</script><script>alert(1)</script>',
  'a </script> inside an answer',
  'ampersand & entity &amp; entity',
  'emoji 🎯 and math × ÷ π',
  '<img src=x onerror=alert(1)>',
  '{"nested":"json"}',
  '   unicode line separators',
  'a'.repeat(5000),
];

test('serializeGraph always produces JSON that JSON.parse() accepts', () => {
  for (const value of HOSTILE) {
    const graph = buildGraph([
      { '@type': 'WebPage', name: value, description: value },
    ]);
    const out = serializeGraph(graph);
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(out);
    }, `failed for ${JSON.stringify(value.slice(0, 40))}`);
    assert.equal(parsed['@graph'][0].name, value);
    assert.equal(parsed['@graph'][0].description, value);
  }
});

test('a payload can never terminate its own script element', () => {
  const graph = buildGraph([{ '@type': 'WebPage', name: '</script><script>alert(1)</script>' }]);
  const out = serializeGraph(graph);
  assert.equal(/<\/script/i.test(out), false);
  // The value is still intact once parsed.
  assert.equal(JSON.parse(out)['@graph'][0].name, '</script><script>alert(1)</script>');
});

test('buildGraph emits a single @context and drops empty nodes', () => {
  const graph = buildGraph([{ '@type': 'WebPage' }, null, undefined, { '@type': 'Thing' }]);
  assert.equal(graph['@context'], 'https://schema.org');
  assert.equal(graph['@graph'].length, 2);
  assert.deepEqual(Object.keys(graph), ['@context', '@graph']);
});

/**
 * Regression test for the defect that caused the Search Console errors.
 *
 * The old template built JSON by interpolating a URL into a raw string and
 * forgot the closing quote, producing:
 *   "url":"https://example.com/page/,"dateModified":"2026-10-02"
 * which JSON.parse() rejects with "Unexpected token d".
 *
 * The builder below cannot produce that: the URL is a value, not a fragment
 * of a string template.
 */
test('regression: a URL field is always a complete, quoted JSON string', () => {
  const node = webPageNode({
    url: 'https://howlongisinch.com/how-long-is-1-inch/',
    name: 'How long is 1 inch?',
    description: 'desc',
    dateModified: '2026-10-02',
  });
  const out = serializeGraph(buildGraph([node]));

  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(JSON.parse(out)['@graph'][0].url, 'https://howlongisinch.com/how-long-is-1-inch/');
  assert.match(out, /"url":"[^"]*"/);
});

test('the exact historical malformed payload is rejected by JSON.parse()', () => {
  // This is what the old template emitted. It is invalid, which is exactly
  // why the builder approach replaced it.
  const broken = '{"@context":"https://schema.org","@type":"WebPage","url":"https://howlongisinch.com/how-long-is-1-inch/,"dateModified":"2026-10-02"}';
  assert.throws(() => JSON.parse(broken));
});

test('webPageNode sets @id, url and isPartOf', () => {
  const node = webPageNode({ url: 'https://x.test/a/', name: 'n', description: 'd', dateModified: '2026-01-01' });
  assert.equal(node['@type'], 'WebPage');
  assert.equal(node['@id'], 'https://x.test/a/#webpage');
  assert.equal(node.url, 'https://x.test/a/');
  assert.equal(node.dateModified, '2026-01-01');
  assert.equal(node.isPartOf['@id'], 'https://howlongisinch.com/#website');
});

test('webPageNode omits dateModified when it is unknown', () => {
  const node = webPageNode({ url: 'https://x.test/a/', name: 'n', description: 'd' });
  assert.equal('dateModified' in node, false);
});

test('thingNode describes the measurement in both units', () => {
  const node = thingNode({ label: '5 inches', centimeters: '12.7' });
  assert.equal(node.name, '5 inches');
  assert.equal(node.description, 'Physical size visualization of 5 inches (12.7 cm)');
});

test('thingNode falls back to a label-only description', () => {
  const node = thingNode({ label: '5 inches', centimeters: null });
  assert.equal(node.description, 'Physical size visualization of 5 inches');
});

test('faqNode escapes hostile answer text', () => {
  const node = faqNode({
    url: 'https://x.test/a/',
    faqs: [{ question: 'Is it "real"?', answer: 'Yes — see </script> "here".' }],
  });
  const out = serializeGraph(buildGraph([node]));
  assert.doesNotThrow(() => JSON.parse(out));
  assert.equal(JSON.parse(out)['@graph'][0].mainEntity[0].acceptedAnswer.text, 'Yes — see </script> "here".');
});

test('breadcrumbNode numbers items from one', () => {
  const node = breadcrumbNode({
    items: [
      { name: 'Home', href: 'https://x.test/' },
      { name: '5 inches', href: 'https://x.test/how-long-is-5-inches/' },
    ],
  });
  assert.equal(node.itemListElement[0].position, 1);
  assert.equal(node.itemListElement[1].position, 2);
  assert.equal(node.itemListElement[1].item, 'https://x.test/how-long-is-5-inches/');
});

test('websiteNode and publisherNode share stable @ids', () => {
  assert.equal(websiteNode()['@id'], 'https://howlongisinch.com/#website');
  assert.equal(publisherNode()['@id'], 'https://howlongisinch.com/#publisher');
  assert.equal(websiteNode().publisher['@id'], publisherNode()['@id']);
});

test('softwareApplicationNode keeps the free offer', () => {
  const node = softwareApplicationNode({
    url: 'https://x.test/',
    name: 'App',
    description: 'd',
    featureList: ['a', 'b'],
  });
  assert.equal(node.offers.price, '0');
  assert.equal(node.offers.priceCurrency, 'USD');
  assert.deepEqual(node.featureList, ['a', 'b']);
});

test('collectionPageNode links back to the WebSite', () => {
  const node = collectionPageNode({ url: 'https://x.test/list/', name: 'n', description: 'd' });
  assert.equal(node['@type'], 'CollectionPage');
  assert.equal(node.isPartOf['@id'], 'https://howlongisinch.com/#website');
});

test('slugify produces safe @id fragments', () => {
  assert.equal(slugify('5 inches'), '5-inches');
  assert.equal(slugify('1 inch'), '1-inch');
  assert.equal(slugify('A & B!'), 'a-b');
});

/**
 * The injection must be a fixed point. An earlier version indented the block
 * by two spaces on every run, so the build silently grew a little on each
 * deploy. These tests pin that down.
 */
test('applySchema is idempotent for every page shape', () => {
  const shells = [
    '<html><head><title>t</title></head><body><p>hi</p></body></html>',
    '<html><head><title>t</title>\n</head>\n<body><p>hi</p>\n</body>\n</html>',
    '<html><head><title>t</title></head><body><p>hi</p></body></html>',
    '<html><head><meta content="x"/></head><body></body></html>',
  ];
  const block = '<script type="application/ld+json">{"@context":"https://schema.org","@graph":[]}</script>';

  for (const shell of shells) {
    const once = applySchema(shell, block);
    const twice = applySchema(once, block);
    const thrice = applySchema(twice, block);
    assert.equal(once, twice, 'second run differed');
    assert.equal(twice, thrice, 'third run differed');
  }
});

test('applySchema replaces every existing block instead of appending', () => {
  const legacy =
    '<html><head></head><body><p>x</p>' +
    '<script type="application/ld+json">{"@type":"WebPage"}</script> ' +
    '<script type="application/ld+json">{"@type":"FAQPage"}</script>' +
    '</body></html>';
  const out = applySchema(legacy, '<script type="application/ld+json">{"@graph":[]}</script>');
  const count = (out.match(/application\/ld\+json/g) || []).length;
  assert.equal(count, 1);
  assert.ok(!out.includes('FAQPage'));
});

test('applySchema places the block inside <head>', () => {
  const out = applySchema(
    '<html><head><title>t</title></head><body></body></html>',
    '<script type="application/ld+json">{"@graph":[]}</script>'
  );
  assert.ok(out.indexOf('application/ld+json') < out.indexOf('</head>'));
});

test('applySchema falls back to <body> when there is no <head>', () => {
  const out = applySchema(
    '<html><body></body></html>',
    '<script type="application/ld+json">{"@graph":[]}</script>'
  );
  assert.ok(out.indexOf('application/ld+json') < out.indexOf('</body>'));
});

test('every page in the model renders a parseable, single-graph block', () => {
  assert.ok(pages.length > 0);
  for (const page of pages) {
    const block = renderBlock(page);
    const json = block.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '');
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(json);
    }, `${page.file} produced invalid JSON`);
    assert.equal(parsed['@context'], 'https://schema.org');
    assert.ok(Array.isArray(parsed['@graph']));
    assert.ok(parsed['@graph'].length >= 2, `${page.file} has too few graph nodes`);
    // Every node must carry a type and, where it has one, an id.
    for (const node of parsed['@graph']) {
      assert.equal(typeof node['@type'], 'string');
    }
  }
});

test('graphForPage produces one consolidated graph per page kind', () => {
  const kinds = new Set(pages.map((p) => p.kind));
  for (const page of pages) {
    const graph = graphForPage(page);
    const types = graph['@graph'].map((n) => n['@type']);
    assert.ok(types.includes('WebSite'), `${page.file} has no WebSite node`);
    if (page.kind === 'measurement') {
      assert.ok(types.includes('FAQPage'), `${page.file} has no FAQPage node`);
      assert.ok(types.includes('BreadcrumbList'), `${page.file} has no BreadcrumbList node`);
      assert.ok(types.includes('Thing'), `${page.file} has no Thing node`);
    }
    if (page.kind === 'home') {
      assert.ok(types.includes('SoftwareApplication'), `${page.file} has no SoftwareApplication node`);
    }
  }
  assert.deepEqual([...kinds].sort(), ['about', 'collection', 'home', 'measurement']);
});
