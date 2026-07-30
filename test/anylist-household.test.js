'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const storage = require('../server/lib/storage');

/*
 * One AnyList account per household.
 *
 * Before households the account came from the environment and there was one of
 * it. Left that way, the second family's shopping list would be pushed into the
 * first family's AnyList — a privacy failure rather than a missing feature, and
 * a silent one, because the export would report success.
 */

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-anylist-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fresh(env = {}) {
  storage.reset();
  const root = tmp();
  return storage.create({ DATA_ROOT: root, ...env });
}

test('a household with no credentials cannot export', () => {
  const { registry, forHousehold } = fresh();
  const { anylist } = forHousehold(registry.all()[0].id);

  assert.equal(anylist().configured(), false);
  storage.reset();
});

test('the message points at Settings, not at a .env file nobody has', () => {
  const { registry, forHousehold } = fresh();
  const { anylist } = forHousehold(registry.all()[0].id);

  return anylist().listNames().then(
    () => assert.fail('should not have connected'),
    (err) => {
      assert.equal(err.code, 'NOT_CONFIGURED');
      assert.match(err.message, /Settings/);
    },
  ).finally(() => storage.reset());
});

test('each household gets its own account and its own session file', () => {
  const { registry, forHousehold, secrets } = fresh();
  const ours = registry.all()[0];
  const parents = registry.create({ name: 'Parents' });

  forHousehold(ours.id).store.update((d) => {
    d.settings.anylist = { email: 'us@example.com', password: secrets.encrypt('ours') };
  });
  forHousehold(parents.id).store.update((d) => {
    d.settings.anylist = { email: 'them@example.com', password: secrets.encrypt('theirs') };
  });

  assert.equal(forHousehold(ours.id).anylist().configured(), true);
  assert.equal(forHousehold(parents.id).anylist().configured(), true);
  assert.notEqual(forHousehold(ours.id).anylist(), forHousehold(parents.id).anylist(),
    'two households must never share one authenticated client');

  storage.reset();
});

test('one household having an account does not configure the other', () => {
  const { registry, forHousehold, secrets } = fresh();
  const ours = registry.all()[0];
  const parents = registry.create({ name: 'Parents' });

  forHousehold(ours.id).store.update((d) => {
    d.settings.anylist = { email: 'us@example.com', password: secrets.encrypt('ours') };
  });

  assert.equal(forHousehold(ours.id).anylist().configured(), true);
  assert.equal(forHousehold(parents.id).anylist().configured(), false,
    'the second household must bring its own account, not inherit one');

  storage.reset();
});

test('changing the password takes effect without a restart', () => {
  const { registry, forHousehold, secrets } = fresh();
  const h = registry.all()[0];
  const { store, anylist } = forHousehold(h.id);

  store.update((d) => { d.settings.anylist = { email: 'a@example.com', password: secrets.encrypt('old') }; });
  const before = anylist();

  store.update((d) => { d.settings.anylist = { email: 'a@example.com', password: secrets.encrypt('new') }; });
  const after = anylist();

  assert.notEqual(before, after, 'a new password should build a new client, not reuse the old session');
  storage.reset();
});

test('the same credentials reuse the same client', () => {
  // The other half of the rule above: no rebuilding, and no logging in again,
  // on every single request.
  const { registry, forHousehold, secrets } = fresh();
  const { store, anylist } = forHousehold(registry.all()[0].id);
  store.update((d) => { d.settings.anylist = { email: 'a@example.com', password: secrets.encrypt('same') }; });

  assert.equal(anylist(), anylist());
  storage.reset();
});

test('the stored password is encrypted on disk', () => {
  const { registry, forHousehold, secrets, root } = fresh();
  const h = registry.all()[0];
  const { store } = forHousehold(h.id);

  store.update((d) => { d.settings.anylist = { email: 'a@example.com', password: secrets.encrypt('hunter2') }; });

  const raw = fs.readFileSync(path.join(root, 'households', `${h.id}.json`), 'utf8');
  assert.ok(!raw.includes('hunter2'),
    'the password must not be readable in the file, which is what gets tarred into backups');
  assert.ok(raw.includes('v1:'));
  storage.reset();
});

/* ------------------------------------------------------------- migration -- */

test('the environment account becomes the migrated household\'s, encrypted', () => {
  storage.reset();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'db.json'), JSON.stringify({
    recipes: [], plan: {}, checked: {}, exports: [], settings: { listName: 'Groceries' },
  }));

  const { registry, forHousehold } = storage.create({
    DATA_ROOT: root,
    ANYLIST_EMAIL: 'legacy@example.com',
    ANYLIST_PASSWORD: 'legacy-password',
  });

  const h = registry.all()[0];
  const { store, anylist } = forHousehold(h.id);

  assert.equal(store.data.settings.anylist.email, 'legacy@example.com');
  assert.equal(anylist().configured(), true, 'export keeps working across the upgrade');

  const raw = fs.readFileSync(path.join(root, 'households', `${h.id}.json`), 'utf8');
  assert.ok(!raw.includes('legacy-password'), 'and it is encrypted on the way in');

  storage.reset();
});

test('a second household does NOT inherit the environment account', () => {
  /*
   * The precise bug this design exists to prevent. The environment variables
   * are a one-time seed for the household the migration creates; falling back
   * to them for any household without its own would send the second family's
   * groceries to the first family's phone.
   */
  storage.reset();
  const root = tmp();
  fs.writeFileSync(path.join(root, 'db.json'), JSON.stringify({ recipes: [] }));

  const { registry, forHousehold } = storage.create({
    DATA_ROOT: root,
    ANYLIST_EMAIL: 'legacy@example.com',
    ANYLIST_PASSWORD: 'legacy-password',
  });

  const parents = registry.create({ name: 'Parents', members: ['mom@example.com'] });
  assert.equal(forHousehold(parents.id).anylist().configured(), false,
    'a household created after the migration must supply its own account');

  storage.reset();
});

test('a fresh install with environment credentials still starts unconfigured', () => {
  // No legacy database means nothing to inherit: the account is asked for in
  // Settings, per household, like every other new installation.
  storage.reset();
  const { registry, forHousehold } = storage.create({
    DATA_ROOT: tmp(),
    ANYLIST_EMAIL: 'someone@example.com',
    ANYLIST_PASSWORD: 'whatever',
  });

  assert.equal(forHousehold(registry.all()[0].id).anylist().configured(), false);
  storage.reset();
});
