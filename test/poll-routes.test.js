'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Polls through the real server: who may run one, who may vote, what the wire
 * gives away while voting is open, and what applying does to the week.
 */

const TEAM = 'ourhouse';
const AUD = 'a'.repeat(64);

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'cf-key-1', alg: 'RS256', use: 'sig' };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-polls-'));
process.env.DATA_ROOT = root;
process.env.CF_ACCESS_TEAM = TEAM;
process.env.CF_ACCESS_AUD = AUD;
delete process.env.ALLOWED_EMAILS;
delete process.env.DATA_FILE;
delete process.env.IMAGE_DIR;

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => (String(url).includes('/cdn-cgi/access/certs')
  ? { ok: true, status: 200, json: async () => ({ keys: [jwk] }) }
  : realFetch(url, options));

const { app, registry, forHousehold } = require('../server/index');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function assertionFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const input = `${b64({ alg: 'RS256', kid: 'cf-key-1', typ: 'JWT' })}.${b64({
    iss: `https://${TEAM}.cloudflareaccess.com`,
    aud: [AUD],
    sub: `sub-${email}`,
    email,
    iat: now,
    exp: now + 3600,
  })}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/* One household: an admin and two members. */
const home = registry.all()[0];
registry.addMember(home.id, 'alex@example.com', { admin: true });
registry.addMember(home.id, 'wife@example.com');
registry.addMember(home.id, 'kid@example.com');

const RECIPES = ['Chili', 'Pasta', 'Tacos', 'Soup'].map((title) => ({
  id: `r-${title.toLowerCase()}`, title, tags: [], ingredients: ['x'], steps: [], category: 'dinner',
}));
forHousehold(home.id).store.update((d) => { d.recipes.push(...RECIPES); });

let base;
const server = app.listen(0);
test.before(async () => {
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.close();
  globalThis.fetch = realFetch;
  fs.rmSync(root, { recursive: true, force: true });
});

async function call(method, url, email, body) {
  const sendsBody = body !== undefined && !['GET', 'HEAD'].includes(method);
  const res = await realFetch(`${base}${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(email ? { cookie: `CF_Authorization=${assertionFor(email)}` } : {}),
    },
    body: sendsBody ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let DAYS;
let pollId;

test('an administrator opens a poll for the days they choose', async () => {
  const boot = await call('GET', '/api/bootstrap', 'alex@example.com');
  DAYS = boot.body.dates.slice(0, 3);

  const made = await call('POST', '/api/polls', 'alex@example.com', {
    week: boot.body.weekOf, days: DAYS, category: 'dinner',
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.poll.status, 'open');
  assert.equal(made.body.poll.wanted, 3, 'how many meals comes from how many days');
  assert.equal(made.body.poll.candidates.length, RECIPES.length, 'no shortlist means every recipe');
  pollId = made.body.poll.id;
});

test('a member cannot open one', async () => {
  const boot = await call('GET', '/api/bootstrap', 'wife@example.com');
  const nope = await call('POST', '/api/polls', 'wife@example.com', {
    week: boot.body.weekOf, days: DAYS,
  });
  assert.equal(nope.status, 403);
  assert.equal(nope.body.code, 'NOT_ADMIN');
});

test('two polls cannot be open for the same week', async () => {
  const boot = await call('GET', '/api/bootstrap', 'alex@example.com');
  const second = await call('POST', '/api/polls', 'alex@example.com', {
    week: boot.body.weekOf, days: DAYS,
  });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'POLL_OPEN');
});

test('members vote, and may change their minds', async () => {
  const first = await call('PUT', `/api/polls/${pollId}/vote`, 'wife@example.com', {
    approvals: ['r-chili'],
  });
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.poll.myVote, ['r-chili']);

  const changed = await call('PUT', `/api/polls/${pollId}/vote`, 'wife@example.com', {
    approvals: ['r-pasta', 'r-tacos'],
  });
  assert.deepEqual(changed.body.poll.myVote, ['r-pasta', 'r-tacos']);
});

test('while open, the wire carries no tally and nobody else\'s ballot', async () => {
  await call('PUT', `/api/polls/${pollId}/vote`, 'alex@example.com', { approvals: ['r-pasta', 'r-soup'] });

  const seen = await call('GET', '/api/polls', 'kid@example.com');
  const poll = seen.body.polls[0];

  assert.equal(poll.result, null);
  const text = JSON.stringify(poll);
  assert.ok(!text.includes('ballots'), 'ballots must never reach the browser');
  assert.ok(!text.includes('approvals'), 'nor any count, while people are still voting');

  // Turnout is fine — it is how you know who to nudge.
  assert.deepEqual(poll.turnout, { voted: 2, of: 3 });
  assert.deepEqual(poll.voted.sort(), ['alex@example.com', 'wife@example.com']);
  assert.equal(poll.myVote, null, 'the kid has not voted');
});

test('a shortlist limits the ballot, and a vote outside it is dropped', async () => {
  // A different week, so this poll does not collide with the open one.
  const later = new Date(Date.now() + (14 * 86400000)).toISOString().slice(0, 10);
  const boot = await call('GET', `/api/bootstrap?week=${later}`, 'alex@example.com');

  const made = await call('POST', '/api/polls', 'alex@example.com', {
    week: boot.body.weekOf,
    days: boot.body.dates.slice(0, 2),
    candidates: ['r-chili', 'r-soup'],
  });
  assert.equal(made.status, 201);
  assert.deepEqual(made.body.poll.candidates.map((c) => c.title), ['Chili', 'Soup'],
    'only what the administrator offered');

  // A stale page tries to approve something that was never on the ballot.
  const voted = await call('PUT', `/api/polls/${made.body.poll.id}/vote`, 'kid@example.com', {
    approvals: ['r-chili', 'r-pasta', 'made-up'],
  });
  assert.deepEqual(voted.body.poll.myVote, ['r-chili'],
    'the off-ballot approvals are discarded rather than honoured');

  await call('DELETE', `/api/polls/${made.body.poll.id}`, 'alex@example.com');
});

test('closing reveals the ranking, and approval picks the agreeable meal', async () => {
  await call('PUT', `/api/polls/${pollId}/vote`, 'kid@example.com', { approvals: ['r-pasta'] });

  const closed = await call('POST', `/api/polls/${pollId}/close`, 'alex@example.com');
  assert.equal(closed.status, 200);
  assert.equal(closed.body.poll.status, 'closed');

  const [top] = closed.body.poll.result;
  assert.equal(top.title, 'Pasta', 'everybody was happy with pasta');
  assert.equal(top.approvals, 3);
});

test('a member cannot close a poll', async () => {
  const boot = await call('GET', '/api/bootstrap', 'alex@example.com');
  const made = await call('POST', '/api/polls', 'alex@example.com', {
    week: boot.body.weekOf, days: [boot.body.dates[4]],
  });
  const nope = await call('POST', `/api/polls/${made.body.poll.id}/close`, 'kid@example.com');
  assert.equal(nope.status, 403);
  await call('DELETE', `/api/polls/${made.body.poll.id}`, 'alex@example.com');
});

test('a closed poll takes no more votes', async () => {
  const late = await call('PUT', `/api/polls/${pollId}/vote`, 'kid@example.com', { approvals: [] });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'POLL_CLOSED');
});

/* --------------------------------------------------------------- applying */

test('applying fills the chosen days with the winners, in order', async () => {
  const applied = await call('POST', `/api/polls/${pollId}/apply`, 'alex@example.com');
  assert.equal(applied.status, 200);
  assert.equal(applied.body.added.length, 3, 'three days, three meals');

  const boot = await call('GET', '/api/bootstrap', 'alex@example.com');
  const first = boot.body.plan[DAYS[0]];
  assert.equal(first[0].title, 'Pasta', 'the most-approved meal lands on the first day');
});

test('applying twice does not double up the week', async () => {
  const before = await call('GET', '/api/bootstrap', 'alex@example.com');
  const count = (b) => b.body.dates.reduce((n, d) => n + (b.body.plan[d]?.length || 0), 0);

  await call('POST', `/api/polls/${pollId}/apply`, 'alex@example.com');
  const after = await call('GET', '/api/bootstrap', 'alex@example.com');
  assert.equal(count(after), count(before), 'a second press is idempotent');
});

test('an admin may drop a winner before applying', async () => {
  // The reason applying is a separate, deliberate press rather than automatic.
  const boot = await call('GET', '/api/bootstrap', 'alex@example.com');
  const day = boot.body.dates[6];

  const made = await call('POST', '/api/polls', 'alex@example.com', { week: boot.body.weekOf, days: [day] });
  const id = made.body.poll.id;
  await call('PUT', `/api/polls/${id}/vote`, 'alex@example.com', { approvals: ['r-chili', 'r-soup'] });
  await call('POST', `/api/polls/${id}/close`, 'alex@example.com');

  // Ignore the ranking and insist on soup.
  const applied = await call('POST', `/api/polls/${id}/apply`, 'alex@example.com', {
    recipeIds: ['r-soup'],
  });
  assert.equal(applied.status, 200);

  const after = await call('GET', '/api/bootstrap', 'alex@example.com');
  assert.equal(after.body.plan[day][0].title, 'Soup');
});

test('an open poll cannot be applied', async () => {
  const boot = await call('GET', '/api/bootstrap', 'alex@example.com');
  const made = await call('POST', '/api/polls', 'alex@example.com', {
    week: boot.body.weekOf, days: [boot.body.dates[5]],
  });
  const nope = await call('POST', `/api/polls/${made.body.poll.id}/apply`, 'alex@example.com');
  assert.equal(nope.status, 409);
  assert.equal(nope.body.code, 'POLL_OPEN');
});

test('a member cannot apply a result', async () => {
  const nope = await call('POST', `/api/polls/${pollId}/apply`, 'kid@example.com');
  assert.equal(nope.status, 403);
});

/* ------------------------------------------------------------- isolation -- */

test('another household cannot see or touch this poll', async () => {
  const theirs = registry.create({ name: 'Parents', members: ['mum@example.com'] });
  forHousehold(theirs.id).store.update((d) => { d.recipes.push({ id: 'x', title: 'Theirs' }); });

  const seen = await call('GET', '/api/polls', 'mum@example.com');
  assert.deepEqual(seen.body.polls, [], 'polls belong to a household like everything else');

  const nope = await call('PUT', `/api/polls/${pollId}/vote`, 'mum@example.com', { approvals: ['r-chili'] });
  assert.equal(nope.status, 404, "another household's poll should simply not exist");
});
