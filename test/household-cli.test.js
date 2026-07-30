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
  main(['rename', 'Parents', 'Mum and Dad']);
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
  assert.throws(() => main(['rename', 'Home']), /Give the new name/);
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
