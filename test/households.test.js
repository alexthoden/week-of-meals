'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Registry } = require('../server/lib/households');
const storage = require('../server/lib/storage');

/*
 * Households are the isolation boundary. Most of what is worth asserting here
 * is not "does it work" but "does one family's data stay away from another's",
 * because the failure mode is silent: nobody notices reading the wrong recipes
 * until they notice, and nobody notices deleted photos until they look.
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-households-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/* -------------------------------------------------------------- registry -- */

test('a fresh registry starts empty and writes itself out', () => {
  const dir = tmp();
  const file = path.join(dir, 'households.json');
  const registry = new Registry(file);

  assert.deepEqual(registry.all(), []);
  assert.ok(fs.existsSync(file), 'the registry file should exist after construction');
});

test('a household remembers its members, lowercased and deduped', () => {
  const registry = new Registry(path.join(tmp(), 'households.json'));
  const h = registry.create({ name: 'Home', members: ['  Alex@Example.com ', 'alex@example.com', 'wife@example.com'] });

  assert.deepEqual(h.members, ['alex@example.com', 'wife@example.com']);
});

test('a person is found by email whatever case they type', () => {
  const registry = new Registry(path.join(tmp(), 'households.json'));
  const ours = registry.create({ name: 'Ours', members: ['alex@example.com'] });
  registry.create({ name: 'Parents', members: ['mom@example.com', 'dad@example.com'] });

  assert.deepEqual(registry.forEmail('ALEX@example.com').map((h) => h.id), [ours.id]);
  assert.deepEqual(registry.forEmail('nobody@example.com'), []);
  assert.deepEqual(registry.forEmail(''), []);
  assert.deepEqual(registry.forEmail(undefined), []);
});

test('one person can be in two households', () => {
  // The modelled-but-rarely-shown case: helping your parents plan a week.
  const registry = new Registry(path.join(tmp(), 'households.json'));
  registry.create({ name: 'Ours', members: ['alex@example.com', 'wife@example.com'] });
  registry.create({ name: 'Parents', members: ['alex@example.com', 'mom@example.com'] });

  assert.deepEqual(registry.forEmail('alex@example.com').map((h) => h.name), ['Ours', 'Parents']);
  assert.deepEqual(registry.forEmail('wife@example.com').map((h) => h.name), ['Ours']);
});

test('membership changes survive a reload', () => {
  const file = path.join(tmp(), 'households.json');
  const registry = new Registry(file);
  const h = registry.create({ name: 'Home', members: ['alex@example.com'] });

  registry.addMember(h.id, 'Wife@Example.com');
  registry.removeMember(h.id, 'alex@example.com');

  const reopened = new Registry(file);
  assert.deepEqual(reopened.byId(h.id).members, ['wife@example.com']);
});

test('adding the same person twice does not duplicate them', () => {
  const registry = new Registry(path.join(tmp(), 'households.json'));
  const h = registry.create({ name: 'Home', members: ['alex@example.com'] });
  registry.addMember(h.id, 'alex@example.com');
  registry.addMember(h.id, 'ALEX@EXAMPLE.COM');

  assert.deepEqual(registry.byId(h.id).members, ['alex@example.com']);
});

test('a corrupt registry is refused rather than quietly replaced', () => {
  const file = path.join(tmp(), 'households.json');
  fs.writeFileSync(file, '{ not json');
  assert.throws(() => new Registry(file), /Could not read/);
});

/* ------------------------------------------------------------- isolation -- */

test('two households cannot see each other\'s recipes', () => {
  storage.reset();
  const root = tmp();
  const { registry, forHousehold } = storage.create({ DATA_ROOT: root });

  const ours = registry.all()[0]; // created by the migration path
  const parents = registry.create({ name: 'Parents', members: ['mom@example.com'] });

  forHousehold(ours.id).store.update((d) => d.recipes.push({ id: 'a', title: 'Our Chili' }));
  forHousehold(parents.id).store.update((d) => d.recipes.push({ id: 'b', title: 'Their Pie' }));

  assert.deepEqual(forHousehold(ours.id).store.data.recipes.map((r) => r.title), ['Our Chili']);
  assert.deepEqual(forHousehold(parents.id).store.data.recipes.map((r) => r.title), ['Their Pie']);
  storage.reset();
});

test('each household writes to its own file', () => {
  storage.reset();
  const root = tmp();
  const { registry, forHousehold } = storage.create({ DATA_ROOT: root });
  const a = registry.all()[0];
  const b = registry.create({ name: 'Parents' });

  forHousehold(a.id).store.update((d) => d.recipes.push({ id: 'x', title: 'Only Ours' }));
  forHousehold(b.id).store.update((d) => d.recipes.push({ id: 'y', title: 'Only Theirs' }));

  const onDisk = (id) => JSON.parse(fs.readFileSync(path.join(root, 'households', `${id}.json`), 'utf8'));
  assert.deepEqual(onDisk(a.id).recipes.map((r) => r.title), ['Only Ours']);
  assert.deepEqual(onDisk(b.id).recipes.map((r) => r.title), ['Only Theirs']);
  storage.reset();
});

test('tidying one household\'s photos leaves the other household\'s alone', () => {
  /*
   * The landmine this whole layout exists to defuse.
   *
   * collectGarbage deletes every file in its directory that no recipe refers
   * to. Before households it took the one and only recipe list, which was
   * correct. Hand it one household's recipes while both share a directory and
   * it deletes the other household's entire photo library — silently, and with
   * no undo, because the photos were never in the store's backup.
   */
  storage.reset();
  const root = tmp();
  const { registry, forHousehold } = storage.create({ DATA_ROOT: root });
  const ours = registry.all()[0];
  const parents = registry.create({ name: 'Parents' });

  const ourImages = forHousehold(ours.id).images;
  const theirImages = forHousehold(parents.id).images;

  const pixel = `data:image/png;base64,${Buffer.from('not-really-a-png').toString('base64')}`;
  const ourPhoto = ourImages.saveDataUrl(pixel);
  const theirPhoto = theirImages.saveDataUrl(pixel);

  assert.notEqual(ourImages.IMAGE_DIR, theirImages.IMAGE_DIR, 'directories must not be shared');

  // Our household tidies up with no recipes at all: every one of OUR photos is
  // orphaned and should go.
  const removed = ourImages.collectGarbage([]);
  assert.equal(removed, 1, 'our own orphaned photo should be collected');

  assert.equal(fs.existsSync(ourImages.fileFor(path.basename(ourPhoto))), false);
  assert.equal(fs.existsSync(theirImages.fileFor(path.basename(theirPhoto))), true,
    'the other household\'s photo must survive our tidy-up');
  storage.reset();
});

test('a photo name cannot walk out of its household directory', () => {
  storage.reset();
  const { registry, forHousehold } = storage.create({ DATA_ROOT: tmp() });
  const { images } = forHousehold(registry.all()[0].id);

  assert.equal(images.fileFor('../../../etc/passwd'), null);
  assert.equal(images.fileFor('../other/secret.jpg'), null);
  assert.equal(images.fileFor('nested/path.jpg'), null);
  assert.equal(images.fileFor(''), null);
  assert.ok(images.fileFor('ab12cd34.jpg').startsWith(images.IMAGE_DIR));
  storage.reset();
});

test('backups are kept per household, so one cannot cull the other\'s', () => {
  storage.reset();
  const root = tmp();
  const { registry, forHousehold } = storage.create({ DATA_ROOT: root });
  const a = registry.all()[0];
  const b = registry.create({ name: 'Parents' });

  forHousehold(a.id).store.backup();
  forHousehold(b.id).store.backup();

  assert.notEqual(forHousehold(a.id).store.backupDir, forHousehold(b.id).store.backupDir);
  assert.equal(fs.readdirSync(forHousehold(a.id).store.backupDir).length, 1);
  assert.equal(fs.readdirSync(forHousehold(b.id).store.backupDir).length, 1);
  storage.reset();
});

/* ------------------------------------------------------------- migration -- */

test('a pre-household installation becomes household number one', () => {
  storage.reset();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'db.json'), JSON.stringify({
    version: 1,
    recipes: [{ id: 'r1', title: 'Old Recipe', image: '/images/abc123.jpg' }],
    plan: { '2026-01-01': [{ id: 'm1', recipeId: 'r1', scale: 1 }] },
    checked: {},
    exports: [],
    settings: { listName: 'Groceries', startOfWeek: 1, pantry: ['olive oil'] },
  }));
  fs.mkdirSync(path.join(root, 'images'), { recursive: true });
  fs.writeFileSync(path.join(root, 'images', 'abc123.jpg'), 'bytes');

  const { registry, forHousehold } = storage.create({
    DATA_ROOT: root,
    ALLOWED_EMAILS: 'alex@example.com, wife@example.com',
  });

  assert.equal(registry.all().length, 1, 'exactly one household');
  const household = registry.all()[0];

  // The people who were already allowed in are the founding members.
  assert.deepEqual(household.members, ['alex@example.com', 'wife@example.com']);

  const { store, images } = forHousehold(household.id);
  assert.deepEqual(store.data.recipes.map((r) => r.title), ['Old Recipe']);
  assert.equal(store.data.settings.listName, 'Groceries');
  assert.equal(store.data.settings.startOfWeek, 1);
  assert.deepEqual(store.data.plan['2026-01-01'].length, 1, 'the planned week came too');

  // The photo moved, and its stored URL did not have to change: the name is
  // resolved against the requesting household's directory now.
  assert.equal(store.data.recipes[0].image, '/images/abc123.jpg');
  assert.ok(fs.existsSync(path.join(images.IMAGE_DIR, 'abc123.jpg')));

  storage.reset();
});

test('the old database is kept, not deleted, so an upgrade can be undone', () => {
  storage.reset();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'db.json'), JSON.stringify({ recipes: [{ id: 'r1', title: 'Keep me' }] }));

  storage.create({ DATA_ROOT: root });

  assert.equal(fs.existsSync(path.join(root, 'db.json')), false, 'moved out of the way');
  assert.ok(fs.existsSync(path.join(root, 'db.json.migrated')), 'but still on disk');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(root, 'db.json.migrated'), 'utf8')).recipes.map((r) => r.title),
    ['Keep me'],
  );
  storage.reset();
});

test('migration does not run twice', () => {
  storage.reset();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'db.json'), JSON.stringify({ recipes: [{ id: 'r1', title: 'Original' }] }));

  const first = storage.create({ DATA_ROOT: root });
  const firstId = first.registry.all()[0].id;
  first.forHousehold(firstId).store.update((d) => d.recipes.push({ id: 'r2', title: 'Added later' }));

  storage.reset();
  const second = storage.create({ DATA_ROOT: root });

  assert.equal(second.registry.all().length, 1, 'still exactly one household');
  assert.equal(second.registry.all()[0].id, firstId, 'and the same one');
  assert.deepEqual(
    second.forHousehold(firstId).store.data.recipes.map((r) => r.title),
    ['Original', 'Added later'],
    'work done after the migration is not rolled back by a restart',
  );
  storage.reset();
});

test('a fresh install with no legacy database still gets a household', () => {
  storage.reset();
  const { registry } = storage.create({ DATA_ROOT: tmp() });
  assert.equal(registry.all().length, 1);
  assert.deepEqual(registry.all()[0].members, [], 'nobody named yet, which is fine unguarded');
  storage.reset();
});
