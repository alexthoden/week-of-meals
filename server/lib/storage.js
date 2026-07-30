'use strict';

const path = require('path');

/**
 * Where the database and photos live.
 *
 * DATA_FILE and IMAGE_DIR let the service run out of /var/lib/weekofmeals on a
 * server while a developer's checkout still uses ./data. Nothing else differs
 * between the two, which is the point: the deployed app is this app.
 */

let cached = null;

/**
 * Build the store and the image storage.
 * Cached at module scope so a warm Lambda reuses the S3 client and, more
 * importantly, the already-loaded database.
 */
function create(env = process.env) {
  if (cached) return cached;

  const { Store } = require('./store'); // eslint-disable-line global-require
  const images = require('./images'); // eslint-disable-line global-require
  const file = env.DATA_FILE || path.join(__dirname, '..', '..', 'data', 'db.json');

  const store = new Store(file);
  // The constructor already read the file, and one process owns it.
  store.ready = async () => store.data;
  store.refresh = async () => store.data;

  cached = { store, images, kind: 'file', describe: file };
  return cached;
}

/** Test seam. */
function reset() { cached = null; }

module.exports = { create, reset };
