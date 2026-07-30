'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

/*
 * The scoping rules, exercised through the real server rather than by calling
 * the resolver directly.
 *
 * This is the layer where a mistake actually leaks data: the middleware order,
 * the fallback when somebody asks for a household they are not in, and what an
 * unrecognised but validly signed sign-in gets. Testing the resolver in
 * isolation would pass while the app served the wrong family's dinner.
 *
 * Cloudflare Access is turned on for these, with genuine RS256 assertions minted
 * against a keypair generated here and a stubbed JWKS endpoint.
 */

const TEAM = 'ourhouse';
const AUD = 'a'.repeat(64);

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'cf-key-1', alg: 'RS256', use: 'sig' };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-routes-'));

process.env.DATA_ROOT = root;
process.env.CF_ACCESS_TEAM = TEAM;
process.env.CF_ACCESS_AUD = AUD;
delete process.env.ALLOWED_EMAILS;
delete process.env.DATA_FILE;
delete process.env.IMAGE_DIR;

// Serve Cloudflare's signing keys from memory; let everything else alone.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).includes('/cdn-cgi/access/certs')) {
    return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
  }
  return realFetch(url, options);
};

// Required after the environment is set: the module builds its storage and its
// auth middleware at import time.
const { app, registry, forHousehold } = require('../server/index');

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function assertionFor(email) {
  const now = Math.floor(Date.now() / 1000);
  const head = { alg: 'RS256', kid: 'cf-key-1', typ: 'JWT' };
  const body = {
    iss: `https://${TEAM}.cloudflareaccess.com`,
    aud: [AUD],
    sub: `sub-${email}`,
    email,
    iat: now,
    exp: now + 3600,
  };
  const input = `${b64(head)}.${b64(body)}`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), privateKey).toString('base64url')}`;
}

/* Two households, and a person who belongs to neither. */
const ours = registry.all()[0];
registry.addMember(ours.id, 'alex@example.com');
registry.addMember(ours.id, 'wife@example.com');
const parents = registry.create({ name: 'Parents', members: ['mom@example.com'] });

forHousehold(ours.id).store.update((d) => d.recipes.push({
  id: 'ours-1', title: 'Our Chili', tags: [], ingredients: ['beans'], steps: [],
}));
forHousehold(parents.id).store.update((d) => d.recipes.push({
  id: 'theirs-1', title: 'Their Pie', tags: [], ingredients: ['apples'], steps: [],
}));

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

function get(url, email, headers = {}) {
  return realFetch(`${base}${url}`, {
    headers: {
      ...(email ? { cookie: `CF_Authorization=${assertionFor(email)}` } : {}),
      ...headers,
    },
  });
}

/* ----------------------------------------------------------- who sees what */

test('a member sees their own household\'s recipes', async () => {
  const res = await get('/api/bootstrap', 'alex@example.com');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.recipes.map((r) => r.title), ['Our Chili']);
});

test('the other household sees only theirs', async () => {
  const res = await get('/api/bootstrap', 'mom@example.com');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.recipes.map((r) => r.title), ['Their Pie']);
});

test('a recipe id from another household is not readable', async () => {
  // The ids are guessable in a way real uuids are not, which is the point:
  // knowing the id must not be enough.
  const res = await get('/api/recipes/theirs-1', 'alex@example.com');
  assert.equal(res.status, 404, 'another household\'s recipe should simply not exist to us');
});

test('asking for a household you are not in does not get you into it', async () => {
  const res = await get(`/api/bootstrap?household=${parents.id}`, 'alex@example.com');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.recipes.map((r) => r.title), ['Our Chili'],
    'the request should fall back to our own household, not honour the id');
});

test('the same is true of the header form', async () => {
  const res = await get('/api/bootstrap', 'alex@example.com', { 'x-household': parents.id });
  const body = await res.json();
  assert.deepEqual(body.recipes.map((r) => r.title), ['Our Chili']);
});

test('a validly signed stranger is told they have no household, not shown one', async () => {
  const res = await get('/api/bootstrap', 'stranger@example.com');
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.code, 'NO_HOUSEHOLD');
  assert.match(body.error, /stranger@example\.com/);
});

test('no assertion at all is still a 401', async () => {
  const res = await get('/api/bootstrap', null);
  assert.equal(res.status, 401);
});

/* --------------------------------------------------------------- whoami -- */

test('whoami answers without a household and names only your own', async () => {
  const res = await get('/api/whoami', 'alex@example.com');
  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.authRequired, true);
  assert.equal(body.user.email, 'alex@example.com');
  assert.deepEqual(body.households.map((h) => h.name), ['Home']);
  assert.equal(body.household.id, ours.id);
});

test('whoami tells a stranger they are in nothing rather than failing', async () => {
  // They are past Access but not in the registry. This is the state the
  // interface needs in order to explain itself, so it must not be a 403.
  const res = await get('/api/whoami', 'stranger@example.com');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.households, []);
  assert.equal(body.household, null);
});

test('somebody in two households is offered both', async () => {
  registry.addMember(parents.id, 'alex@example.com');
  const res = await get('/api/whoami', 'alex@example.com');
  const body = await res.json();
  assert.deepEqual(body.households.map((h) => h.name), ['Home', 'Parents']);

  // And now the explicit pick is honoured, because they really are a member.
  const scoped = await get(`/api/bootstrap?household=${parents.id}`, 'alex@example.com');
  const bootstrap = await scoped.json();
  assert.deepEqual(bootstrap.recipes.map((r) => r.title), ['Their Pie']);

  registry.removeMember(parents.id, 'alex@example.com');
});

/* -------------------------------------------------------------- healthz -- */

test('healthz answers without resolving a household and leaks no recipe counts', async () => {
  const res = await realFetch(`${base}/api/healthz`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.households, 2);
  assert.equal('recipes' in body, false, 'a health probe has no business reading a family\'s data');
});

/* --------------------------------------------------------------- photos -- */

test('a photo is served from the requesting household\'s directory', async () => {
  const { images } = forHousehold(ours.id);
  const url = images.saveDataUrl(`data:image/png;base64,${Buffer.from('ours').toString('base64')}`);
  const name = path.basename(url);

  const mine = await get(`/images/${name}`, 'alex@example.com');
  assert.equal(mine.status, 200);
  assert.equal(await mine.text(), 'ours');

  // Same URL, different household: the name resolves inside their directory,
  // where it does not exist.
  const theirs = await get(`/images/${name}`, 'mom@example.com');
  assert.equal(theirs.status, 404, 'one household must not fetch another\'s photo by URL');
});

test('an authenticated photo is never cacheable by a shared cache', async () => {
  /*
   * The regression that turned per-household photos back into public ones.
   *
   * These were served by express.static with `public, max-age=30d, immutable`.
   * Putting them behind authorisation without changing that header means
   * Cloudflare stores one household's photo at the edge and serves it to the
   * next person who requests that URL — the check below never runs. The
   * isolation reads as correct in the source and is defeated by the CDN.
   */
  const { images } = forHousehold(ours.id);
  const url = images.saveDataUrl(`data:image/png;base64,${Buffer.from('cacheable?').toString('base64')}`);
  const res = await get(url, 'alex@example.com');

  assert.equal(res.status, 200);
  const cc = res.headers.get('cache-control') || '';
  assert.match(cc, /private/, `an authorised response must not be shared-cacheable: ${cc}`);
  assert.doesNotMatch(cc, /public/, `"public" invites Cloudflare to serve this to another household: ${cc}`);
});

test('photos are not public', async () => {
  const { images } = forHousehold(ours.id);
  const url = images.saveDataUrl(`data:image/png;base64,${Buffer.from('secret').toString('base64')}`);

  const res = await realFetch(`${base}${url}`);
  assert.equal(res.status, 401,
    'photos used to be a plain static mount, served to anyone who could reach the port');
});

test('a traversal attempt in a photo name is refused', async () => {
  const res = await get('/images/..%2F..%2Fhouseholds.json', 'alex@example.com');
  assert.ok(res.status === 404 || res.status === 400, `expected a refusal, got ${res.status}`);
});

/* ---------------------------------------------------------------- writes -- */

test('a recipe added by one household does not appear in the other', async () => {
  const res = await realFetch(`${base}/api/recipes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `CF_Authorization=${assertionFor('mom@example.com')}`,
    },
    body: JSON.stringify({ title: 'Their New Cake', category: 'dessert', ingredients: 'flour' }),
  });
  assert.equal(res.status, 201);

  const mine = await (await get('/api/bootstrap', 'alex@example.com')).json();
  assert.deepEqual(mine.recipes.map((r) => r.title), ['Our Chili']);

  const theirs = await (await get('/api/bootstrap', 'mom@example.com')).json();
  assert.deepEqual(theirs.recipes.map((r) => r.title).sort(), ['Their New Cake', 'Their Pie']);
});
