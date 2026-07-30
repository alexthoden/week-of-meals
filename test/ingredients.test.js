'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseIngredient, canonicalName } = require('../server/lib/parse');
const { formatQuantity, toBase, resolveUnit } = require('../server/lib/units');
const { consolidate } = require('../server/lib/consolidate');

/* -------------------------------------------------------------- parse -- */

test('reads plain quantities and units', () => {
  const p = parseIngredient('2 tablespoons soy sauce');
  assert.equal(p.amount, 2);
  assert.equal(p.unit, 'tbsp');
  assert.equal(p.name, 'soy sauce');
});

test('reads mixed numbers, vulgar fractions and slashes alike', () => {
  assert.equal(parseIngredient('1 1/2 cups flour').amount, 1.5);
  assert.equal(parseIngredient('1½ cups flour').amount, 1.5);
  assert.equal(parseIngredient('1/2 tsp salt').amount, 0.5);
  assert.equal(parseIngredient('¾ cup milk').amount, 0.75);
});

test('takes the top of a range so you buy enough', () => {
  const p = parseIngredient('2-3 tbsp olive oil');
  assert.equal(p.amount, 3);
  assert.equal(p.unit, 'tbsp');
  assert.ok(p.approx);
});

test('treats a missing unit as a count', () => {
  const p = parseIngredient('3 bell peppers');
  assert.equal(p.amount, 3);
  assert.equal(p.unit, 'each');
  assert.equal(p.canonical, 'bell pepper');
});

test('moves preparation after the comma into a note', () => {
  const p = parseIngredient('2 cloves garlic, minced');
  assert.equal(p.name, 'garlic');
  assert.equal(p.unit, 'clove');
  assert.equal(p.note, 'minced');
});

test('peels size words off either side of the unit', () => {
  assert.equal(parseIngredient('3 large eggs').name, 'eggs');
  assert.equal(parseIngredient('1 large head broccoli').unit, 'head');
  assert.equal(parseIngredient('1 large head broccoli').name, 'broccoli');
});

test('keeps parentheticals as notes rather than amounts', () => {
  const p = parseIngredient('1 can (14.5 oz) diced tomatoes');
  assert.equal(p.amount, 1);
  assert.equal(p.unit, 'can');
  assert.equal(p.name, 'diced tomatoes');
  assert.match(p.note, /14\.5 oz/);
});

test('does not mistake a product name for preparation', () => {
  // "ground" belongs to the beef; stripping it would merge two different buys.
  assert.equal(parseIngredient('1 lb ground beef').canonical, 'ground beef');
  assert.equal(parseIngredient('2 tsp ground cinnamon').canonical, 'ground cinnamon');
});

test('buys the fruit when a recipe wants its juice', () => {
  const p = parseIngredient('Juice of 1 lemon');
  assert.equal(p.amount, 1);
  assert.equal(p.canonical, 'lemon');
});

test('leaves unquantified lines usable', () => {
  const p = parseIngredient('freshly ground black pepper');
  assert.equal(p.amount, null);
  assert.ok(p.staple);
});

test('sorts items into plausible aisles', () => {
  assert.equal(parseIngredient('1 lb chicken thighs').aisle, 'Meat & Seafood');
  assert.equal(parseIngredient('2 cups whole milk').aisle, 'Dairy & Eggs');
  assert.equal(parseIngredient('1 can chickpeas').aisle, 'Pantry');
  assert.equal(parseIngredient('2 tsp ground cinnamon').aisle, 'Pantry');
  assert.equal(parseIngredient('1/4 cup fresh basil').aisle, 'Produce');
  assert.equal(parseIngredient('4 cups chicken broth').aisle, 'Pantry');
});

test('canonical names fold plurals but not identity', () => {
  assert.equal(canonicalName('Tomatoes'), 'tomato');
  assert.equal(canonicalName('cloves'), 'clove');
  assert.equal(canonicalName('green onions'), 'scallion');
  assert.notEqual(canonicalName('sweet potato'), canonicalName('potato'));
});

/* -------------------------------------------------------------- units -- */

test('converts within a dimension', () => {
  assert.equal(resolveUnit('Tbsp'), 'tbsp');
  assert.equal(resolveUnit('T'), 'tbsp');
  assert.equal(resolveUnit('t'), 'tsp');
  assert.ok(Math.abs(toBase(1, 'cup') - toBase(16, 'tbsp')) < 0.5);
  assert.ok(Math.abs(toBase(1, 'lb') - toBase(16, 'oz')) < 0.5);
});

test('renders amounts the way a kitchen says them', () => {
  assert.equal(formatQuantity(toBase(0.5, 'cup'), 'cup'), '½ cup');
  assert.equal(formatQuantity(toBase(3, 'cup'), 'cup'), '3 cups');
  assert.equal(formatQuantity(toBase(2, 'tbsp'), 'tbsp'), '2 tbsp');
  assert.equal(formatQuantity(toBase(1.5, 'lb'), 'lb'), '1½ lb');
  assert.equal(formatQuantity(13.5, 'clove'), '13½ cloves');
  assert.equal(formatQuantity(1, 'clove'), '1 clove');
});

/* -------------------------------------------------------- consolidate -- */

const recipe = (id, title, ingredients) => ({ id, title, ingredients });

test('adds the same ingredient across recipes', () => {
  const items = consolidate([
    { day: '2026-01-05', scale: 1, recipe: recipe('a', 'Chili', ['3 cloves garlic']) },
    { day: '2026-01-06', scale: 1, recipe: recipe('b', 'Pasta', ['2 cloves garlic']) },
  ]);
  const garlic = items.find((i) => i.key === 'garlic');
  assert.equal(garlic.quantity, '5 cloves');
  assert.equal(garlic.recipes.length, 2);
});

test('never adds amounts across incompatible dimensions', () => {
  const items = consolidate([
    { day: '2026-01-05', scale: 1, recipe: recipe('a', 'A', ['2 cloves garlic']) },
    { day: '2026-01-06', scale: 1, recipe: recipe('b', 'B', ['1 head garlic']) },
  ]);
  const garlic = items.find((i) => i.key === 'garlic');
  assert.ok(garlic.splitAmounts, 'cloves and heads must stay apart');
  assert.match(garlic.quantity, /2 cloves/);
  assert.match(garlic.quantity, /1 head/);
});

test('converts compatible volumes before adding', () => {
  const items = consolidate([
    { day: '2026-01-05', scale: 1, recipe: recipe('a', 'A', ['1/4 cup soy sauce']) },
    { day: '2026-01-06', scale: 1, recipe: recipe('b', 'B', ['2 tbsp soy sauce']) },
  ]);
  assert.equal(items.find((i) => i.key === 'soy sauce').quantity, '6 tbsp');
});

test('multiplies by the batch scale', () => {
  const items = consolidate([
    { day: '2026-01-05', scale: 2, recipe: recipe('a', 'A', ['1 lb ground beef']) },
  ]);
  assert.equal(items.find((i) => i.key === 'ground beef').quantity, '2 lb');
});

test('flags an unquantified mention alongside a real amount', () => {
  const items = consolidate([
    { day: '2026-01-05', scale: 1, recipe: recipe('a', 'A', ['1 tsp kosher salt']) },
    { day: '2026-01-06', scale: 1, recipe: recipe('b', 'B', ['kosher salt']) },
  ]);
  assert.match(items.find((i) => i.key === 'kosher salt').quantity, /more/);
});

test('groups the list by aisle in shopping order', () => {
  const items = consolidate([
    { day: '2026-01-05', scale: 1, recipe: recipe('a', 'A', ['1 lb chicken thighs', '2 tomatoes', '1 cup rice']) },
  ]);
  assert.deepEqual(items.map((i) => i.aisle), ['Produce', 'Meat & Seafood', 'Pantry']);
});

test('records where every line came from', () => {
  const items = consolidate([
    { day: '2026-01-05', scale: 1, recipe: recipe('a', 'Chili', ['1 onion']) },
  ]);
  const onion = items[0];
  assert.equal(onion.sources[0].title, 'Chili');
  assert.equal(onion.sources[0].raw, '1 onion');
  assert.equal(onion.sources[0].day, '2026-01-05');
});
