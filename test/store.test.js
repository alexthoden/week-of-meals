'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Store } = require('../server/lib/store');

/*
 * The point of these tests is one promise: you should never have to type a
 * recipe in twice. Each one writes through a Store, throws the instance away,
 * and opens a brand new Store over the same file, which is the closest thing
 * to a server restart that fits in a unit test.
 */

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-'));
  return {
    file: path.join(dir, 'db.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('a recipe written by one process is there for the next', () => {
  const { file, cleanup } = scratch();
  try {
    const first = new Store(file);
    first.update((d) => d.recipes.push({ id: 'r1', title: 'Roast Chicken', ingredients: ['1 chicken'] }));

    const second = new Store(file); // as if the server had been restarted
    assert.equal(second.data.recipes.length, 1);
    assert.equal(second.data.recipes[0].title, 'Roast Chicken');
    assert.deepEqual(second.data.recipes[0].ingredients, ['1 chicken']);
  } finally { cleanup(); }
});

test('the week plan and its tick boxes survive too', () => {
  const { file, cleanup } = scratch();
  try {
    const first = new Store(file);
    first.update((d) => {
      d.plan['2026-03-02'] = [{ id: 'm1', recipeId: 'r1', scale: 1.5 }];
      d.checked['2026-03-02'] = { garlic: false };
      d.settings.listName = 'Groceries';
    });

    const second = new Store(file);
    assert.equal(second.data.plan['2026-03-02'][0].scale, 1.5);
    assert.equal(second.data.checked['2026-03-02'].garlic, false);
    assert.equal(second.data.settings.listName, 'Groceries');
  } finally { cleanup(); }
});

test('every write lands immediately, with no save step', () => {
  const { file, cleanup } = scratch();
  try {
    const store = new Store(file);
    store.update((d) => d.recipes.push({ id: 'a', title: 'One' }));
    // Read the file directly rather than through the Store.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).recipes.length, 1);
    store.update((d) => d.recipes.push({ id: 'b', title: 'Two' }));
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).recipes.length, 2);
  } finally { cleanup(); }
});

test('a fresh install starts empty instead of erroring', () => {
  const { file, cleanup } = scratch();
  try {
    const store = new Store(file);
    assert.deepEqual(store.data.recipes, []);
    assert.ok(fs.existsSync(file), 'the file should be created on first run');
  } finally { cleanup(); }
});

test('new fields appear on a database written by an older version', () => {
  const { file, cleanup } = scratch();
  try {
    fs.writeFileSync(file, JSON.stringify({ recipes: [{ id: 'x', title: 'Old' }] }));
    const store = new Store(file);
    assert.equal(store.data.recipes.length, 1);
    // plan, checked, exports and settings were absent from the file.
    assert.deepEqual(store.data.plan, {});
    assert.ok(store.data.settings);
  } finally { cleanup(); }
});

test('a corrupt file is refused rather than quietly overwritten', () => {
  const { file, cleanup } = scratch();
  try {
    fs.writeFileSync(file, '{ this is not json');
    assert.throws(() => new Store(file), /Could not read/);
    // The damaged file must still be sitting there for you to rescue.
    assert.match(fs.readFileSync(file, 'utf8'), /this is not json/);
  } finally { cleanup(); }
});

test('backups accumulate and are capped at ten', () => {
  const { file, cleanup } = scratch();
  try {
    const store = new Store(file);
    store.update((d) => d.recipes.push({ id: 'a', title: 'Keep me' }));
    for (let i = 0; i < 13; i += 1) store.backup();
    const kept = fs.readdirSync(path.join(path.dirname(file), 'backups'));
    assert.ok(kept.length <= 10, `expected at most 10 backups, found ${kept.length}`);
    assert.ok(kept.length > 0);
  } finally { cleanup(); }
});
