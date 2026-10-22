/**
 * page-facts.mjs — Extract page facts from rendered HTML.
 *
 * The schema on a page must describe the page that is actually rendered.
 * These helpers read the facts straight out of the HTML (title, meta
 * description, canonical link, visible FAQ entries, visible breadcrumb),
 * so structured data can never silently drift away from page content.
 */

/**
 * Named entities that appear in this site's copy, plus the common ones a
 * future edit could introduce. Anything not listed falls back to its numeric
 * code or is left untouched.
 */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®',
  trade: '™', deg: '°', middot: '·', bull: '•', laquo: '«', raquo: '»',
  times: '×', divide: '÷', pi: 'π', frac12: '½', frac14: '¼',
  frac34: '¾', sup2: '²', sup3: '³', micro: 'µ', plusmn: '±',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', euro: '€',
  pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
};

/**
 * Decode HTML entities so text lifted out of the markup lands in JSON-LD as
 * the characters a reader actually sees ("×" rather than "&times;").
 */
export function decodeEntities(str) {
  return String(str).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** Strip tags and collapse whitespace. */
export function textOf(html) {
  return decodeEntities(
    String(html)
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Read a single attribute value from the first tag matching `tagRe`. */
function attr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i');
  const m = tag.match(re);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * Pull the <title> text.
 */
export function getTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? textOf(m[1]) : null;
}

/**
 * Pull a <meta> tag's content. Astro emits `content` before `name`/`property`,
 * so the tag is matched generically rather than by attribute order.
 */
export function getMeta(html, key, value) {
  const re = new RegExp(`<meta\\b[^>]*>`, 'gi');
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    if (attr(tag, key) === value) return attr(tag, 'content');
  }
  return null;
}

/**
 * Pull the canonical link href.
 */
export function getCanonical(html) {
  const re = /<link\b[^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const tag = m[0];
    if ((attr(tag, 'rel') || '').toLowerCase() === 'canonical') return attr(tag, 'href');
  }
  return null;
}

/**
 * Pull the visible FAQ entries: <details class="faq-item"><summary>Q</summary><p>A</p></details>.
 * These are the questions a reader actually sees, so the FAQPage schema must
 * match them exactly for Google to accept the rich result.
 */
export function getVisibleFaqs(html) {
  const re = /<details\b[^>]*class="[^"]*faq-item[^"]*"[^>]*>([\s\S]*?)<\/details>/gi;
  const faqs = [];
  for (const m of html.matchAll(re)) {
    const inner = m[1];
    const q = inner.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
    const a = inner.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i);
    if (!q) continue;
    faqs.push({
      question: textOf(q[1]),
      answer: a ? textOf(a[1]) : '',
    });
  }
  return faqs;
}

/**
 * Pull the visible breadcrumb trail from <nav class="breadcrumbs" data-breadcrumbs>.
 * Anchors become real trail entries; the final aria-current="page" span is the
 * current page's label.
 */
export function getVisibleBreadcrumb(html) {
  const nav = html.match(/<nav\b[^>]*data-breadcrumbs[^>]*>([\s\S]*?)<\/nav>/i);
  if (!nav) return null;
  const inner = nav[1];
  const items = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>|<span\b([^>]*)>([\s\S]*?)<\/span>/gi;
  for (const m of inner.matchAll(re)) {
    if (m[1] !== undefined) {
      items.push({ name: textOf(m[2]), href: attr(`<a${m[1]}>`, 'href') });
    } else if (m[3] !== undefined && /aria-current\s*=\s*"page"/i.test(m[3])) {
      items.push({ name: textOf(m[4]), href: null });
    }
  }
  return items.length ? items : null;
}

/**
 * Pull the "Page last updated YYYY-MM-DD" stamp from the FAQ block.
 */
export function getDateModified(html) {
  const m = html.match(/Page last updated\s+(\d{4}-\d{2}-\d{2})/i);
  if (m) return m[1];
  const ld = html.match(/&quot;dateModified&quot;\s*:\s*&quot;(\d{4}-\d{2}-\d{2})/i);
  return ld ? ld[1] : null;
}

/**
 * Every <script type="application/ld+json"> payload on the page.
 */
export function getJsonLdBlocks(html) {
  const re = /<script\s+type="application\/ld\+json"\s*>([\s\S]*?)<\/script>/gi;
  return [...html.matchAll(re)].map((m) => m[1]);
}
