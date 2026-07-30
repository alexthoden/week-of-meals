'use strict';

const storage = require('./lib/storage');

/**
 * Manage households from the command line.
 *
 * Membership is deliberately not editable through the web interface — there is
 * no invite flow, no join codes and no admin screen, because for two families
 * that is a great deal of surface area for something that changes about once a
 * year. It is a file on the server.
 *
 * This exists because that file is JSON, and hand-editing JSON over SSH at
 * eleven at night is exactly how you end up with a trailing comma and a server
 * that refuses to start. Every command here rewrites the file atomically and
 * only ever through the registry, so the result parses by construction.
 *
 *   npm run household -- list
 *   npm run household -- add "Parents" mom@example.com dad@example.com
 *   npm run household -- join <id-or-name> sister@example.com
 *   npm run household -- leave <id-or-name> sister@example.com
 *   npm run household -- rename <id-or-name> "New name"
 */

const { registry, forHousehold } = storage.create();

/** Accept either the uuid or the name, because nobody memorises a uuid. */
function find(needle) {
  const key = String(needle || '').trim().toLowerCase();
  const byId = registry.byId(needle);
  if (byId) return byId;

  const matches = registry.all().filter((h) => h.name.toLowerCase() === key);
  if (matches.length > 1) {
    throw new Error(`More than one household is called "${needle}". Use the id instead.`);
  }
  if (!matches.length) throw new Error(`No household matches "${needle}".`);
  return matches[0];
}

function describe(h) {
  const { store } = forHousehold(h.id);
  const members = h.members.length ? h.members.join(', ') : '(nobody yet)';
  return `${h.name}\n  id       ${h.id}\n  members  ${members}\n  recipes  ${store.data.recipes.length}`;
}

const commands = {
  list() {
    const all = registry.all();
    if (!all.length) return 'No households yet.';
    return all.map(describe).join('\n\n');
  },

  add(name, ...members) {
    if (!name) throw new Error('Give the household a name: household add "Parents" mom@example.com');
    const created = registry.create({ name, members });
    return `Created:\n\n${describe(created)}`;
  },

  join(which, ...emails) {
    if (!emails.length) throw new Error('Give at least one email address to add.');
    const household = find(which);
    for (const email of emails) registry.addMember(household.id, email);
    return `Updated:\n\n${describe(registry.byId(household.id))}`;
  },

  leave(which, ...emails) {
    if (!emails.length) throw new Error('Give at least one email address to remove.');
    const household = find(which);
    for (const email of emails) registry.removeMember(household.id, email);

    const after = registry.byId(household.id);
    const warning = after.members.length
      ? ''
      : '\n\nWarning: nobody is left in this household. Its recipes are still on '
        + 'disk, but no one can reach them until somebody joins.';
    return `Updated:\n\n${describe(after)}${warning}`;
  },

  rename(which, name) {
    if (!name) throw new Error('Give the new name.');
    const household = find(which);
    household.name = String(name).trim();
    registry.save();
    return `Renamed:\n\n${describe(household)}`;
  },
};

function main(argv) {
  const [command, ...args] = argv;
  if (!command || command === 'help' || !commands[command]) {
    const known = Object.keys(commands).join(', ');
    return `Usage: npm run household -- <${known}> [arguments]\n\n`
      + 'Examples:\n'
      + '  npm run household -- list\n'
      + '  npm run household -- add "Parents" mom@example.com dad@example.com\n'
      + '  npm run household -- join Parents sister@example.com\n'
      + '  npm run household -- leave Parents sister@example.com\n'
      + '  npm run household -- rename Parents "Mum and Dad"';
  }
  return commands[command](...args);
}

if (require.main === module) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { main, commands, find };
