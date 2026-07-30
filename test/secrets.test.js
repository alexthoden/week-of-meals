'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSecrets, loadKey, VERSION } = require('../server/lib/secrets');

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wom-secrets-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const KEY = crypto.randomBytes(32).toString('hex');

test('a password survives the round trip', () => {
  const s = createSecrets(tmp(), { SECRET_KEY: KEY });
  for (const secret of ['hunter2', 'a', 'ünïcødé and spaces', '"quotes" & <angles>', 'x'.repeat(500)]) {
    assert.equal(s.decrypt(s.encrypt(secret)), secret);
  }
});

test('the ciphertext does not contain the password', () => {
  const s = createSecrets(tmp(), { SECRET_KEY: KEY });
  const blob = s.encrypt('correct-horse-battery-staple');

  assert.ok(!blob.includes('correct'), 'the whole point is that a backup leaks nothing');
  assert.ok(!Buffer.from(blob).includes(Buffer.from('correct-horse')));
  assert.match(blob, new RegExp(`^${VERSION}:`));
});

test('encrypting the same password twice gives different ciphertext', () => {
  // A fresh IV each time, so identical passwords are not visibly identical on
  // disk and a backup does not reveal that two households share an account.
  const s = createSecrets(tmp(), { SECRET_KEY: KEY });
  assert.notEqual(s.encrypt('same'), s.encrypt('same'));
});

test('an empty password stays empty rather than becoming ciphertext', () => {
  const s = createSecrets(tmp(), { SECRET_KEY: KEY });
  assert.equal(s.encrypt(''), '');
  assert.equal(s.encrypt(null), '');
  assert.equal(s.decrypt(''), '');
  assert.equal(s.decrypt(undefined), '');
});

test('a tampered ciphertext does not decrypt to anything', () => {
  // GCM is authenticated: flipping a byte must fail, not yield a different
  // password that then gets sent to AnyList.
  const s = createSecrets(tmp(), { SECRET_KEY: KEY });
  const parts = s.encrypt('hunter2').split(':');
  const body = Buffer.from(parts[3], 'base64');
  body[0] ^= 0xff;
  parts[3] = body.toString('base64');

  assert.equal(s.decrypt(parts.join(':')), '');
});

test('another key cannot read it', () => {
  const dirA = tmp();
  const dirB = tmp();
  const a = createSecrets(dirA, { SECRET_KEY: crypto.randomBytes(32).toString('hex') });
  const b = createSecrets(dirB, { SECRET_KEY: crypto.randomBytes(32).toString('hex') });

  assert.equal(b.decrypt(a.encrypt('hunter2')), '');
});

test('a lost key disables export rather than crashing the app', () => {
  // Deliberate: an unreadable credential should mean "set AnyList up again",
  // not "this household cannot load".
  const s = createSecrets(tmp(), { SECRET_KEY: KEY });
  assert.doesNotThrow(() => s.decrypt('v1:garbage:garbage:garbage'));
  assert.equal(s.decrypt('v1:garbage:garbage:garbage'), '');
  assert.equal(s.decrypt('not-even-close'), '');
  assert.equal(s.decrypt('v9:a:b:c'), '', 'an unknown version is refused, not guessed at');
});

test('isEncrypted tells a stored blob from a raw password', () => {
  const s = createSecrets(tmp(), { SECRET_KEY: KEY });
  assert.equal(s.isEncrypted(s.encrypt('hunter2')), true);
  assert.equal(s.isEncrypted('hunter2'), false);
  assert.equal(s.isEncrypted(''), false);
});

/* ------------------------------------------------------------------ key -- */

test('a key file is generated once and reused', () => {
  const dir = tmp();
  const first = loadKey(dir, {});
  const second = loadKey(dir, {});

  assert.equal(first.length, 32);
  assert.deepEqual(first, second, 'a new key each boot would orphan yesterday\'s password');
});

test('the generated key file is not readable by anyone else', () => {
  const dir = tmp();
  loadKey(dir, {});
  const mode = fs.statSync(path.join(dir, 'secret.key')).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('SECRET_KEY from the environment wins over the file', () => {
  const dir = tmp();
  loadKey(dir, {}); // generate a file first
  assert.deepEqual(loadKey(dir, { SECRET_KEY: KEY }), Buffer.from(KEY, 'hex'));
});

test('a malformed SECRET_KEY is refused with an instruction', () => {
  assert.throws(() => loadKey(tmp(), { SECRET_KEY: 'too-short' }), /64 hex characters/);
  assert.throws(() => loadKey(tmp(), { SECRET_KEY: 'ab'.repeat(20) }), /openssl rand -hex 32/);
});
