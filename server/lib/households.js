'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Who shares a kitchen with whom, and who decides.
 *
 * This is the only global state in the application. Everything else — recipes,
 * the week, the shopping list, the pantry, the AnyList account — belongs to
 * exactly one household and lives in that household's own file. The registry
 * just says which households exist, who is in them, and who may let others in.
 *
 * It is kept deliberately tiny for that reason. A corrupt household file costs
 * one family their recipes; a corrupt registry costs everyone the ability to
 * find theirs, so the less that is written here the better.
 *
 * Membership is many-to-many on purpose. Most people are in one household and
 * the interface never mentions the concept to them, but modelling it as a list
 * from the start costs nothing today and saves a data migration on the day
 * somebody wants to help their parents plan a week.
 *
 * Whoever creates a household administers it. There is no server-wide
 * superuser: Cloudflare Access decides who may reach the application at all,
 * and from there each household governs itself. The command line remains as
 * break-glass for the person who owns the machine.
 */

const EMPTY = { version: 2, households: [], invites: [] };

/** How long an unused invite stays good. Long enough to text; short enough. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/*
 * Codes are read off a phone screen and typed by hand, so the alphabet leaves
 * out every pair that looks alike: no O or 0, no I, L or 1, no U next to V.
 * Twenty-eight symbols over eight characters is still far more than anyone
 * could work through against a seven-day expiry.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';
const CODE_LENGTH = 8;

const clean = (email) => String(email || '').trim().toLowerCase();

/** Codes are compared without their dashes or case, so either form works. */
const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Shown as ABCD-EFGH; four characters at a time is what people can hold. */
const formatCode = (code) => {
  const raw = normalizeCode(code);
  return raw.length === CODE_LENGTH ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
};

function newCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

function fail(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

class Registry {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(EMPTY);
    /* True when this run created the file rather than opening an existing one.
       Harmless on a first boot, and the loudest possible hint that a command
       is pointed at the wrong directory. */
    this.created = false;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = { ...structuredClone(EMPTY), ...JSON.parse(raw) };
      if (this.migrate()) this.save();
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Same refusal as the recipe store: never silently overwrite something
        // we failed to understand.
        throw new Error(`Could not read ${this.file}: ${err.message}`);
      }
      this.data = structuredClone(EMPTY);
      this.created = true;
      this.save();
    }
  }

  /**
   * Bring a registry written before households governed themselves up to date.
   *
   * Version 1 had members and no administrators, so nobody could invite anyone
   * and the file would be inert under the new rules. The longest-standing
   * member becomes the administrator — they are the person who was there first
   * and, in a registry seeded from ALLOWED_EMAILS, the one who set the thing up.
   *
   * A household with no members at all gets no administrator, because inventing
   * one would be inventing a person. It stays claimable instead: see `claim`.
   *
   * @returns {boolean} whether anything changed and the file needs writing
   */
  migrate() {
    let changed = false;

    if (!Array.isArray(this.data.invites)) {
      this.data.invites = [];
      changed = true;
    }

    for (const household of this.data.households) {
      if (!Array.isArray(household.members)) {
        household.members = [];
        changed = true;
      }
      if (!Array.isArray(household.admins)) {
        household.admins = household.members.length ? [clean(household.members[0])] : [];
        changed = true;
      }
    }

    if (this.data.version !== EMPTY.version) {
      this.data.version = EMPTY.version;
      changed = true;
    }

    return changed;
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

  isMember(id, email) {
    const household = this.byId(id);
    if (!household) return false;
    const who = clean(email);
    return (household.members || []).some((m) => clean(m) === who);
  }

  isAdmin(id, email) {
    const household = this.byId(id);
    if (!household) return false;
    const who = clean(email);
    return (household.admins || []).some((a) => clean(a) === who);
  }

  create({
    name, members = [], admins = [], createdBy = '', id = crypto.randomUUID(),
  } = {}) {
    const memberList = [...new Set(members.map(clean).filter(Boolean))];
    const owner = clean(createdBy);
    if (owner && !memberList.includes(owner)) memberList.unshift(owner);

    /* Whoever created it administers it. Falling back to the first member keeps
       the command line — which creates households on behalf of somebody else —
       from producing one that nobody can administer. */
    const adminList = [...new Set([
      ...(owner ? [owner] : []),
      ...admins.map(clean).filter(Boolean),
    ])].filter((a) => memberList.includes(a));

    const household = {
      id,
      name: String(name || 'Home').trim() || 'Home',
      members: memberList,
      admins: adminList.length ? adminList : memberList.slice(0, 1),
      createdBy: owner,
      createdAt: new Date().toISOString(),
    };
    this.data.households.push(household);
    this.save();
    return household;
  }

  addMember(id, email, { admin = false } = {}) {
    const household = this.byId(id);
    if (!household) return null;
    const who = clean(email);
    if (!who) return household;

    if (!household.members.some((m) => clean(m) === who)) household.members.push(who);
    if (admin && !household.admins.some((a) => clean(a) === who)) household.admins.push(who);
    this.save();
    return household;
  }

  removeMember(id, email) {
    const household = this.byId(id);
    if (!household) return null;
    const who = clean(email);
    const before = household.members.length + household.admins.length;
    household.members = household.members.filter((m) => clean(m) !== who);
    household.admins = household.admins.filter((a) => clean(a) !== who);
    if (household.members.length + household.admins.length !== before) this.save();
    return household;
  }

  /**
   * Promote or demote, refusing to leave a household with nobody in charge.
   *
   * A household whose last administrator steps down cannot invite, cannot
   * remove anyone and cannot be renamed — it is not locked in any dramatic
   * sense, but nothing about it can change again without the command line. That
   * is a state to refuse rather than to allow and explain afterwards.
   */
  setAdmin(id, email, isAdmin) {
    const household = this.byId(id);
    if (!household) throw fail('That household is gone.', 'NO_HOUSEHOLD', 404);
    const who = clean(email);

    if (isAdmin) {
      if (!household.members.some((m) => clean(m) === who)) {
        throw fail('That person is not in this household.', 'NOT_A_MEMBER', 404);
      }
      if (!household.admins.some((a) => clean(a) === who)) household.admins.push(who);
    } else {
      const remaining = household.admins.filter((a) => clean(a) !== who);
      if (!remaining.length) {
        throw fail(
          'Somebody has to be able to administer this household. Make someone else '
          + 'an administrator first.',
          'LAST_ADMIN',
          409,
        );
      }
      household.admins = remaining;
    }

    this.save();
    return household;
  }

  /**
   * Take charge of a household that has nobody in charge.
   *
   * Only possible when there are no administrators at all — which happens to a
   * registry migrated from before this existed whose members list was empty, and
   * to a household whose last administrator was removed from outside. An
   * existing member claiming it is not a privilege escalation so much as
   * somebody turning the lights on in a room they are already standing in.
   */
  claim(id, email) {
    const household = this.byId(id);
    if (!household) throw fail('That household is gone.', 'NO_HOUSEHOLD', 404);
    if (household.admins.length) {
      throw fail('That household already has an administrator.', 'HAS_ADMIN', 409);
    }
    const who = clean(email);
    if (!household.members.some((m) => clean(m) === who)) {
      throw fail('Only a member can take charge of a household.', 'NOT_A_MEMBER', 403);
    }
    household.admins = [who];
    this.save();
    return household;
  }

  /* ------------------------------------------------------------- invites -- */

  /**
   * An invitation to one household, good once.
   *
   * Optionally bound to an address: an unbound code works for whoever types it,
   * which is what you want when texting it to your wife, while a bound one is
   * useless to anyone else if the message goes astray. Both expire.
   */
  createInvite({
    householdId, createdBy, email = '', ttlMs = INVITE_TTL_MS,
  }) {
    const household = this.byId(householdId);
    if (!household) throw fail('That household is gone.', 'NO_HOUSEHOLD', 404);

    let code = newCode();
    while (this.data.invites.some((i) => i.code === code)) code = newCode();

    const invite = {
      code,
      householdId,
      createdBy: clean(createdBy),
      email: clean(email),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      usedBy: '',
      usedAt: '',
    };
    this.data.invites.push(invite);
    this.pruneInvites();
    this.save();
    return invite;
  }

  findInvite(code) {
    const wanted = normalizeCode(code);
    if (!wanted) return null;
    return this.data.invites.find((i) => i.code === wanted) || null;
  }

  /** Live invitations for a household: not used, not expired. */
  invitesFor(householdId, now = Date.now()) {
    return this.data.invites.filter((i) => i.householdId === householdId
      && !i.usedBy
      && Date.parse(i.expiresAt) > now);
  }

  revokeInvite(code) {
    const wanted = normalizeCode(code);
    const before = this.data.invites.length;
    this.data.invites = this.data.invites.filter((i) => i.code !== wanted);
    if (this.data.invites.length !== before) this.save();
    return before !== this.data.invites.length;
  }

  /**
   * Spend an invitation.
   *
   * Every refusal says which rule it broke, because "that code did not work"
   * sends a person hunting for a typo when the real answer is that they used it
   * yesterday. The one exception is an unknown code, which is deliberately
   * indistinguishable from a wrong one.
   */
  redeemInvite(code, email, now = Date.now()) {
    const who = clean(email);
    if (!who) throw fail('We could not tell who you are.', 'NO_EMAIL', 401);

    const invite = this.findInvite(code);
    if (!invite) throw fail('That invite code is not valid.', 'BAD_CODE', 404);
    if (invite.usedBy) throw fail('That invite code has already been used.', 'CODE_USED', 409);
    if (Date.parse(invite.expiresAt) <= now) {
      throw fail('That invite code has expired. Ask for a new one.', 'CODE_EXPIRED', 409);
    }
    if (invite.email && invite.email !== who) {
      throw fail(`That invite was issued for ${invite.email}.`, 'CODE_NOT_YOURS', 403);
    }

    const household = this.byId(invite.householdId);
    if (!household) throw fail('The household that invite belongs to is gone.', 'NO_HOUSEHOLD', 404);

    if (!household.members.some((m) => clean(m) === who)) household.members.push(who);
    invite.usedBy = who;
    invite.usedAt = new Date(now).toISOString();

    this.pruneInvites(now);
    this.save();
    return household;
  }

  /**
   * Forget invitations nobody can use any more, so the file stays small.
   *
   * Both kinds are kept for a while past the point of being usable, and that is
   * the whole point: a code deleted the moment it expires comes back as "that
   * code is not valid", which sends somebody hunting for a typo they did not
   * make. Keeping the record lets the refusal say "that expired, ask for a new
   * one" — the difference between a dead end and an instruction.
   */
  pruneInvites(now = Date.now()) {
    const keepExpiredFor = 7 * 24 * 60 * 60 * 1000;
    const keepUsedFor = 30 * 24 * 60 * 60 * 1000; // a short audit trail
    this.data.invites = this.data.invites.filter((i) => {
      if (i.usedBy) return Date.parse(i.usedAt || i.createdAt) + keepUsedFor > now;
      return Date.parse(i.expiresAt) + keepExpiredFor > now;
    });
  }

  rename(id, name) {
    const household = this.byId(id);
    if (!household) throw fail('That household is gone.', 'NO_HOUSEHOLD', 404);
    const next = String(name || '').trim();
    if (!next) throw fail('Give the household a name.', 'NO_NAME');
    household.name = next.slice(0, 60);
    this.save();
    return household;
  }
}

module.exports = {
  Registry,
  EMPTY,
  clean,
  normalizeCode,
  formatCode,
  INVITE_TTL_MS,
  CODE_LENGTH,
};
