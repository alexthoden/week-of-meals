'use strict';

/**
 * Pull a recipe out of a web page.
 *
 * Most recipe sites publish schema.org Recipe JSON-LD so Google can show the
 * card in search results, which is a far more stable target than scraping
 * markup. This file was written against saved HTML from eighteen real recipe
 * sites (see test/import.test.js), and every branch below exists because one
 * of them needed it:
 *
 *   - loveandlemons serves <script type=application/ld+json> with the
 *     attribute value unquoted, which is legal HTML5 and breaks a naive regex.
 *   - kingarthurbaking puts every instruction in one string of <p> tags, so
 *     block boundaries have to become line breaks before the tags are
 *     stripped, or you get one giant step.
 *   - delish nests steps inside HowToSection instead of listing HowToStep.
 *   - epicurious publishes no JSON-LD at all, only microdata, so there is a
 *     fallback that reads itemprop attributes.
 *   - "image" arrives as a string, an array of strings, an ImageObject, or an
 *     array of ImageObjects depending on the site. All four appear in the
 *     fixtures.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Looks enough like a browser to get past the softer bot walls. */
const HEADERS = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&frac12;/g, '½').replace(/&frac14;/g, '¼')
    .replace(/&frac34;/g, '¾').replace(/&frac13;/g, '⅓').replace(/&frac23;/g, '⅔')
    .replace(/&deg;/g, '°').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&rsquo;/g, '\u2019').replace(/&lsquo;/g, '\u2018')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&'); // last, so "&amp;lt;" doesn't turn into "<"
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Turn block-level tags into newlines so paragraph boundaries survive tag
 * stripping. Without this, a string of <p> tags collapses into one step.
 */
function blockSplit(html) {
  return String(html)
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|li|div|h[1-6]|tr|section)\s*>/gi, '\n')
    .split('\n')
    .map((chunk) => stripTags(chunk).replace(/^[,;\s]+|[,;\s]+$/g, ''))
    .filter((chunk) => chunk.length > 1);
}

/** JSON-LD arrives as an object, an array, or an @graph. Flatten all three. */
function flatten(node, out = []) {
  if (!node) return out;
  if (Array.isArray(node)) { node.forEach((n) => flatten(n, out)); return out; }
  if (typeof node !== 'object') return out;
  out.push(node);
  if (node['@graph']) flatten(node['@graph'], out);
  return out;
}

function isRecipe(node) {
  const type = node['@type'];
  if (!type) return false;
  return Array.isArray(type) ? type.includes('Recipe') : type === 'Recipe';
}

function textOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return stripTags(v);
  if (Array.isArray(v)) return textOf(v[0]);
  if (typeof v === 'object') return stripTags(v.name || v.text || '');
  return '';
}

/**
 * Some sites publish every instruction as one unbroken paragraph with no
 * markup at all. That is unreadable in cooking mode, so a blob past this
 * length gets cut at sentence ends. The lookarounds skip decimals ("1.5
 * cups"), single-letter abbreviations, and temperatures, which is where a
 * naive split on ". " goes wrong.
 */
const BLOB = 400;

function sentenceSplit(text) {
  if (text.length <= BLOB) return [text];
  const parts = text
    .split(/(?<=[a-z)\]"'\u2019%\u00b0])[.!?]\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return [text];
  // Put the punctuation back; the split consumed it.
  return parts.map((s, i) => (i < parts.length - 1 && !/[.!?]$/.test(s) ? `${s}.` : s));
}

/**
 * Instructions, in every shape the fixtures produce: a plain string of HTML,
 * an array of strings, an array of HowToStep, or HowToSection wrappers
 * holding an itemListElement of HowToStep.
 */
function stepsOf(instructions) {
  const out = [];
  const push = (raw) => {
    for (const chunk of blockSplit(raw)) if (chunk.length > 2) out.push(chunk);
  };

  const walk = (node) => {
    if (!node) return;
    if (typeof node === 'string') { push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node !== 'object') return;
    if (node.itemListElement) { walk(node.itemListElement); return; }
    if (node.steps) { walk(node.steps); return; }
    push(node.text || node.name || '');
  };

  walk(instructions);

  // Only rescue the pathological case. If the site already produced separate
  // steps it segmented the recipe itself, and second-guessing that shreds
  // perfectly good instructions into sentence fragments.
  if (out.length === 1) return sentenceSplit(out[0]);
  return out;
}

/**
 * The hero image. Sites disagree about the shape, so accept all of them and
 * take the first usable URL.
 */
function imageOf(value) {
  const pick = (v) => {
    if (!v) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) {
      for (const entry of v) {
        const found = pick(entry);
        if (found) return found;
      }
      return '';
    }
    if (typeof v === 'object') return pick(v.url || v.contentUrl || v['@id'] || '');
    return '';
  };
  const url = pick(value);
  return /^https?:\/\//i.test(url) ? url : '';
}

/** ISO 8601 duration -> "45 min" */
function durationOf(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/);
  if (!m) return '';
  const mins = (Number(m[1] || 0) * 1440) + (Number(m[2] || 0) * 60) + Number(m[3] || 0);
  if (!mins) return '';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const r = mins % 60;
  return r ? `${h} hr ${r} min` : `${h} hr`;
}

/** Find every <script type="application/ld+json">, quoted or not. */
function jsonLdBlocks(html) {
  const re = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  const out = [];
  for (const m of html.matchAll(re)) {
    const raw = m[1].trim().replace(/^\uFEFF/, '').replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try {
      out.push(JSON.parse(raw));
    } catch {
      // A few sites emit trailing commas, which JSON.parse refuses.
      try { out.push(JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'))); } catch { /* skip */ }
    }
  }
  return out;
}

function metaContent(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']?${prop}["']?[^>]*>`, 'i');
  const tag = html.match(re);
  if (!tag) return '';
  const content = tag[0].match(/content\s*=\s*["']([^"']*)["']/i);
  return content ? decodeEntities(content[1]).trim() : '';
}

/**
 * Microdata fallback for pages with no JSON-LD at all. Deliberately shallow:
 * pull the itemprop values and let the person tidy anything odd in the form
 * before they save it.
 */
function fromMicrodata(html, url) {
  const collect = (props) => {
    const found = [];
    for (const prop of props) {
      const re = new RegExp(`<([a-z0-9]+)[^>]+itemprop\\s*=\\s*["']?${prop}["']?[^>]*>([\\s\\S]*?)<\\/\\1>`, 'gi');
      for (const m of html.matchAll(re)) {
        const text = stripTags(m[2]);
        if (text && !found.includes(text)) found.push(text);
      }
    }
    return found;
  };

  const ingredients = collect(['recipeIngredient', 'ingredients']);
  if (!ingredients.length) return null;

  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return {
    title: metaContent(html, 'og:title') || (h1 ? stripTags(h1[1]) : '') || 'Imported recipe',
    source: url,
    servings: collect(['recipeYield'])[0] || '',
    time: '',
    tags: [],
    ingredients,
    steps: collect(['recipeInstructions']),
    image: imageOf(metaContent(html, 'og:image')),
    notes: '',
  };
}

/** Parse a page that has already been downloaded. Exported so tests can run offline. */
function parseRecipeHtml(html, url) {
  let recipe = null;
  for (const block of jsonLdBlocks(html)) {
    recipe = flatten(block).find(isRecipe);
    if (recipe) break;
  }

  if (!recipe) return fromMicrodata(html, url);

  const yieldRaw = recipe.recipeYield;
  const servings = Array.isArray(yieldRaw) ? String(yieldRaw[0]) : String(yieldRaw || '');

  const ingredients = (recipe.recipeIngredient || recipe.ingredients || [])
    .flatMap((line) => (typeof line === 'string' ? [stripTags(line)] : blockSplit(String(line))))
    .filter(Boolean);

  return {
    title: textOf(recipe.name) || metaContent(html, 'og:title') || 'Imported recipe',
    source: url,
    servings: servings.replace(/^(\d+)$/, '$1 servings'),
    time: durationOf(recipe.totalTime) || durationOf(recipe.cookTime),
    tags: []
      .concat(recipe.recipeCuisine || [], recipe.recipeCategory || [])
      .flatMap((t) => String(t).split(','))
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 4),
    ingredients,
    steps: stepsOf(recipe.recipeInstructions),
    // og:image is the safety net; a few sites omit image from the recipe node.
    image: imageOf(recipe.image) || imageOf(metaContent(html, 'og:image')),
    notes: '',
  };
}

async function importFromUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    const err = new Error('That does not look like a web address.');
    err.code = 'BAD_URL';
    throw err;
  }

  let html;
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      throw new Error(res.status === 403 || res.status === 429
        ? `the site blocked the request (${res.status})`
        : `the site answered ${res.status}`);
    }
    html = await res.text();
  } catch (err) {
    const e = new Error(`Could not open that page — ${err.message}. Paste the ingredients in below instead.`);
    e.code = 'FETCH_FAILED';
    throw e;
  }

  const recipe = parseRecipeHtml(html, url);

  if (!recipe || !recipe.ingredients.length) {
    const err = new Error('Found the page but no recipe data on it. Paste the ingredients in below instead.');
    err.code = 'NO_RECIPE';
    throw err;
  }

  return recipe;
}

module.exports = {
  importFromUrl, parseRecipeHtml, stripTags, blockSplit, sentenceSplit,
  durationOf, imageOf, jsonLdBlocks, stepsOf,
};
