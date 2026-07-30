'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Everything lives in one JSON file.
 *
 * A household plans a few dozen recipes and one week at a time, so a database
 * would be ceremony. A flat file is readable, greppable, trivially backed up
 * with `cp`, and survives every Node upgrade without a native rebuild.
 * Writes are atomic (temp file + rename) so a crash mid-save can't shred it.
 */

const EMPTY = {
  version: 1,
  recipes: [],
  plan: {},      // ISO date -> [{id, recipeId, scale}]
  checked: {},   // week start -> {itemKey: bool}
  exports: [],   // {id, at, weekOf, listName, keys: [], count}
  settings: {
    listName: '',
    startOfWeek: 1,
    // Canonical ingredient keys you keep in the house. Kept off the shopping
    // list by default, every week, until you say otherwise. Unlike `checked`
    // (which is per-week) this is a standing statement about your kitchen.
    pantry: [],
  },
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Refuse to start on a corrupt file rather than silently overwriting it.
        throw new Error(`Could not read ${this.file}: ${err.message}`);
      }
      this.data = structuredClone(EMPTY);
      this.save();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  update(fn) {
    const result = fn(this.data);
    this.save();
    return result;
  }

  /** Timestamped copy, kept to the last 10. Cheap insurance. */
  backup() {
    const dir = path.join(path.dirname(this.file), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(this.file, path.join(dir, `db-${stamp}.json`));
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('db-')).sort();
    for (const old of files.slice(0, -10)) fs.unlinkSync(path.join(dir, old));
  }
}

module.exports = { Store, EMPTY };
