'use strict';

const crypto = require('crypto');

/**
 * "What are we eating next week?", decided by everybody.
 *
 * A poll asks one question — which of these meals should we have — rather than
 * one question per day. That is the whole design decision, and everything
 * pleasant about this feature follows from it. Seven days times a dozen
 * candidates is eighty-odd decisions on a phone, and a household would abandon
 * it after one round. Families argue about *which meals*, not about which night
 * the chili lands on; the nights are a scheduling problem the administrator can
 * solve in thirty seconds afterwards with the week view that already exists.
 *
 * Voting is by approval: tick everything you would be happy to eat, not one
 * favourite. For a household this beats pick-one outright. It surfaces the meal
 * nobody objects to instead of the one that won two votes to one while a third
 * person quietly dreads it, ties are rare, and it asks the least of each voter.
 *
 * Nobody sees the tally until the poll closes. You can see *that* somebody has
 * voted, so you know who to nudge, but not what they chose — early numbers
 * change late votes, and a household is exactly the place where being seen to
 * be outvoted early sours the whole exercise.
 */

const STATUS = { OPEN: 'open', CLOSED: 'closed' };

const clean = (email) => String(email || '').trim().toLowerCase();

function fail(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d));

/**
 * @param {object} spec
 * @param {string[]} spec.days       the slots being filled, ISO dates
 * @param {string[]|null} spec.candidates  recipe ids, or null for "any recipe"
 */
function create({
  weekOf, days = [], category = 'dinner', candidates = null, createdBy = '', closesAt = '',
}) {
  const slots = [...new Set(days.filter(isDate))].sort();
  if (!slots.length) throw fail('Pick at least one day to plan.', 'NO_DAYS');

  return {
    id: crypto.randomUUID(),
    weekOf,
    days: slots,
    category: String(category || 'dinner').toLowerCase(),
    /* null means every recipe in the household, resolved when the poll is read
       rather than frozen here — a recipe added mid-poll should be votable. A
       shortlist is frozen, because the administrator chose exactly those. */
    candidates: Array.isArray(candidates) && candidates.length ? [...new Set(candidates)] : null,
    createdBy: clean(createdBy),
    createdAt: new Date().toISOString(),
    closesAt: closesAt || '',
    status: STATUS.OPEN,
    ballots: {},
    result: null,
    appliedAt: '',
  };
}

/** How many meals this poll is choosing. Derived, never asked for separately. */
const wanted = (poll) => poll.days.length;

/**
 * The recipes on the ballot, in a stable order.
 *
 * A shortlisted recipe that has since been deleted simply drops out; the poll
 * stays usable rather than carrying a phantom nobody can cook.
 */
function candidatesFor(poll, recipes) {
  if (!poll.candidates) return recipes;
  const byId = new Map(recipes.map((r) => [r.id, r]));
  return poll.candidates.map((id) => byId.get(id)).filter(Boolean);
}

/** Has this person voted at all? An empty ballot still counts as having voted. */
const hasVoted = (poll, email) => Object.hasOwn(poll.ballots, clean(email));

/**
 * Record an approval ballot, replacing any earlier one.
 *
 * Votes stay changeable until the poll closes: somebody who ticks the wrong
 * thing on a phone should be able to fix it without asking an administrator to
 * reopen anything.
 */
function vote(poll, email, approvals, recipes) {
  if (poll.status !== STATUS.OPEN) throw fail('That poll has closed.', 'POLL_CLOSED', 409);

  const who = clean(email);
  if (!who) throw fail('We could not tell who you are.', 'NO_EMAIL', 401);

  // Only ids actually on the ballot, so a stale client cannot vote for a recipe
  // the administrator left out of the shortlist.
  const allowed = new Set(candidatesFor(poll, recipes).map((r) => r.id));
  poll.ballots[who] = [...new Set(
    (Array.isArray(approvals) ? approvals : []).filter((id) => allowed.has(id)),
  )];
  return poll.ballots[who];
}

/**
 * Approvals per candidate, most-approved first.
 *
 * Ties break on the ballot's own order, which is the administrator's shortlist
 * order or the household's recipe order — arbitrary, but *stable*, so the same
 * votes always produce the same ranking and nobody can refresh their way to a
 * different winner.
 */
function tally(poll, recipes) {
  const ballots = Object.entries(poll.ballots);
  return candidatesFor(poll, recipes).map((recipe, index) => {
    const voters = ballots.filter(([, picks]) => picks.includes(recipe.id)).map(([who]) => who);
    return {
      id: recipe.id, title: recipe.title, approvals: voters.length, voters, index,
    };
  }).sort((a, b) => b.approvals - a.approvals || a.index - b.index);
}

/**
 * Close the poll and freeze the winners.
 *
 * The result is stored rather than recomputed, so that editing a recipe or
 * adding a new one afterwards cannot silently rewrite what the household
 * decided. A poll is a record of a decision, not a live query.
 */
function close(poll, recipes) {
  if (poll.status === STATUS.CLOSED) return poll;
  const ranked = tally(poll, recipes);

  poll.status = STATUS.CLOSED;
  poll.closedAt = new Date().toISOString();
  poll.result = ranked.map((r) => ({ id: r.id, title: r.title, approvals: r.approvals }));
  return poll;
}

/** Should this poll have closed by now? Checked on read; no timer to miss. */
const isOverdue = (poll, now = Date.now()) => poll.status === STATUS.OPEN
  && Boolean(poll.closesAt)
  && Date.parse(poll.closesAt) <= now;

/**
 * What the browser is allowed to know.
 *
 * While the poll is open this deliberately carries no counts and nobody else's
 * choices — only who has voted, and your own ballot so the deck can show you
 * what you already said.
 */
function publicView(poll, { email, recipes, members = [] }) {
  const who = clean(email);
  const open = poll.status === STATUS.OPEN;

  return {
    id: poll.id,
    weekOf: poll.weekOf,
    days: poll.days,
    category: poll.category,
    status: poll.status,
    closesAt: poll.closesAt,
    createdBy: poll.createdBy,
    wanted: wanted(poll),
    appliedAt: poll.appliedAt,

    candidates: candidatesFor(poll, recipes).map((r) => ({
      id: r.id, title: r.title, image: r.image || '', time: r.time || '', category: r.category || '',
    })),

    myVote: poll.ballots[who] || null,
    // Names only, never their choices: enough to nudge whoever is holding it up.
    voted: members.filter((m) => hasVoted(poll, m)),
    turnout: { voted: Object.keys(poll.ballots).length, of: members.length },

    // The one thing that appears only after closing.
    result: open ? null : poll.result,
  };
}

module.exports = {
  create, vote, tally, close, candidatesFor, hasVoted, wanted, isOverdue, publicView,
  STATUS,
};
