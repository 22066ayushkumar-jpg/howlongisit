/**
 * schema.mjs — Structured-data builders.
 *
 * Every value that reaches a JSON-LD block goes through JSON.stringify().
 * Nothing is interpolated into a raw string template, so a quote, a newline
 * or an ampersand inside page copy can no longer break the JSON syntax.
 *
 * Each page emits ONE <script type="application/ld+json"> containing a single
 * @graph. Nodes are linked with @id references instead of being repeated, so
 * the WebSite entity is described exactly once per document.
 */

export const SITE = {
  name: 'How Long Is Inch?',
  origin: 'https://howlongisinch.com',
  description:
    'Visualize measurements with actual-size rulers. See inches at their true actual size and compare them with familiar everyday objects.',
  logo: 'https://howlongisinch.com/og-image.png',
};

const WEBSITE_ID = `${SITE.origin}/#website`;

/** The shared WebSite node, referenced by every other node via @id. */
export function websiteNode() {
  return {
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    url: `${SITE.origin}/`,
    name: SITE.name,
    description: SITE.description,
    inLanguage: 'en-US',
    publisher: { '@id': `${SITE.origin}/#publisher` },
  };
}

/** The shared Organization node behind the site. */
export function publisherNode() {
  return {
    '@type': 'Organization',
    '@id': `${SITE.origin}/#publisher`,
    name: SITE.name,
    url: `${SITE.origin}/`,
  };
}

/**
 * A WebPage node.
 * `name` and `description` are taken from the page's own <title> and
 * meta description so the schema never describes something the page
 * does not actually show.
 */
export function webPageNode({ url, name, description, dateModified }) {
  const node = {
    '@type': 'WebPage',
    '@id': `${url}#webpage`,
    url,
    name,
    description,
    isPartOf: { '@id': WEBSITE_ID },
    inLanguage: 'en-US',
  };
  if (dateModified) node.dateModified = dateModified;
  node.mainEntity = undefined;
  return node;
}

/** The Thing entity a measurement page is about. */
export function thingNode({ label, centimeters }) {
  const description = centimeters
    ? `Physical size visualization of ${label} (${centimeters} cm)`
    : `Physical size visualization of ${label}`;
  return {
    '@type': 'Thing',
    '@id': `${SITE.origin}/#${slugify(label)}`,
    name: label,
    description,
  };
}

/** A BreadcrumbList built from the visible breadcrumb trail. */
export function breadcrumbNode({ items }) {
  return {
    '@type': 'BreadcrumbList',
    '@id': `${items[items.length - 1].href}#breadcrumb`,
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.href,
    })),
  };
}

/**
 * A FAQPage built from the visible <details> FAQ entries, so the rich result
 * always matches what a reader can see on the page.
 */
export function faqNode({ url, faqs }) {
  return {
    '@type': 'FAQPage',
    '@id': `${url}#faq`,
    mainEntity: faqs.map((faq) => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer,
      },
    })),
  };
}

/** The SoftwareApplication node used on the home page. */
export function softwareApplicationNode({ url, name, description, featureList }) {
  return {
    '@type': 'SoftwareApplication',
    '@id': `${url}#app`,
    name,
    url,
    applicationCategory: 'UtilitiesApplication',
    applicationSubCategory: 'Measurement converter',
    operatingSystem: 'Any (web browser)',
    description,
    featureList,
    isPartOf: { '@id': WEBSITE_ID },
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
      availability: 'https://schema.org/InStock',
    },
  };
}

/** A CollectionPage node for a listing of pages. */
export function collectionPageNode({ url, name, description }) {
  return {
    '@type': 'CollectionPage',
    '@id': `${url}#webpage`,
    url,
    name,
    description,
    isPartOf: { '@id': WEBSITE_ID },
    inLanguage: 'en-US',
  };
}

/** Turn a human label into a stable @id fragment. */
export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Wrap nodes in the single @graph envelope.
 */
export function buildGraph(nodes) {
  return {
    '@context': 'https://schema.org',
    '@graph': nodes.filter(Boolean),
  };
}

/**
 * Serialize a graph for embedding inside an HTML <script> element.
 *
 * JSON.stringify handles all escaping. The extra pass replaces "<" with its
 * unicode escape so that copy containing "</script>" can never terminate the
 * script element early — JSON.parse() reads it back identically.
 */
export function serializeGraph(graph) {
  return JSON.stringify(graph)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}
