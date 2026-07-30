'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the app at a throwaway database BEFORE requiring it, so these tests
// neither depend on whatever is in data/db.json nor write to it.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-gz-'));
process.env.DATA_FILE = path.join(scratch, 'db.json');
process.env.IMAGE_DIR = path.join(scratch, 'images');

const { app } = require('../server/index');

/*
 * Compression is the kind of change that looks fine and quietly corrupts
 * payloads, so these tests check three separate things:
 *
 *   1. Text actually gets smaller.
 *   2. What comes back out is byte-for-byte what went in. A response that is
 *      90% smaller but subtly wrong is far worse than an uncompressed one.
 *   3. Things that must NOT be compressed are left alone — already-compressed
 *      images and video, and replies too small to be worth the CPU.
 */

let server;
let base;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  // Build enough data that the shopping list is worth compressing. Without a
  // planned week the list is a couple of hundred bytes and correctly falls
  // below the threshold, which would make these assertions depend on seed data.
  const post = (p, body) => fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

  const recipe = await post('/api/recipes', {
    title: 'Compression Fixture Stew',
    servings: '4 servings',
    ingredients: [
      '2 lb beef chuck, cubed', '3 cloves garlic, minced', '1 large onion, diced',
      '4 medium carrots, sliced', '3 stalks celery, chopped', '2 tbsp tomato paste',
      '4 cups beef broth', '1 cup red wine', '2 bay leaves', '1 tsp dried thyme',
      '1.5 lb potatoes, quartered', '2 tbsp olive oil', '1 tsp kosher salt',
      'freshly ground black pepper', '1/4 cup fresh parsley, chopped',
    ].join('\n'),
    steps: 'Brown the beef.\nSoften the vegetables.\nSimmer for two hours.',
  });

  const week = await fetch(`${base}/api/bootstrap`).then((r) => r.json());
  for (const date of week.dates) {
    await post('/api/plan', { date, recipeId: recipe.id });
  }
});

test.after(() => {
  server?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
});

/**
 * Raw request, so we see the bytes as they actually cross the wire.
 *
 * Node's global fetch (undici) transparently decodes content-encoding and gives
 * no way to opt out, which makes it useless for measuring whether compression
 * happened at all — both requests come back the same size. node:http does no
 * decoding, so this measures the real thing.
 */
function raw(path, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${base}${path}`);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'accept-encoding': acceptEncoding },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        body: Buffer.concat(chunks),
        headers: res.headers,
        status: res.statusCode,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Fetch twice: once refusing compression, once accepting it. */
async function bothWays(path, encoding = 'gzip') {
  const plain = await raw(path, 'identity');
  const enc = await raw(path, encoding);
  return {
    plain: plain.body,
    wire: enc.body,
    encoding: enc.headers['content-encoding'] || null,
    vary: enc.headers.vary,
    status: enc.status,
  };
}

/* ------------------------------------------------------------ compresses -- */

test('the javascript bundle is compressed and survives the round trip', async () => {
  const { plain, wire, encoding } = await bothWays('/app.js');
  assert.equal(encoding, 'gzip');
  assert.ok(wire.length < plain.length * 0.6,
    `expected under 60% of ${plain.length} bytes, got ${wire.length}`);
  assert.deepEqual(zlib.gunzipSync(wire), plain, 'decompressed bytes must be identical');
});

test('the stylesheet is compressed and survives the round trip', async () => {
  const { plain, wire, encoding } = await bothWays('/style.css');
  assert.equal(encoding, 'gzip');
  assert.ok(wire.length < plain.length * 0.6);
  assert.deepEqual(zlib.gunzipSync(wire), plain);
});

test('JSON API responses are compressed and still parse', async () => {
  const { plain, wire, encoding } = await bothWays('/api/list');
  assert.ok(plain.length > 1024, `fixture should produce a list over 1 KB, got ${plain.length}`);
  assert.equal(encoding, 'gzip');
  assert.ok(wire.length < plain.length * 0.5,
    `a repetitive JSON list should shrink a lot: ${plain.length} -> ${wire.length}`);
  const decoded = zlib.gunzipSync(wire);
  assert.deepEqual(decoded, plain);
  // And it is still valid JSON, not just matching bytes.
  const parsed = JSON.parse(decoded.toString('utf8'));
  assert.ok(Array.isArray(parsed.items));
});

test('brotli is offered when the client asks for it', async () => {
  const { plain, wire, encoding } = await bothWays('/style.css', 'br');
  assert.equal(encoding, 'br');
  assert.deepEqual(zlib.brotliDecompressSync(wire), plain);
});

test('a client refusing compression gets plain bytes', async () => {
  const res = await raw('/app.js', 'identity');
  assert.equal(res.headers['content-encoding'], undefined);
  assert.ok(res.body.toString('utf8').includes('function'));
});

/* --------------------------------------------------------- leaves alone -- */

test('video is never compressed', async () => {
  // Already-compressed bytes only get bigger, and it wastes CPU on a shared core.
  for (const path of ['/nosleep.mp4', '/nosleep.webm']) {
    const { encoding } = await bothWays(path);
    assert.equal(encoding, null, `${path} should not be compressed`);
  }
});

test('tiny responses fall below the threshold', async () => {
  const { plain, encoding } = await bothWays('/api/healthz');
  assert.ok(plain.length < 1024, 'health check should be small');
  assert.equal(encoding, null, 'under 1 KB is not worth compressing');
});

/* --------------------------------------------------------------- vary --- */

test('compressed responses vary on accept-encoding', async () => {
  // Without this, a shared cache could hand a gzipped body to a client that
  // cannot decode it. Cloudflare sits in front of this app, so it matters.
  const { vary } = await bothWays('/style.css');
  assert.match(String(vary || ''), /accept-encoding/i);
});

test('compression does not disturb status codes', async () => {
  const missing = await raw('/api/recipes/does-not-exist', 'gzip');
  assert.equal(missing.status, 404);
  const text = missing.headers['content-encoding'] === 'gzip'
    ? zlib.gunzipSync(missing.body).toString('utf8')
    : missing.body.toString('utf8');
  assert.ok(JSON.parse(text).error, 'error responses should still be readable JSON');
});
