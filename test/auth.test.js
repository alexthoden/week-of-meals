'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  verifyAccessToken, createKeyStore, parseAllowList, isAllowed,
  teamDomain, certsUrl, tokenFrom,
} = require('../server/lib/auth');

/*
 * These mint genuine RS256 assertions against a keypair generated here, so the
 * signature path is exercised for real rather than stubbed. Each rejection test
 * corresponds to a documented way of walking past a JWT check.
 */

const TEAM = 'ourhouse';
const AUD = '9f1c4e2b7a8d6f5e3c1b0a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f';
const ISS = 'https://ourhouse.cloudflareaccess.com';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'cf-key-1', alg: 'RS256', use: 'sig' };
const otherPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function mint(claims = {}, { header = {}, key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = { alg: 'RS256', kid: 'cf-key-1', typ: 'JWT', ...header };
  const body = {
    iss: ISS, aud: [AUD], sub: 'abc123', email: 'cook@example.com',
    iat: now, exp: now + 3600, type: 'app', ...claims,
  };
  const input = `${b64(head)}.${b64(body)}`;
  if (!key) return `${input}.`;
  return `${input}.${crypto.sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}

let fetches = 0;
function store() {
  const ks = createKeyStore({
    team: TEAM,
    fetchImpl: async () => {
      fetches += 1;
      return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
    },
  });
  ks._seed([jwk]);
  return ks;
}

const verify = (token, opts = {}) =>
  verifyAccessToken(token, { team: TEAM, aud: AUD, keyStore: store(), ...opts });

/* --------------------------------------------------------------- config -- */

test('derives the team domain and certs URL', () => {
  assert.equal(teamDomain('ourhouse'), 'ourhouse.cloudflareaccess.com');
  assert.equal(teamDomain('https://ourhouse.cloudflareaccess.com/'), 'ourhouse.cloudflareaccess.com');
  assert.equal(certsUrl('ourhouse'), 'https://ourhouse.cloudflareaccess.com/cdn-cgi/access/certs');
});

/* -------------------------------------------------------------- accepts -- */

test('accepts a properly signed Access assertion', async () => {
  const claims = await verify(mint());
  assert.equal(claims.email, 'cook@example.com');
  assert.equal(claims.sub, 'abc123');
});

test('accepts aud as a bare string as well as an array', async () => {
  assert.ok(await verify(mint({ aud: AUD })));
});

/* -------------------------------------------------------------- rejects -- */

test('rejects alg none, the classic bypass', async () => {
  await assert.rejects(verify(mint({}, { header: { alg: 'none' }, key: null })),
    (e) => e.code === 'BAD_ALG');
});

test('rejects a symmetric algorithm swap', async () => {
  const head = b64({ alg: 'HS256', kid: 'cf-key-1' });
  const body = b64({ iss: ISS, aud: [AUD], email: 'x@y.z', exp: Math.floor(Date.now() / 1000) + 60 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' });
  const sig = crypto.createHmac('sha256', pem).update(`${head}.${body}`).digest('base64url');
  await assert.rejects(verify(`${head}.${body}.${sig}`), (e) => e.code === 'BAD_ALG');
});

test('rejects an assertion signed by the wrong key', async () => {
  await assert.rejects(verify(mint({}, { key: otherPair.privateKey })),
    (e) => e.code === 'BAD_SIGNATURE');
});

test('rejects a tampered payload', async () => {
  const [h, , s] = mint().split('.');
  const forged = b64({ iss: ISS, aud: [AUD], email: 'attacker@evil.com', exp: 9999999999 });
  await assert.rejects(verify(`${h}.${forged}.${s}`), (e) => e.code === 'BAD_SIGNATURE');
});

test('rejects an assertion for a different Access application', async () => {
  await assert.rejects(verify(mint({ aud: ['some-other-app-aud'] })), (e) => e.code === 'BAD_AUD');
});

test('rejects an assertion from another Cloudflare team', async () => {
  await assert.rejects(verify(mint({ iss: 'https://someoneelse.cloudflareaccess.com' })),
    (e) => e.code === 'BAD_ISS');
});

test('rejects an expired assertion', async () => {
  await assert.rejects(verify(mint({ exp: Math.floor(Date.now() / 1000) - 600 })),
    (e) => e.code === 'EXPIRED');
});

test('rejects an assertion with no email claim', async () => {
  await assert.rejects(verify(mint({ email: undefined })), (e) => e.code === 'NO_EMAIL');
});

test('rejects malformed or missing assertions', async () => {
  await assert.rejects(verify('not.a.jwt'), (e) => e.code === 'MALFORMED');
  await assert.rejects(verify('one-part'), (e) => e.code === 'MALFORMED');
  await assert.rejects(verify(''), (e) => e.code === 'NO_TOKEN');
  await assert.rejects(verify(undefined), (e) => e.code === 'NO_TOKEN');
});

test('refuses to verify when the server is misconfigured', async () => {
  await assert.rejects(verifyAccessToken(mint(), { team: '', aud: AUD, keyStore: store() }),
    (e) => e.code === 'NO_TEAM');
  await assert.rejects(verifyAccessToken(mint(), { team: TEAM, aud: '', keyStore: store() }),
    (e) => e.code === 'NO_AUD');
});

/* ------------------------------------------------------------ key store -- */

test('refreshes once for an unknown key id, then refuses it', async () => {
  const before = fetches;
  await assert.rejects(verify(mint({}, { header: { kid: 'rotated-away' } })),
    (e) => e.code === 'BAD_KID');
  assert.equal(fetches, before + 1, 'should re-fetch Cloudflare keys exactly once');
});

test('a known key id is served from cache without a fetch', async () => {
  const before = fetches;
  await verify(mint());
  assert.equal(fetches, before);
});

/* --------------------------------------------------------- header/cookie -- */

test('reads the assertion from the header, then the cookie', () => {
  const req = (headers) => ({ get: (k) => headers[k.toLowerCase()] });
  assert.equal(tokenFrom(req({ 'cf-access-jwt-assertion': 'aaa' })), 'aaa');
  assert.equal(tokenFrom(req({ cookie: 'foo=1; CF_Authorization=bbb; bar=2' })), 'bbb');
  assert.equal(tokenFrom(req({})), '');
});

/* ----------------------------------------------------------- allowlist --- */

test('the optional allowlist matches emails case-insensitively', () => {
  const allow = parseAllowList({ ALLOWED_EMAILS: 'Mum@Example.com, dad@example.com' });
  assert.ok(isAllowed('mum@example.com', allow));
  assert.ok(isAllowed('DAD@EXAMPLE.COM', allow));
  assert.ok(!isAllowed('stranger@example.com', allow));
});

test('the optional allowlist can take a whole domain', () => {
  const allow = parseAllowList({ ALLOWED_DOMAINS: '@ourfamily.com' });
  assert.ok(isAllowed('anyone@ourfamily.com', allow));
  assert.ok(!isAllowed('anyone@elsewhere.com', allow));
});

/* --------------------------------------------------- concurrent refreshes -- */

test('a burst of requests costs exactly one key fetch', async () => {
  /*
   * Photos are authenticated now, so opening a recipe grid fires twenty
   * requests at once. Without single-flighting, every one of them that missed
   * the cache started its own fetch to Cloudflare — twenty simultaneous JWKS
   * requests, which is how you get rate limited or time out. A timeout here
   * surfaces to the browser as a failed sign-in, and the browser reads that as
   * "your session expired".
   */
  let fetches = 0;
  const ks = createKeyStore({
    team: TEAM,
    fetchImpl: async () => {
      fetches += 1;
      await new Promise((r) => setTimeout(r, 20)); // a real fetch is not instant
      return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
    },
  });

  const results = await Promise.all(Array.from({ length: 20 }, () => ks.get('cf-key-1')));

  assert.equal(fetches, 1, `20 concurrent lookups should share one fetch, made ${fetches}`);
  assert.equal(results.length, 20);
  for (const jwkOut of results) assert.equal(jwkOut.kid, 'cf-key-1');
});

test('a failed refresh does not poison the next attempt', async () => {
  // The in-flight promise has to be cleared on failure too, or one blip would
  // hand the same rejection to every later request for the life of the process.
  let attempt = 0;
  const ks = createKeyStore({
    team: TEAM,
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('network went away');
      return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
    },
  });

  await assert.rejects(() => ks.get('cf-key-1'), /network went away/);
  const recovered = await ks.get('cf-key-1');
  assert.equal(recovered.kid, 'cf-key-1', 'the retry should succeed rather than replay the failure');
});
