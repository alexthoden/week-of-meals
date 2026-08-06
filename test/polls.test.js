'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const polls = require('../server/lib/polls');

/*
 * Approval voting, and the two properties that make it trustworthy: nobody can
 * see the tally while the vote is open, and the same ballots always produce the
 * same ranking.
 */

const RECIPES = [
  { id: 'chili', title: 'Chili', image: '', time: '45 min' },
  { id: 'pasta', title: 'Pasta', image: '', time: '25 min' },
  { id: 'tacos', title: 'Tacos', image: '', time: '35 min' },
  { id: 'soup', title: 'Soup', image: '', time: '30 min' },
];

const DAYS = ['2026-08-03', '2026-08-04', '2026-08-05'];

const newPoll = (over = {}) => polls.create({
  weekOf: '2026-08-03', days: DAYS, createdBy: 'alex@example.com', ...over,
});

/* ---------------------------------------------------------------- shape -- */

test('how many meals is derived from the days, never asked separately', () => {
  assert.equal(polls.wanted(newPoll()), 3);
  assert.equal(polls.wanted(newPoll({ days: ['2026-08-03'] })), 1);
});

test('a poll with no days is refused', () => {
  assert.throws(() => newPoll({ days: [] }), /at least one day/);
  assert.throws(() => newPoll({ days: ['not-a-date'] }), /at least one day/);
});

test('days are deduplicated and ordered, whatever order they arrive in', () => {
  const poll = newPoll({ days: ['2026-08-05', '2026-08-03', '2026-08-05'] });
  assert.deepEqual(poll.days, ['2026-08-03', '2026-08-05']);
});

test('no shortlist means every recipe, resolved when read', () => {
  // A recipe added after the poll opened should still be votable.
  const poll = newPoll();
  assert.equal(poll.candidates, null);
  assert.deepEqual(polls.candidatesFor(poll, RECIPES).map((r) => r.id),
    ['chili', 'pasta', 'tacos', 'soup']);

  const later = [...RECIPES, { id: 'pie', title: 'Pie' }];
  assert.equal(polls.candidatesFor(poll, later).length, 5);
});

test('a shortlist is frozen, and keeps the order the admin chose', () => {
  const poll = newPoll({ candidates: ['tacos', 'chili'] });
  assert.deepEqual(polls.candidatesFor(poll, RECIPES).map((r) => r.id), ['tacos', 'chili']);
});

test('a shortlisted recipe that gets deleted simply drops off the ballot', () => {
  const poll = newPoll({ candidates: ['tacos', 'gone', 'chili'] });
  assert.deepEqual(polls.candidatesFor(poll, RECIPES).map((r) => r.id), ['tacos', 'chili']);
});

/* ---------------------------------------------------------------- voting -- */

test('an approval ballot records everything ticked', () => {
  const poll = newPoll();
  polls.vote(poll, 'alex@example.com', ['chili', 'tacos'], RECIPES);
  assert.deepEqual(poll.ballots['alex@example.com'], ['chili', 'tacos']);
});

test('voting again replaces the earlier ballot rather than adding to it', () => {
  // Somebody who mis-taps on a phone must be able to fix it themselves.
  const poll = newPoll();
  polls.vote(poll, 'alex@example.com', ['chili'], RECIPES);
  polls.vote(poll, 'alex@example.com', ['pasta', 'soup'], RECIPES);
  assert.deepEqual(poll.ballots['alex@example.com'], ['pasta', 'soup']);
});

test('a vote for something not on the ballot is discarded, not honoured', () => {
  // A stale page must not be able to vote for a recipe the admin left out.
  const poll = newPoll({ candidates: ['chili', 'pasta'] });
  polls.vote(poll, 'alex@example.com', ['chili', 'tacos', 'nonsense'], RECIPES);
  assert.deepEqual(poll.ballots['alex@example.com'], ['chili']);
});

test('an empty ballot still counts as having voted', () => {
  // "None of these" is an answer, and the household should not keep waiting.
  const poll = newPoll();
  polls.vote(poll, 'alex@example.com', [], RECIPES);
  assert.equal(polls.hasVoted(poll, 'alex@example.com'), true);
  assert.deepEqual(poll.ballots['alex@example.com'], []);
});

test('email case does not create a second ballot', () => {
  const poll = newPoll();
  polls.vote(poll, 'Alex@Example.com', ['chili'], RECIPES);
  polls.vote(poll, 'alex@example.com', ['pasta'], RECIPES);
  assert.equal(Object.keys(poll.ballots).length, 1);
});

test('a closed poll takes no more votes', () => {
  const poll = newPoll();
  polls.close(poll, RECIPES);
  assert.throws(() => polls.vote(poll, 'late@example.com', ['chili'], RECIPES), /has closed/);
});

/* --------------------------------------------------------------- tallying */

test('the most-approved meal wins, not the one with the loudest fan', () => {
  /*
   * The case approval voting exists for. Under pick-one, Chili wins 2-1-1 while
   * two of the three people would rather eat almost anything else. Under
   * approval, Pasta wins because everybody is happy with it.
   */
  const poll = newPoll();
  polls.vote(poll, 'a@example.com', ['chili', 'pasta'], RECIPES);
  polls.vote(poll, 'b@example.com', ['pasta', 'tacos'], RECIPES);
  polls.vote(poll, 'c@example.com', ['pasta', 'soup'], RECIPES);

  const ranked = polls.tally(poll, RECIPES);
  assert.equal(ranked[0].id, 'pasta');
  assert.equal(ranked[0].approvals, 3);
});

test('ties break on ballot order, so the ranking never changes under you', () => {
  const poll = newPoll();
  polls.vote(poll, 'a@example.com', ['chili', 'pasta', 'tacos', 'soup'], RECIPES);

  const once = polls.tally(poll, RECIPES).map((r) => r.id);
  const twice = polls.tally(poll, RECIPES).map((r) => r.id);
  assert.deepEqual(once, twice, 'refreshing must not shuffle a four-way tie');
  assert.deepEqual(once, ['chili', 'pasta', 'tacos', 'soup'], 'ballot order is the tie-break');
});

test('a recipe nobody approved still appears, on zero', () => {
  const poll = newPoll();
  polls.vote(poll, 'a@example.com', ['chili'], RECIPES);
  const ranked = polls.tally(poll, RECIPES);
  assert.equal(ranked.length, 4);
  assert.equal(ranked.at(-1).approvals, 0);
});

/* --------------------------------------------------------------- closing -- */

test('closing freezes the result so later edits cannot rewrite it', () => {
  const poll = newPoll();
  polls.vote(poll, 'a@example.com', ['chili'], RECIPES);
  polls.close(poll, RECIPES);

  // Somebody renames a recipe and adds another afterwards.
  const later = [{ id: 'chili', title: 'Renamed' }, ...RECIPES.slice(1), { id: 'new', title: 'New' }];
  assert.equal(poll.result[0].title, 'Chili', 'a poll is a record of a decision, not a live query');
  assert.equal(poll.result.length, 4);
  assert.equal(polls.candidatesFor(poll, later).length, 5, 'though the ballot itself still resolves');
});

test('closing twice is harmless', () => {
  const poll = newPoll();
  polls.vote(poll, 'a@example.com', ['chili'], RECIPES);
  polls.close(poll, RECIPES);
  const first = poll.closedAt;
  polls.close(poll, RECIPES);
  assert.equal(poll.closedAt, first);
});

test('a deadline in the past marks the poll overdue, but only while open', () => {
  const poll = newPoll({ closesAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(polls.isOverdue(poll), true);

  polls.close(poll, RECIPES);
  assert.equal(polls.isOverdue(poll), false);

  assert.equal(polls.isOverdue(newPoll()), false, 'no deadline is never overdue');
});

/* ------------------------------------------------------------ visibility -- */

test('an open poll gives away no tally and nobody else\'s choices', () => {
  /*
   * The property that makes the vote worth trusting. Early numbers change late
   * votes, and in a household being seen to be outvoted early sours it.
   */
  const poll = newPoll();
  polls.vote(poll, 'a@example.com', ['chili', 'pasta'], RECIPES);
  polls.vote(poll, 'b@example.com', ['soup'], RECIPES);

  const seen = polls.publicView(poll, {
    email: 'a@example.com', recipes: RECIPES, members: ['a@example.com', 'b@example.com', 'c@example.com'],
  });

  assert.equal(seen.result, null, 'no ranking while open');

  /* Soup is on the ballot, so of course it appears — what must not appear is
     any trace of who picked it. Walk the whole payload for the keys that would
     carry that. */
  const keys = new Set();
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) { keys.add(k); walk(v); }
  }(seen));

  for (const leak of ['ballots', 'voters', 'approvals']) {
    assert.equal(keys.has(leak), false, `"${leak}" must not reach the browser while voting is open`);
  }

  // What you are allowed to know: your own ballot, and who is holding it up.
  assert.deepEqual(seen.myVote, ['chili', 'pasta']);
  assert.deepEqual(seen.voted, ['a@example.com', 'b@example.com']);
  assert.deepEqual(seen.turnout, { voted: 2, of: 3 });
});

test('closing reveals the ranking to everyone', () => {
  const poll = newPoll();
  polls.vote(poll, 'a@example.com', ['chili'], RECIPES);
  polls.close(poll, RECIPES);

  const seen = polls.publicView(poll, { email: 'b@example.com', recipes: RECIPES, members: ['a@example.com'] });
  assert.equal(seen.result[0].title, 'Chili');
  assert.equal(seen.result[0].approvals, 1);
});

test('somebody who has not voted sees a null ballot, not an empty one', () => {
  // The difference between "I passed on everything" and "I have not looked".
  const poll = newPoll();
  polls.vote(poll, 'a@example.com', [], RECIPES);

  const voter = polls.publicView(poll, { email: 'a@example.com', recipes: RECIPES, members: [] });
  const absent = polls.publicView(poll, { email: 'b@example.com', recipes: RECIPES, members: [] });
  assert.deepEqual(voter.myVote, []);
  assert.equal(absent.myVote, null);
});
