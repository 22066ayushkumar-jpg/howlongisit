/**
 * inject.mjs — Build and inject the JSON-LD block for a page.
 *
 * Kept free of side effects (no file writes, no CLI parsing) so the
 * behaviour can be unit tested directly.
 */
import { site, pages } from '../site-data.mjs';
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
} from './schema.mjs';

/**
 * Matches any existing JSON-LD script block, including pretty-printed ones,
 * together with the whitespace around it. Removing that surrounding
 * whitespace is what makes the generator idempotent: re-running it strips
 * the old block and its indentation completely, so the result is byte
 * identical no matter how many times it runs.
 */
export const LD_BLOCK_RE =
  /\s*<script\s+type="application\/ld\+json"\s*>[\s\S]*?<\/script>\s*/gi;

/**
 * Build the @graph for one page of the model.
 */
export function graphForPage(page) {
  const nodes = [websiteNode(), publisherNode()];

  switch (page.kind) {
    case 'home': {
      nodes.push(
        webPageNode({
          url: page.url,
          name: page.socialTitle || page.title,
          description: page.description,
        })
      );
      nodes.push(
        softwareApplicationNode({
          url: page.url,
          name: site.name,
          description: page.description,
          featureList: page.featureList,
        })
      );
      break;
    }

    case 'about':
      nodes.push(
        webPageNode({
          url: page.url,
          name: page.socialTitle || page.title,
          description: page.description,
        })
      );
      break;

    case 'collection': {
      nodes.push(
        collectionPageNode({
          url: page.url,
          name: page.socialTitle || page.title,
          description: page.description,
        })
      );
      break;
    }

    case 'measurement': {
      const thing = thingNode({ label: page.label, centimeters: page.centimeters });
      const pageNode = webPageNode({
        url: page.url,
        name: page.socialTitle || page.title,
        description: page.description,
        dateModified: page.dateModified,
      });
      nodes.push(pageNode, thing);

      if (page.breadcrumb && page.breadcrumb.length) {
        nodes.push(breadcrumbNode({ items: page.breadcrumb }));
      }
      if (page.faqs && page.faqs.length) {
        nodes.push(faqNode({ url: page.url, faqs: page.faqs }));
      }
      break;
    }

    default:
      throw new Error(`Unknown page kind: ${page.kind}`);
  }

  return buildGraph(nodes);
}

/**
 * Render the JSON-LD block for a page.
 */
export function renderBlock(page) {
  const json = serializeGraph(graphForPage(page));
  return `<script type="application/ld+json">${json}</script>`;
}

/**
 * Strip every JSON-LD block from a page and insert one consolidated block
 * in the <head>, falling back to <body> and then the end of the file.
 *
 * The insertion replaces the whitespace that precedes the closing tag with a
 * canonical form. Together with the whitespace-eating removal above, that
 * makes this function a fixed point: running it twice produces the same
 * bytes as running it once, so the build never drifts.
 */
export function applySchema(html, block) {
  const cleaned = html.replace(LD_BLOCK_RE, '');
  const markup = `\n  ${block}\n`;

  if (cleaned.includes('</head>')) {
    return cleaned.replace(/\s*<\/head>/i, `${markup}</head>`);
  }
  if (cleaned.includes('</body>')) {
    return cleaned.replace(/\s*<\/body>/i, `${markup}</body>`);
  }
  return `${cleaned}${markup}`;
}
