'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway root, set before the CLI module builds its storage.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-cli-'));
process.env.DATA_ROOT = root;
delete process.env.DATA_FILE;
delete process.env.ALLOWED_EMAILS;

const { main } = require('../server/household');
const { Registry } = require('../server/lib/households');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const registry = () => new Registry(path.join(root, 'households.json'));

test('list shows the household a fresh install creates', () => {
  const out = main(['list']);
  assert.match(out, /Home/);
  assert.match(out, /\(nobody yet\)/);
});

test('add creates a household with its members', () => {
  main(['add', 'Parents', 'mom@example.com', 'dad@example.com']);
  const parents = registry().all().find((h) => h.name === 'Parents');

  assert.ok(parents, 'the household should be on disk');
  assert.deepEqual(parents.members, ['mom@example.com', 'dad@example.com']);
});

test('a household name with spaces survives npm mangling the quotes', () => {
  /*
   * `npm run household -- join "Shrek's Swamp" me@example.com` does not
   * reliably keep its quoting through npm, so the name can arrive as two
   * arguments. Anything with an @ is an address; the rest is the name.
   */
  main(['add', "Shrek's", 'Swamp', 'ogre@example.com']);
  main(['join', "Shrek's", 'Swamp', 'donkey@example.com']);

  const swamp = registry().all().find((h) => h.name === "Shrek's Swamp");
  assert.ok(swamp, 'the two fragments should have been rejoined into one name');
  assert.deepEqual(swamp.members, ['ogre@example.com', 'donkey@example.com']);
});

test('rename takes --to, so both names may contain spaces', () => {
  main(['rename', "Shrek's", 'Swamp', '--to', "Fiona's", 'Castle']);
  assert.ok(registry().all().some((h) => h.name === "Fiona's Castle"));
  assert.throws(() => main(['rename', 'A', 'B']), /--to/);
});

test('every command says which registry file it touched', () => {
  // Running from a source checkout edits a different, empty registry that the
  // running server never reads. Printing the path is what makes that visible.
  for (const argv of [['list'], ['join', "Fiona's", 'Castle', 'x@example.com']]) {
    assert.match(main(argv), /Registry: .*households\.json/);
  }
});

test('with one household, the name can be left out entirely', () => {
  /*
   * Where this actually bites: a household called "Shrek's Swamp" has an
   * apostrophe in it, which opens a quote the shell waits forever to have
   * closed. The command appears to hang and never runs. With one household
   * there is nothing to disambiguate, so the name is not required.
   */
  const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-solo-'));
  test.after(() => fs.rmSync(solo, { recursive: true, force: true }));

  const storage = require('../server/lib/storage');
  storage.reset();
  const { registry: reg } = storage.create({ DATA_ROOT: solo });
  const only = reg.all()[0];

  reg.addMember(only.id, 'alex@example.com');
  assert.deepEqual(reg.byId(only.id).members, ['alex@example.com']);
  storage.reset();
});

test('with two households, leaving the name out is refused, not guessed', () => {
  // Adding somebody to the wrong family is not a guess worth making.
  assert.throws(() => main(['join', 'someone@example.com']), /more than one household/i);
  assert.throws(() => main(['leave', 'someone@example.com']), /more than one household/i);
});

test('a name that matches nothing lists what does exist', () => {
  assert.throws(() => main(['join', 'Nowhere', 'a@example.com']), /Known households:/);
});

test('a household can be named or identified by its id', () => {
  const parents = registry().all().find((h) => h.name === 'Parents');

  main(['join', 'Parents', 'sister@example.com']);
  main(['join', parents.id, 'brother@example.com']);

  const after = registry().all().find((h) => h.id === parents.id);
  assert.ok(after.members.includes('sister@example.com'));
  assert.ok(after.members.includes('brother@example.com'));
});

test('leave removes somebody and says so when the last one goes', () => {
  main(['add', 'Empty Soon', 'only@example.com']);
  const out = main(['leave', 'Empty Soon', 'only@example.com']);

  assert.match(out, /Warning: nobody is left/,
    'an unreachable household is worth pointing out rather than leaving to be discovered');
  assert.deepEqual(registry().all().find((h) => h.name === 'Empty Soon').members, []);
});

test('rename keeps the id, so nothing else has to be updated', () => {
  const before = registry().all().find((h) => h.name === 'Parents');
  main(['rename', 'Parents', '--to', 'Mum and Dad']);
  const after = registry().byId(before.id);

  assert.equal(after.name, 'Mum and Dad');
  assert.equal(after.id, before.id);
});

test('an unknown household is refused rather than silently created', () => {
  assert.throws(() => main(['join', 'Nobody Here', 'a@example.com']), /No household matches/);
});

test('a command with missing arguments explains itself', () => {
  assert.throws(() => main(['add']), /Give the household a name/);
  assert.throws(() => main(['join', 'Home']), /at least one email/);
  assert.throws(() => main(['rename', 'Home', '--to']), /Give the new name/);
});

test('an unrecognised command prints usage instead of throwing', () => {
  for (const argv of [[], ['help'], ['nonsense']]) {
    assert.match(main(argv), /Usage: npm run household/);
  }
});

test('the registry still parses after every command', () => {
  // The whole reason this CLI exists instead of "just edit the JSON".
  const raw = fs.readFileSync(path.join(root, 'households.json'), 'utf8');
  assert.doesNotThrow(() => JSON.parse(raw));
  assert.ok(JSON.parse(raw).households.length >= 2);
});

test('admin is break-glass: it grants and revokes from the command line', () => {
  /*
   * Households govern themselves in the app. This exists for the person who
   * owns the machine, when the last administrator has left or a registry
   * predates the idea entirely and nobody can invite anyone.
   */
  main(['add', 'Stranded', 'someone@example.com']);
  main(['admin', 'Stranded', 'owner@example.com']);

  const h = () => registry().all().find((x) => x.name === 'Stranded');
  assert.ok(h().members.includes('owner@example.com'), 'promoting also adds them if needed');
  assert.ok(h().admins.includes('owner@example.com'));

  // someone@example.com became admin by being the first member, so there are
  // two and either may be demoted.
  main(['admin', 'Stranded', 'owner@example.com', '--revoke']);
  assert.equal(h().admins.includes('owner@example.com'), false);
  assert.ok(h().members.includes('owner@example.com'), 'demoting does not remove them');
});

test('the last administrator cannot be revoked from the command line either', () => {
  main(['add', 'Solo Admin', 'only@example.com']);
  assert.throws(() => main(['admin', 'Solo Admin', 'only@example.com', '--revoke']),
    /Somebody has to be able/);
});

test('list marks who administers', () => {
  // Who can invite is the first thing you want from this command when somebody
  // says they cannot add their wife.
  main(['add', 'Marked Up', 'boss@example.com', 'other@example.com']);
  const out = main(['list']);

  assert.match(out, /boss@example\.com \(admin\)/, 'the first member administers by default');
  assert.match(out, /other@example\.com(?! \(admin\))/, 'and the rest plainly do not');
});
