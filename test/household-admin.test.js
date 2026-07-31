'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * Self-service households, through the real server.
 *
 * The rules that matter here are all refusals, and every one of them is a way
 * somebody could otherwise reach a family they are not part of: inviting to a
 * household you do not administer, reading a members list you are not on,
 * promoting yourself, or spending a code twice.
 */

const TEAM = 'ourhouse';
const AUD = 'a'.repeat(64);

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'cf-key-1', alg: 'RS256', use: 'sig' };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-admin-'));
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

const { app, registry } = require('../server/index');

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
  // fetch refuses a body on GET/HEAD, so drop it rather than making every
  // caller remember which verb it is using.
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

/* ------------------------------------------------------------- creating -- */

test('anybody signed in can start a household, and administers it', async () => {
  const made = await call('POST', '/api/households', 'alex@example.com', { name: "Shrek's Swamp" });
  assert.equal(made.status, 201);
  assert.equal(made.body.household.name, "Shrek's Swamp");
  assert.equal(made.body.household.isAdmin, true);
  assert.deepEqual(made.body.household.members, ['alex@example.com']);
});

test('a household needs a name', async () => {
  const made = await call('POST', '/api/households', 'alex@example.com', { name: '   ' });
  assert.equal(made.status, 400);
  assert.equal(made.body.code, 'NO_NAME');
});

test('creating one immediately gets you out of the no-household state', async () => {
  const who = await call('GET', '/api/whoami', 'alex@example.com');
  assert.equal(who.body.households.length, 1);
  assert.equal(who.body.households[0].isAdmin, true);

  const boot = await call('GET', '/api/bootstrap', 'alex@example.com');
  assert.equal(boot.status, 200, 'the app should now load rather than 403');
});

/* -------------------------------------------------------------- inviting -- */

test('an administrator invites, and the invitee joins', async () => {
  const mine = registry.forEmail('alex@example.com')[0];

  const invited = await call('POST', `/api/households/${mine.id}/invites`, 'alex@example.com', {});
  assert.equal(invited.status, 201);
  assert.match(invited.body.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'shown in a form people can read out');

  const joined = await call('POST', '/api/households/join', 'wife@example.com', { code: invited.body.code });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.household.id, mine.id);
  assert.equal(joined.body.household.isAdmin, false, 'joining does not hand over the keys');

  const boot = await call('GET', '/api/bootstrap', 'wife@example.com');
  assert.equal(boot.status, 200);
});

test('a code cannot be spent twice', async () => {
  const mine = registry.forEmail('alex@example.com')[0];
  const invited = await call('POST', `/api/households/${mine.id}/invites`, 'alex@example.com', {});
  await call('POST', '/api/households/join', 'friend@example.com', { code: invited.body.code });

  const again = await call('POST', '/api/households/join', 'stranger@example.com', { code: invited.body.code });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'CODE_USED');
});

test('a nonsense code is refused without saying whether it ever existed', async () => {
  const bad = await call('POST', '/api/households/join', 'stranger@example.com', { code: 'ZZZZ-ZZZZ' });
  assert.equal(bad.status, 404);
  assert.equal(bad.body.code, 'BAD_CODE');
});

test('an invitation addressed to somebody is refused to anyone else', async () => {
  const mine = registry.forEmail('alex@example.com')[0];
  const invited = await call('POST', `/api/households/${mine.id}/invites`, 'alex@example.com', {
    email: 'mum@example.com',
  });

  const wrong = await call('POST', '/api/households/join', 'stranger@example.com', { code: invited.body.code });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, 'CODE_NOT_YOURS');

  const right = await call('POST', '/api/households/join', 'mum@example.com', { code: invited.body.code });
  assert.equal(right.status, 200);
});

/* -------------------------------------------------------- who may do what */

test('a member who is not an administrator cannot invite', async () => {
  const mine = registry.forEmail('alex@example.com')[0];
  const nope = await call('POST', `/api/households/${mine.id}/invites`, 'wife@example.com', {});
  assert.equal(nope.status, 403);
  assert.equal(nope.body.code, 'NOT_ADMIN');
});

test('somebody outside cannot even tell the household exists', async () => {
  const mine = registry.forEmail('alex@example.com')[0];

  for (const [method, url] of [
    ['GET', `/api/households/${mine.id}`],
    ['POST', `/api/households/${mine.id}/invites`],
    ['PUT', `/api/households/${mine.id}/name`],
  ]) {
    const res = await call(method, url, 'outsider@example.com', { name: 'Mine Now' });
    assert.equal(res.status, 404,
      `${method} ${url} should be indistinguishable from a household that does not exist`);
  }
});

test('a member can see who else is in it, without the invitations', async () => {
  const mine = registry.forEmail('alex@example.com')[0];

  const asMember = await call('GET', `/api/households/${mine.id}`, 'wife@example.com');
  assert.equal(asMember.status, 200);
  assert.ok(asMember.body.members.includes('alex@example.com'));
  assert.equal(asMember.body.invites, undefined,
    'live codes are an administrator\'s business; anyone holding one can join');

  const asAdmin = await call('GET', `/api/households/${mine.id}`, 'alex@example.com');
  assert.ok(Array.isArray(asAdmin.body.invites));
});

test('a member cannot promote themselves', async () => {
  const mine = registry.forEmail('alex@example.com')[0];
  const nope = await call('PUT', `/api/households/${mine.id}/members/wife@example.com/admin`, 'wife@example.com', { admin: true });
  assert.equal(nope.status, 403);
  assert.equal(registry.isAdmin(mine.id, 'wife@example.com'), false);
});

test('an administrator can promote somebody, who can then invite', async () => {
  const mine = registry.forEmail('alex@example.com')[0];

  const promoted = await call('PUT', `/api/households/${mine.id}/members/wife@example.com/admin`, 'alex@example.com', { admin: true });
  assert.equal(promoted.status, 200);
  assert.ok(promoted.body.household.admins.includes('wife@example.com'));

  const invited = await call('POST', `/api/households/${mine.id}/invites`, 'wife@example.com', {});
  assert.equal(invited.status, 201);
});

/* -------------------------------------------------------------- removing -- */

test('an administrator removes a member, who loses access to the recipes', async () => {
  const mine = registry.forEmail('alex@example.com')[0];

  const gone = await call('DELETE', `/api/households/${mine.id}/members/friend@example.com`, 'alex@example.com');
  assert.equal(gone.status, 200);

  const boot = await call('GET', '/api/bootstrap', 'friend@example.com');
  assert.equal(boot.status, 403);
  assert.equal(boot.body.code, 'NO_HOUSEHOLD');
});

test('an administrator cannot be removed without being demoted first', async () => {
  const mine = registry.forEmail('alex@example.com')[0];
  const nope = await call('DELETE', `/api/households/${mine.id}/members/wife@example.com`, 'alex@example.com');
  assert.equal(nope.status, 409);
  assert.equal(nope.body.code, 'IS_ADMIN');
});

test('removing yourself is sent to the leave door instead', async () => {
  const mine = registry.forEmail('alex@example.com')[0];
  const nope = await call('DELETE', `/api/households/${mine.id}/members/alex@example.com`, 'alex@example.com');
  assert.equal(nope.status, 400);
  assert.equal(nope.body.code, 'USE_LEAVE');
});

test('the last administrator cannot leave people behind', async () => {
  const solo = await call('POST', '/api/households', 'solo@example.com', { name: 'Solo' });
  const id = solo.body.household.id;
  const invite = await call('POST', `/api/households/${id}/invites`, 'solo@example.com', {});
  await call('POST', '/api/households/join', 'tenant@example.com', { code: invite.body.code });

  const nope = await call('POST', `/api/households/${id}/leave`, 'solo@example.com');
  assert.equal(nope.status, 409);
  assert.equal(nope.body.code, 'LAST_ADMIN');

  // Hand over, then go.
  await call('PUT', `/api/households/${id}/members/tenant@example.com/admin`, 'solo@example.com', { admin: true });
  const left = await call('POST', `/api/households/${id}/leave`, 'solo@example.com');
  assert.equal(left.status, 200);
  assert.equal(registry.isMember(id, 'solo@example.com'), false);
});

test('the last person out may simply leave', async () => {
  // Nobody is stranded, so there is nothing to protect against.
  const only = await call('POST', '/api/households', 'lonely@example.com', { name: 'Just Me' });
  const left = await call('POST', `/api/households/${only.body.household.id}/leave`, 'lonely@example.com');
  assert.equal(left.status, 200);
});

/* ------------------------------------------------------------ two houses -- */

test('being in two households keeps their recipes apart', async () => {
  const second = await call('POST', '/api/households', 'wife@example.com', { name: 'Book Club' });
  const secondId = second.body.household.id;

  await realFetch(`${base}/api/recipes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-household': secondId,
      cookie: `CF_Authorization=${assertionFor('wife@example.com')}`,
    },
    body: JSON.stringify({ title: 'Book Club Brownies', category: 'dessert', ingredients: 'cocoa' }),
  });

  const inSecond = await realFetch(`${base}/api/bootstrap`, {
    headers: { 'x-household': secondId, cookie: `CF_Authorization=${assertionFor('wife@example.com')}` },
  }).then((r) => r.json());
  assert.deepEqual(inSecond.recipes.map((r) => r.title), ['Book Club Brownies']);

  const inFirst = await call('GET', '/api/bootstrap', 'wife@example.com');
  assert.equal(inFirst.body.recipes.some((r) => r.title === 'Book Club Brownies'), false,
    'the other household must not see it');
});

test('each household carries its own AnyList account', async () => {
  const mine = registry.forEmail('alex@example.com')[0];
  const both = registry.forEmail('wife@example.com');
  const other = both.find((h) => h.id !== mine.id);

  await realFetch(`${base}/api/anylist/account`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-household': other.id,
      cookie: `CF_Authorization=${assertionFor('wife@example.com')}`,
    },
    body: JSON.stringify({ email: 'bookclub@example.com', password: 'secret' }),
  });

  const theirs = await realFetch(`${base}/api/anylist/account`, {
    headers: { 'x-household': other.id, cookie: `CF_Authorization=${assertionFor('wife@example.com')}` },
  }).then((r) => r.json());
  assert.equal(theirs.email, 'bookclub@example.com');
  assert.equal(theirs.hasPassword, true);

  const ours = await call('GET', '/api/anylist/account', 'alex@example.com');
  assert.equal(ours.body.email, '', 'setting one household\'s account must not touch another\'s');
  assert.equal(ours.body.hasPassword, false);
});

/* ------------------------------------------------------------- unguarded -- */

test('a signed-out request cannot create a household', async () => {
  const res = await call('POST', '/api/households', null, { name: 'Nope' });
  assert.equal(res.status, 401);
});
