'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CATEGORIES, UNCATEGORIZED, normalizeCategory, categoryOf, labelFor, summarize,
} = require('../server/lib/categories');

test('a category is stored lowercase and trimmed, like a tag', () => {
  assert.equal(normalizeCategory('  Dinner '), 'dinner');
  assert.equal(normalizeCategory('SIDE'), 'side');
  assert.equal(normalizeCategory('slow   cooker'), 'slow cooker');
  assert.equal(normalizeCategory(''), '');
  assert.equal(normalizeCategory(null), '');
  assert.equal(normalizeCategory(undefined), '');
});

test('an absurdly long category is cut rather than stored whole', () => {
  assert.equal(normalizeCategory('x'.repeat(200)).length, 40);
});

test('an explicit category wins over anything the tags suggest', () => {
  const recipe = { category: 'Dessert', tags: ['breakfast'] };
  assert.equal(categoryOf(recipe), 'dessert');
});

test('a recipe written before categories existed is read off its tags', () => {
  // The seed data ships a recipe tagged "breakfast" and no category field.
  assert.equal(categoryOf({ tags: ['kid approved', 'breakfast'] }), 'breakfast');
  assert.equal(categoryOf({ tags: ['fast', 'side'] }), 'side');
});

test('only real categories are inferred, not every tag', () => {
  // "weeknight" is an adjective, not a shelf. It must not become a folder.
  assert.equal(categoryOf({ tags: ['weeknight', 'one pan'] }), UNCATEGORIZED);
});

test('a recipe with nothing at all still has somewhere to live', () => {
  assert.equal(categoryOf({}), UNCATEGORIZED);
  assert.equal(categoryOf({ tags: [] }), UNCATEGORIZED);
});

test('inference never writes to the recipe it was given', () => {
  // It is a read-time default. If it mutated, the guess would silently become
  // permanent the next time anything saved.
  const recipe = { tags: ['dinner'] };
  categoryOf(recipe);
  assert.equal(recipe.category, undefined);
});

test('labels are title cased for display', () => {
  assert.equal(labelFor('dinner'), 'Dinner');
  assert.equal(labelFor('slow cooker'), 'Slow Cooker');
  assert.equal(labelFor(''), 'Uncategorized');
});

test('summarize counts each recipe exactly once', () => {
  const recipes = [
    { category: 'dinner' },
    { category: 'dinner' },
    { category: 'dessert' },
    { tags: ['breakfast'] },
    { tags: ['weeknight'] },
  ];
  const summary = summarize(recipes);
  const total = summary.reduce((n, c) => n + c.count, 0);

  assert.equal(total, recipes.length, 'every recipe lands on exactly one shelf');
  assert.equal(summary.find((c) => c.key === 'dinner').count, 2);
  assert.equal(summary.find((c) => c.key === 'dessert').count, 1);
  assert.equal(summary.find((c) => c.key === UNCATEGORIZED).count, 1);
});

test('shelves are ordered the way a day runs, with the leftovers last', () => {
  const summary = summarize([
    { category: 'dessert' },
    { category: 'breakfast' },
    { tags: [] },
    { category: 'dinner' },
    { category: 'zzz custom' },
  ]);
  const keys = summary.map((c) => c.key);

  assert.deepEqual(keys.slice(0, 3), ['breakfast', 'dinner', 'dessert']);
  assert.equal(keys[keys.length - 1], UNCATEGORIZED,
    'Uncategorized should never lead the list');
  assert.ok(keys.indexOf('zzz custom') > keys.indexOf('dessert'),
    'invented categories sort after the canonical ones');
});

test('an empty collection has no shelves rather than seven empty ones', () => {
  assert.deepEqual(summarize([]), []);
});

test('every canonical category survives a round trip through normalize', () => {
  for (const c of CATEGORIES) assert.equal(normalizeCategory(c), c);
});
