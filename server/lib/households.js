'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Who shares a kitchen with whom.
 *
 * This is the only global state in the application. Everything else — recipes,
 * the week, the shopping list, the pantry, the AnyList account — belongs to
 * exactly one household and lives in that household's own file. The registry
 * just says which households exist and who is in them.
 *
 * It is kept deliberately tiny for that reason. A corrupt household file costs
 * one family their recipes; a corrupt registry costs everyone the ability to
 * find theirs, so the less that is written here the better.
 *
 * Membership is many-to-many on purpose. Most people are in one household and
 * the interface never mentions the concept to them, but modelling it as a list
 * from the start costs nothing today and saves a data migration on the day
 * somebody wants to help their parents plan a week.
 */

const EMPTY = { version: 1, households: [] };

const clean = (email) => String(email || '').trim().toLowerCase();

class Registry {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(EMPTY);
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Same refusal as the recipe store: never silently overwrite something
        // we failed to understand.
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

  all() {
    return this.data.households;
  }

  byId(id) {
    return this.data.households.find((h) => h.id === id) || null;
  }

  /** Every household this person is in. Empty means they belong nowhere yet. */
  forEmail(email) {
    const who = clean(email);
    if (!who) return [];
    return this.data.households.filter((h) => (h.members || []).some((m) => clean(m) === who));
  }

  create({ name, members = [], id = crypto.randomUUID() } = {}) {
    const household = {
      id,
      name: String(name || 'Home').trim() || 'Home',
      members: [...new Set(members.map(clean).filter(Boolean))],
      createdAt: new Date().toISOString(),
    };
    this.data.households.push(household);
    this.save();
    return household;
  }

  addMember(id, email) {
    const household = this.byId(id);
    if (!household) return null;
    const who = clean(email);
    if (who && !household.members.some((m) => clean(m) === who)) {
      household.members.push(who);
      this.save();
    }
    return household;
  }

  removeMember(id, email) {
    const household = this.byId(id);
    if (!household) return null;
    const who = clean(email);
    const before = household.members.length;
    household.members = household.members.filter((m) => clean(m) !== who);
    if (household.members.length !== before) this.save();
    return household;
  }
}

module.exports = { Registry, EMPTY, clean };
