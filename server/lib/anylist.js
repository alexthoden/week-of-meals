'use strict';

const path = require('path');
const AnyList = require('anylist');

/**
 * Thin wrapper around the unofficial AnyList client.
 *
 * Things worth knowing, because they shaped this file:
 *
 *  - There is no public AnyList API. This library is reverse engineered, so it
 *    can break whenever AnyList ships an app update. Every call here is wrapped
 *    and every failure is reported to the browser as a plain sentence, and the
 *    shopping list always stays copyable so a broken export is an annoyance
 *    rather than a dead end.
 *  - Auth is your real AnyList email and password. They are read from the
 *    environment, never written to the database, and never sent to the browser.
 *  - Sessions are reused. Logging in on every export is slow and rude to their
 *    servers, so one client is kept alive and re-authenticated only on failure.
 */

const CREDENTIALS_FILE = process.env.ANYLIST_CREDENTIALS_FILE
  || path.join(__dirname, '..', '..', 'data', '.anylist_credentials');

let client = null;
let loggingIn = null;

function configured() {
  return Boolean(process.env.ANYLIST_EMAIL && process.env.ANYLIST_PASSWORD);
}

async function connect() {
  if (!configured()) {
    const err = new Error('AnyList is not set up. Add ANYLIST_EMAIL and ANYLIST_PASSWORD to your .env file and restart.');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  if (client) return client;
  if (loggingIn) return loggingIn;

  loggingIn = (async () => {
    const next = new AnyList({
      email: process.env.ANYLIST_EMAIL,
      password: process.env.ANYLIST_PASSWORD,
      credentialsFile: CREDENTIALS_FILE,
    });
    // No websocket: this process only pushes items, it never needs live updates.
    await next.login(false);
    client = next;
    loggingIn = null;
    return client;
  })();

  try {
    return await loggingIn;
  } catch (err) {
    loggingIn = null;
    client = null;
    if (/password|credential|401|unauthor/i.test(err.message || '')) {
      const e = new Error('AnyList rejected the login. Check ANYLIST_EMAIL and ANYLIST_PASSWORD.');
      e.code = 'BAD_CREDENTIALS';
      throw e;
    }
    const e = new Error(`Could not reach AnyList: ${err.message}`);
    e.code = 'UNREACHABLE';
    throw e;
  }
}

/** Drop the session so the next call logs in fresh. */
function reset() {
  try { client?.teardown(); } catch { /* already gone */ }
  client = null;
  loggingIn = null;
}

async function withRetry(fn) {
  try {
    return await fn(await connect());
  } catch (err) {
    if (err.code === 'NOT_CONFIGURED' || err.code === 'BAD_CREDENTIALS') throw err;
    reset();
    return fn(await connect());
  }
}

async function listNames() {
  return withRetry(async (any) => {
    const lists = await any.getLists();
    return lists.map((l) => l.name);
  });
}

/**
 * Push items onto a list.
 *
 * @param {string} listName
 * @param {Array} items  [{name, quantity, details}]
 * @param {object} opts  {skipExisting: true}
 * @returns {{added: string[], skipped: string[], listName: string}}
 */
async function addItems(listName, items, opts = {}) {
  const skipExisting = opts.skipExisting !== false;

  return withRetry(async (any) => {
    await any.getLists();
    const list = any.getListByName(listName);
    if (!list) {
      const err = new Error(`No AnyList list named "${listName}".`);
      err.code = 'NO_SUCH_LIST';
      throw err;
    }

    // Match on name only, the way a person scanning the list would.
    const present = new Set(
      (list.items || [])
        .filter((i) => !i.checked)
        .map((i) => String(i.name || '').trim().toLowerCase()),
    );

    const added = [];
    const skipped = [];

    for (const entry of items) {
      const name = String(entry.name || '').trim();
      if (!name) continue;

      if (skipExisting && present.has(name.toLowerCase())) {
        skipped.push(name);
        continue;
      }

      const item = any.createItem({
        name,
        quantity: entry.quantity ? String(entry.quantity) : '',
        details: entry.details ? String(entry.details) : '',
      });

      // Sequential on purpose: the endpoint is undocumented and a burst of
      // parallel writes is the fastest way to find out how it rate limits.
      await list.addItem(item);
      present.add(name.toLowerCase());
      added.push(name);
    }

    return { added, skipped, listName };
  });
}

module.exports = { configured, listNames, addItems, reset, CREDENTIALS_FILE };
