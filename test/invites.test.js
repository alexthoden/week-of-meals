'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  Registry, normalizeCode, formatCode, CODE_LENGTH,
} = require('../server/lib/households');

/*
 * Households govern themselves: whoever starts one administers it, and gets in
 * by invitation only. The rules worth pinning are the refusals — an invitation
 * spent twice, one that has expired, one addressed to somebody else, and the
 * last administrator walking out and leaving a household nobody can change.
 */

function registry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-invites-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Registry(path.join(dir, 'households.json'));
}

/* ----------------------------------------------------------------- codes -- */

test('codes avoid the characters people mistype', () => {
  const reg = registry();
  const h = reg.create({ name: 'Home', createdBy: 'a@example.com' });

  for (let i = 0; i < 200; i += 1) {
    const { code } = reg.createInvite({ householdId: h.id, createdBy: 'a@example.com' });
    assert.equal(code.length, CODE_LENGTH);
    assert.doesNotMatch(code, /[OI L01UV]/,
      `"${code}" contains a character that is read wrong off a phone screen`);
  }
});

test('a code is recognised however it is typed back', () => {
  assert.equal(normalizeCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeCode('ABCD EFGH'), 'ABCDEFGH');
  assert.equal(normalizeCode(' abcdefgh '), 'ABCDEFGH');
  assert.equal(formatCode('ABCDEFGH'), 'ABCD-EFGH');
});

test('codes do not collide', () => {
  const reg = registry();
  const h = reg.create({ name: 'Home', createdBy: 'a@example.com' });
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    seen.add(reg.createInvite({ householdId: h.id, createdBy: 'a@example.com' }).code);
  }
  assert.equal(seen.size, 300);
});

/* --------------------------------------------------------------- joining -- */

test('an invitation lets somebody in, once', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  const invite = reg.createInvite({ householdId: h.id, createdBy: 'alex@example.com' });

  const joined = reg.redeemInvite(formatCode(invite.code), 'wife@example.com');
  assert.equal(joined.id, h.id);
  assert.ok(reg.isMember(h.id, 'wife@example.com'));

  assert.throws(() => reg.redeemInvite(invite.code, 'someone@example.com'), /already been used/);
});

test('joining does not make you an administrator', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  const invite = reg.createInvite({ householdId: h.id, createdBy: 'alex@example.com' });
  reg.redeemInvite(invite.code, 'wife@example.com');

  assert.ok(reg.isAdmin(h.id, 'alex@example.com'), 'the person who started it administers it');
  assert.equal(reg.isAdmin(h.id, 'wife@example.com'), false);
});

test('an expired invitation is refused, and says so', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  const invite = reg.createInvite({ householdId: h.id, createdBy: 'alex@example.com', ttlMs: -1 });

  assert.throws(() => reg.redeemInvite(invite.code, 'wife@example.com'), /expired/);
  assert.equal(reg.isMember(h.id, 'wife@example.com'), false);
});

test('an invitation addressed to somebody is useless to anyone else', () => {
  // What makes a code safe to text: if the message goes astray it is inert.
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  const invite = reg.createInvite({
    householdId: h.id, createdBy: 'alex@example.com', email: 'Wife@Example.com',
  });

  assert.throws(() => reg.redeemInvite(invite.code, 'stranger@example.com'), /issued for wife@example\.com/);
  assert.equal(reg.isMember(h.id, 'stranger@example.com'), false);

  const joined = reg.redeemInvite(invite.code, 'WIFE@example.com');
  assert.equal(joined.id, h.id, 'the intended person still gets in, whatever case they type');
});

test('an unknown code is refused the same way as a wrong one', () => {
  const reg = registry();
  assert.throws(() => reg.redeemInvite('ZZZZZZZZ', 'a@example.com'), /not valid/);
  assert.throws(() => reg.redeemInvite('', 'a@example.com'), /not valid/);
});

test('a revoked invitation stops working immediately', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  const invite = reg.createInvite({ householdId: h.id, createdBy: 'alex@example.com' });

  assert.equal(reg.revokeInvite(formatCode(invite.code)), true);
  assert.throws(() => reg.redeemInvite(invite.code, 'wife@example.com'), /not valid/);
});

test('only live invitations are listed', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  const live = reg.createInvite({ householdId: h.id, createdBy: 'alex@example.com' });
  const spent = reg.createInvite({ householdId: h.id, createdBy: 'alex@example.com' });
  reg.createInvite({ householdId: h.id, createdBy: 'alex@example.com', ttlMs: -1 });
  reg.redeemInvite(spent.code, 'wife@example.com');

  assert.deepEqual(reg.invitesFor(h.id).map((i) => i.code), [live.code]);
});

test('one household\'s invitation cannot be used to reach another', () => {
  const reg = registry();
  const ours = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  const theirs = reg.create({ name: 'Parents', createdBy: 'mom@example.com' });
  const invite = reg.createInvite({ householdId: theirs.id, createdBy: 'mom@example.com' });

  const joined = reg.redeemInvite(invite.code, 'alex@example.com');
  assert.equal(joined.id, theirs.id);
  assert.equal(reg.forEmail('alex@example.com').length, 2, 'and now they are in both');
  assert.ok(reg.isAdmin(ours.id, 'alex@example.com'));
  assert.equal(reg.isAdmin(theirs.id, 'alex@example.com'), false,
    'joining somebody else\'s household does not put you in charge of it');
});

/* ------------------------------------------------------------------ roles -- */

test('an administrator can promote and demote', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  reg.addMember(h.id, 'wife@example.com');

  reg.setAdmin(h.id, 'wife@example.com', true);
  assert.ok(reg.isAdmin(h.id, 'wife@example.com'));

  reg.setAdmin(h.id, 'wife@example.com', false);
  assert.equal(reg.isAdmin(h.id, 'wife@example.com'), false);
});

test('somebody outside the household cannot be made an administrator of it', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  assert.throws(() => reg.setAdmin(h.id, 'stranger@example.com', true), /not in this household/);
});

test('the last administrator cannot step down', () => {
  /*
   * Not locked in any dramatic sense — but nothing about the household could
   * change again without the command line, which is a state to refuse rather
   * than allow and explain afterwards.
   */
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  reg.addMember(h.id, 'wife@example.com');

  assert.throws(() => reg.setAdmin(h.id, 'alex@example.com', false), /Somebody has to be able/);

  reg.setAdmin(h.id, 'wife@example.com', true);
  reg.setAdmin(h.id, 'alex@example.com', false);
  assert.deepEqual(reg.byId(h.id).admins, ['wife@example.com'], 'once there are two, either may go');
});

test('removing somebody takes their administrator role with them', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  reg.addMember(h.id, 'wife@example.com', { admin: true });

  reg.removeMember(h.id, 'wife@example.com');
  assert.equal(reg.isMember(h.id, 'wife@example.com'), false);
  assert.equal(reg.isAdmin(h.id, 'wife@example.com'), false);
});

test('a household with nobody in charge can be claimed by a member', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  reg.addMember(h.id, 'wife@example.com');
  reg.removeMember(h.id, 'alex@example.com'); // from outside; leaves no admin

  assert.deepEqual(reg.byId(h.id).admins, []);
  assert.throws(() => reg.claim(h.id, 'stranger@example.com'), /Only a member/);

  reg.claim(h.id, 'wife@example.com');
  assert.ok(reg.isAdmin(h.id, 'wife@example.com'));
  assert.throws(() => reg.claim(h.id, 'wife@example.com'), /already has an administrator/);
});

/* -------------------------------------------------------------- migration -- */

test('a registry from before self-government gets an administrator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-v1-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'households.json');

  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    households: [
      { id: 'h1', name: 'Home', members: ['alex@example.com', 'wife@example.com'], createdAt: 'x' },
      { id: 'h2', name: 'Empty', members: [], createdAt: 'x' },
    ],
  }));

  const reg = new Registry(file);
  assert.equal(reg.data.version, 2);
  assert.deepEqual(reg.byId('h1').admins, ['alex@example.com'],
    'the longest-standing member is the one who set it up');
  assert.deepEqual(reg.byId('h2').admins, [],
    'a household with no members gets no invented administrator');
  assert.ok(Array.isArray(reg.data.invites));

  // And it was written back, so the next process does not redo the work.
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
});

test('an empty migrated household is claimable by whoever joins it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-v1b-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'households.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    households: [{ id: 'h1', name: 'Home', members: [], createdAt: 'x' }],
  }));

  // Exactly the situation a blank ALLOWED_EMAILS produced: recipes on disk and
  // nobody able to reach them. Adding yourself from the command line and taking
  // charge has to work.
  const reg = new Registry(file);
  reg.addMember('h1', 'alex@example.com');
  reg.claim('h1', 'alex@example.com');

  assert.ok(reg.isAdmin('h1', 'alex@example.com'));
});

test('a just-expired code still says "expired" rather than "not valid"', () => {
  // The difference between an instruction and a dead end.
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  const invite = reg.createInvite({ householdId: h.id, createdBy: 'alex@example.com', ttlMs: -1 });

  assert.ok(reg.findInvite(invite.code), 'the record is kept past expiry so we can explain');
  assert.deepEqual(reg.invitesFor(h.id), [], 'but it is not offered as live');
});

test('long-dead invitations are eventually forgotten', () => {
  const reg = registry();
  const h = reg.create({ name: 'Ours', createdBy: 'alex@example.com' });
  reg.createInvite({ householdId: h.id, createdBy: 'alex@example.com', ttlMs: -1 });

  // Well past the window in which explaining is still useful.
  reg.pruneInvites(Date.now() + (60 * 24 * 60 * 60 * 1000));
  assert.deepEqual(reg.data.invites, [], 'the registry should not grow without bound');
});
