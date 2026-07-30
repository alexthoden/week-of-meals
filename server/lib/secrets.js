'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Encryption at rest for the one genuinely secret thing this app stores.
 *
 * AnyList has no OAuth, no API tokens and no app passwords. The only way to
 * push a shopping list is your real account password, and with households that
 * password now belongs to a family who is not you. Keeping somebody else's
 * password in plaintext in a JSON file — one that gets tarred into nightly
 * backups and copied off the box by rclone — is not acceptable, so it is
 * encrypted before it is written and the backups carry ciphertext.
 *
 * What this does and does not protect against, stated plainly, because
 * encryption that is not understood is worse than none:
 *
 *   - It DOES protect the database file and every backup of it. A stolen
 *     archive, a misconfigured bucket or a stale off-box copy yields nothing
 *     without the key, which is not in the archive.
 *   - It does NOT protect against someone who already has root on the running
 *     server. The process must be able to decrypt to log in, so the key is
 *     reachable to anyone who can read the key file or the environment. There
 *     is no way around that for a credential the server has to use unattended.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt rather
 * than silently yielding a different password.
 */

const VERSION = 'v1';

/**
 * The key, in order of preference:
 *
 *   1. SECRET_KEY in the environment — 64 hex characters. Best on a server,
 *      where systemd already has an EnvironmentFile with mode 0640.
 *   2. A generated key file beside the data, mode 0600. Written once, so a
 *      laptop checkout works with no setup and still does not keep the
 *      password in the clear.
 *
 * Losing the key means losing the stored AnyList passwords. Nothing else, and
 * they can simply be typed in again, which is why generating one automatically
 * is a reasonable default rather than a trap.
 */
function loadKey(root, env = process.env) {
  const fromEnv = String(env.SECRET_KEY || '').trim();
  if (fromEnv) {
    const key = Buffer.from(fromEnv, 'hex');
    if (key.length !== 32) {
      throw new Error('SECRET_KEY must be 64 hex characters (32 bytes). Generate one with: openssl rand -hex 32');
    }
    return key;
  }

  const file = path.join(root, 'secret.key');
  try {
    const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    if (key.length === 32) return key;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const key = crypto.randomBytes(32);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, key.toString('hex'), { mode: 0o600 });
  return key;
}

function createSecrets(root, env = process.env) {
  let key = null;
  const getKey = () => {
    if (!key) key = loadKey(root, env);
    return key;
  };

  /** @returns {string} "v1:<iv>:<tag>:<ciphertext>", all base64 */
  function encrypt(plaintext) {
    const text = String(plaintext ?? '');
    if (!text) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return [
      VERSION,
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      body.toString('base64'),
    ].join(':');
  }

  /**
   * Returns '' rather than throwing when the blob cannot be read.
   *
   * A rotated or lost key must not make the app unbootable: the effect of an
   * unreadable credential is that AnyList export asks to be set up again, which
   * is recoverable in ten seconds. Throwing here would take the whole household
   * down over a feature they might not even use.
   */
  function decrypt(blob) {
    const raw = String(blob || '');
    if (!raw) return '';
    const parts = raw.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) return '';
    try {
      const [, iv, tag, body] = parts;
      const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(body, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return '';
    }
  }

  /** True when this looks like something we wrote, rather than a raw password. */
  const isEncrypted = (blob) => String(blob || '').startsWith(`${VERSION}:`);

  return { encrypt, decrypt, isEncrypted };
}

module.exports = { createSecrets, loadKey, VERSION };
