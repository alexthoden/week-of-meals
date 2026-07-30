'use strict';

const fs = require('fs');
const path = require('path');

const { Registry } = require('./households');
const { Store } = require('./store');
const { createImages } = require('./images');

/**
 * Where the registry, the databases and the photos live.
 *
 * One file per household rather than one file with the households keyed inside
 * it. The whole-file store is written in full on every save, so a shared file
 * would mean every recipe you add rewrites every other family's data, and one
 * corrupt file would cost all of them their library rather than one of them.
 * Separate files keep the blast radius to a single kitchen, which is the point
 * of the exercise.
 *
 *   data/
 *     households.json          the registry: who is in which household
 *     households/<id>.json     that household's recipes, week, list, settings
 *     households/backups/<id>/ its timestamped copies
 *     images/<id>/             its photos
 *
 * DATA_ROOT relocates the lot, the same way DATA_FILE and IMAGE_DIR used to,
 * so the service can run out of /var/lib/weekofmeals while a developer's
 * checkout uses ./data.
 */

let cached = null;

function rootFor(env) {
  if (env.DATA_ROOT) return env.DATA_ROOT;
  // Honour the old single-tenant variable so an existing deployment's
  // systemd unit keeps pointing at the same disk after an upgrade.
  if (env.DATA_FILE) return path.dirname(env.DATA_FILE);
  return path.join(__dirname, '..', '..', 'data');
}

/**
 * Fold a pre-household installation into household #1.
 *
 * The original layout was a single data/db.json. Rather than reading it in
 * place forever, it is copied to the new location once and the original left
 * behind under a .migrated suffix — a copy, not a move, so a botched upgrade is
 * recoverable by renaming one file back.
 *
 * Runs only when there is no registry yet, so it cannot fire twice.
 */
function migrateSingleTenant({ root, registry, env }) {
  if (registry.all().length) return null;

  const legacy = env.DATA_FILE || path.join(root, 'db.json');
  const members = String(env.ALLOWED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

  const household = registry.create({ name: env.HOUSEHOLD_NAME || 'Home', members });

  if (fs.existsSync(legacy)) {
    const target = path.join(root, 'households', `${household.id}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(legacy, target);
    fs.renameSync(legacy, `${legacy}.migrated`);

    // The photos moved too, and their /images/<name> URLs are unchanged: the
    // name is resolved against the requesting household's directory now.
    const legacyImages = env.IMAGE_DIR || path.join(root, 'images');
    const imageTarget = path.join(root, 'images', household.id);
    if (fs.existsSync(legacyImages) && !fs.existsSync(imageTarget)) {
      fs.mkdirSync(imageTarget, { recursive: true });
      for (const file of fs.readdirSync(legacyImages)) {
        const from = path.join(legacyImages, file);
        if (fs.statSync(from).isFile()) fs.renameSync(from, path.join(imageTarget, file));
      }
    }
  }

  return household;
}

/**
 * Build the registry and a way to reach any household's store.
 * Cached at module scope so a warm process reuses already-loaded databases.
 */
function create(env = process.env) {
  if (cached) return cached;

  const root = rootFor(env);
  const registry = new Registry(path.join(root, 'households.json'));
  migrateSingleTenant({ root, registry, env });

  /* One Store per household, kept for the life of the process. A household's
     database is a few hundred kilobytes and a family has one or two of them,
     so there is nothing here worth evicting. */
  const stores = new Map();

  function forHousehold(id) {
    if (!stores.has(id)) {
      const file = path.join(root, 'households', `${id}.json`);
      const store = new Store(file, { backupDir: path.join(root, 'households', 'backups', id) });
      // The constructor already read the file, and one process owns it.
      store.ready = async () => store.data;
      store.refresh = async () => store.data;

      stores.set(id, {
        store,
        images: createImages(path.join(root, 'images', id)),
      });
    }
    return stores.get(id);
  }

  cached = {
    root, registry, forHousehold, kind: 'file', describe: root,
  };
  return cached;
}

/** Test seam. */
function reset() { cached = null; }

module.exports = { create, reset, rootFor };
