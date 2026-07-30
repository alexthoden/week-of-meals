'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseRecipeHtml, blockSplit, imageOf, jsonLdBlocks, durationOf,
} = require('../server/lib/import');

/*
 * Each fixture below is a miniature of a failure found by running the importer
 * against saved HTML from eighteen real recipe sites. The site that produced
 * each one is named, so if a test breaks you know what you broke.
 */

const page = (head, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const ld = (obj, attr = 'type="application/ld+json"') => `<script ${attr}>${JSON.stringify(obj)}</script>`;

const RECIPE = {
  '@context': 'https://schema.org',
  '@type': 'Recipe',
  name: 'Test Bake',
  recipeIngredient: ['2 cups flour', '1 tsp salt'],
  recipeInstructions: [{ '@type': 'HowToStep', text: 'Mix.' }, { '@type': 'HowToStep', text: 'Bake.' }],
  totalTime: 'PT1H15M',
  recipeYield: '4',
  image: 'https://example.com/a.jpg',
};

/* -------------------------------------------------------- script tags -- */

test('reads JSON-LD with an unquoted type attribute', () => {
  // loveandlemons.com serves <script type=application/ld+json>, which is legal
  // HTML5 and silently broke the old quoted-only regex.
  const html = page(ld(RECIPE, 'type=application/ld+json'));
  const r = parseRecipeHtml(html, 'https://x.test/r');
  assert.equal(r.title, 'Test Bake');
  assert.equal(r.ingredients.length, 2);
});

test('reads JSON-LD when other attributes come first', () => {
  const html = page(ld(RECIPE, 'class="yoast-schema-graph" type="application/ld+json"'));
  assert.equal(parseRecipeHtml(html, 'https://x.test/r').ingredients.length, 2);
});

test('finds the recipe inside an @graph', () => {
  const html = page(ld({ '@context': 'x', '@graph': [{ '@type': 'WebPage' }, RECIPE] }));
  assert.equal(parseRecipeHtml(html, 'https://x.test/r').title, 'Test Bake');
});

test('skips a malformed block and keeps looking', () => {
  const html = page(`<script type="application/ld+json">{oops</script>${ld(RECIPE)}`);
  assert.equal(parseRecipeHtml(html, 'https://x.test/r').title, 'Test Bake');
});

test('jsonLdBlocks tolerates a trailing comma', () => {
  const html = page('<script type="application/ld+json">{"a":1,}</script>');
  assert.deepEqual(jsonLdBlocks(html), [{ a: 1 }]);
});

/* ------------------------------------------------------------- steps -- */

test('splits a paragraph blob into separate steps', () => {
  // kingarthurbaking.com puts the whole method in one string of <p> tags.
  // Stripping tags first turned twelve steps into one wall of text.
  const html = page(ld({
    ...RECIPE,
    recipeInstructions: '<p>Preheat the oven.</p>\n, <p>Whisk the dry things.</p>\n, <p>Bake for an hour.</p>',
  }));
  const steps = parseRecipeHtml(html, 'https://x.test/r').steps;
  assert.equal(steps.length, 3);
  assert.equal(steps[0], 'Preheat the oven.');
  assert.equal(steps[2], 'Bake for an hour.');
});

test('descends into HowToSection wrappers', () => {
  // delish.com groups steps into sections rather than listing them flat.
  const html = page(ld({
    ...RECIPE,
    recipeInstructions: [{
      '@type': 'HowToSection',
      name: 'For the sauce',
      itemListElement: [
        { '@type': 'HowToStep', text: 'Simmer the tomatoes.' },
        { '@type': 'HowToStep', text: 'Season it.' },
      ],
    }],
  }));
  assert.deepEqual(parseRecipeHtml(html, 'https://x.test/r').steps,
    ['Simmer the tomatoes.', 'Season it.']);
});

test('breaks up one long unbroken wall of text', () => {
  // halfbakedharvest.com sometimes ships the whole method as a single
  // HowToStep with no markup. One 900-character step is useless at the stove.
  const wall = `${'Chop the onion very finely and set it aside in a small bowl. '.repeat(14)}Then fry it until golden. Finally add the stock and simmer.`;
  assert.ok(wall.length > 400, 'fixture must exceed the blob threshold');
  const html = page(ld({ ...RECIPE, recipeInstructions: wall }));
  assert.ok(parseRecipeHtml(html, 'https://x.test/r').steps.length > 2);
});

test('leaves already-separated steps alone', () => {
  // The sentence splitter must only rescue the one-giant-step case. Applying
  // it everywhere shredded correct instructions into fragments.
  const long = 'Heat the oil in a large heavy skillet over medium-high heat until it shimmers, about two minutes. Add the onion. Cook until softened.';
  const html = page(ld({
    ...RECIPE,
    recipeInstructions: [
      { '@type': 'HowToStep', text: long },
      { '@type': 'HowToStep', text: 'Serve.' },
    ],
  }));
  assert.equal(parseRecipeHtml(html, 'https://x.test/r').steps.length, 2);
});

test('blockSplit keeps list and break boundaries', () => {
  assert.deepEqual(blockSplit('<li>One</li><li>Two</li>'), ['One', 'Two']);
  assert.deepEqual(blockSplit('Alpha<br>Beta'), ['Alpha', 'Beta']);
});

/* ------------------------------------------------------------ images -- */

test('accepts every shape the image field arrives in', () => {
  const u = 'https://example.com/a.jpg';
  assert.equal(imageOf(u), u);
  assert.equal(imageOf([u]), u);
  assert.equal(imageOf({ '@type': 'ImageObject', url: u }), u);
  assert.equal(imageOf([{ '@type': 'ImageObject', contentUrl: u }]), u);
  assert.equal(imageOf(undefined), '');
  assert.equal(imageOf('/relative/path.jpg'), '');
});

test('falls back to og:image when the recipe node has none', () => {
  const { image, ...noImage } = RECIPE;
  const html = page(`<meta property="og:image" content="https://example.com/og.jpg">${ld(noImage)}`);
  assert.equal(parseRecipeHtml(html, 'https://x.test/r').image, 'https://example.com/og.jpg');
});

/* ---------------------------------------------------------- microdata -- */

test('falls back to microdata when there is no JSON-LD at all', () => {
  // epicurious.com publishes no JSON-LD on its recipe pages.
  const html = page(
    '<meta property="og:title" content="Microdata Stew">',
    `<h1>Microdata Stew</h1>
     <li itemprop="ingredients">1 lb beef</li>
     <li itemprop="ingredients">2 carrots</li>
     <div itemprop="recipeInstructions">Brown the beef.</div>`,
  );
  const r = parseRecipeHtml(html, 'https://x.test/r');
  assert.equal(r.title, 'Microdata Stew');
  assert.deepEqual(r.ingredients, ['1 lb beef', '2 carrots']);
  assert.equal(r.steps.length, 1);
});

test('returns nothing when the page has no recipe at all', () => {
  assert.equal(parseRecipeHtml(page('<title>Hello</title>'), 'https://x.test/r'), null);
});

/* ------------------------------------------------------------- misc --- */

test('reads ISO durations', () => {
  assert.equal(durationOf('PT1H15M'), '1 hr 15 min');
  assert.equal(durationOf('PT45M'), '45 min');
  assert.equal(durationOf('PT2H'), '2 hr');
  assert.equal(durationOf(''), '');
});

test('decodes entities and keeps fractions readable', () => {
  const html = page(ld({ ...RECIPE, recipeIngredient: ['&frac12; cup sugar', 'salt &amp; pepper'] }));
  const r = parseRecipeHtml(html, 'https://x.test/r');
  assert.equal(r.ingredients[0], '½ cup sugar');
  assert.equal(r.ingredients[1], 'salt & pepper');
});

test('carries timing, yield and source through', () => {
  const r = parseRecipeHtml(page(ld(RECIPE)), 'https://x.test/r');
  assert.equal(r.time, '1 hr 15 min');
  assert.equal(r.servings, '4 servings');
  assert.equal(r.source, 'https://x.test/r');
});
