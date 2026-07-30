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
 *   npm run household -- add Parents mom@example.com dad@example.com
 *   npm run household -- join Parents sister@example.com
 *   npm run household -- leave Parents sister@example.com
 *   npm run household -- rename Parents --to Mum and Dad
 *
 * It edits whatever DATA_ROOT points at, which on a deployed server is not the
 * directory you are standing in. Every run prints the file it touched for that
 * reason. See the usage text for the form to use on the VM.
 */

const { registry, forHousehold } = storage.create();

/**
 * Which registry this command is about to edit.
 *
 * Printed on every run, and it is not decoration. The data directory is
 * resolved from DATA_ROOT, so running this from a source checkout instead of
 * the deployment silently edits `./data/households.json` — a different,
 * usually empty registry that the running server never reads. The command then
 * reports success and nothing changes, which is a maddening thing to debug.
 *
 * A registry this run had to create is a near-certain sign of exactly that, so
 * it gets a warning rather than a line of small print.
 */
function where() {
  const lines = [`Registry: ${registry.file}`];
  if (registry.created) {
    lines.push('');
    lines.push('  ⚠  That file did not exist, so this run just created an empty one.');
    lines.push('     If the app is already running somewhere, this is NOT its registry');
    lines.push('     and nothing you do here will affect it. Point DATA_ROOT at the');
    lines.push('     real data directory and try again, for example:');
    lines.push('');
    lines.push('       sudo -u weekofmeals DATA_ROOT=/var/lib/weekofmeals \\');
    lines.push('         node /opt/weekofmeals/server/household.js list');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Split arguments into a household name and a list of email addresses.
 *
 * `npm run household -- join "Shrek's Swamp" me@example.com` does not reliably
 * survive the trip through npm with its quoting intact, so a name with a space
 * can arrive as two arguments. Rather than blame the user for that, anything
 * containing an @ is treated as an address and everything else is joined back
 * into the name — which is unambiguous, because household names are not email
 * addresses.
 */
function split(args) {
  const emails = args.filter((a) => String(a).includes('@'));
  const name = args.filter((a) => !String(a).includes('@')).join(' ').trim();
  return { name, emails };
}

/**
 * The household a command means, when the name is optional.
 *
 * With one household there is nothing to disambiguate, so naming it is pure
 * ceremony — and naming it is where things go wrong. A name like "Shrek's
 * Swamp" contains an apostrophe, which opens a quote the shell then waits
 * forever to have closed; the command appears to hang and never runs. Letting
 * the single obvious household be implied removes that entirely:
 *
 *   household join me@example.com
 *
 * With two or more, the name is required, because guessing which family to add
 * somebody to is not a guess worth making.
 */
function target(name) {
  if (name) return find(name);

  const all = registry.all();
  if (all.length === 1) return all[0];
  if (!all.length) throw new Error(`No households exist yet.\n  Registry: ${registry.file}`);

  const names = all.map((h) => `"${h.name}"`).join(', ');
  throw new Error(
    `There is more than one household, so say which: ${names}.\n`
    + '  Names with an apostrophe or a space are easiest to give as the id from `list`.',
  );
}

/** Accept either the uuid or the name, because nobody memorises a uuid. */
function find(needle) {
  const key = String(needle || '').trim().toLowerCase();
  const byId = registry.byId(needle);
  if (byId) return byId;

  const matches = registry.all().filter((h) => h.name.toLowerCase() === key);
  if (matches.length > 1) {
    throw new Error(`More than one household is called "${needle}". Use the id instead.`);
  }
  if (!matches.length) {
    const known = registry.all().map((h) => `"${h.name}"`).join(', ') || 'none';
    throw new Error(
      `No household matches "${needle}".\n  Registry: ${registry.file}\n  Known households: ${known}`,
    );
  }
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
    if (!all.length) return `${where()}\nNo households yet.`;
    return `${where()}\n${all.map(describe).join('\n\n')}`;
  },

  add(...args) {
    const { name, emails } = split(args);
    if (!name) throw new Error('Give the household a name: household add "Parents" mom@example.com');
    const created = registry.create({ name, members: emails });
    return `${where()}\nCreated:\n\n${describe(created)}`;
  },

  join(...args) {
    const { name, emails } = split(args);
    if (!emails.length) throw new Error('Give at least one email address to add.');
    const household = target(name);
    for (const email of emails) registry.addMember(household.id, email);
    return `${where()}\nUpdated:\n\n${describe(registry.byId(household.id))}`;
  },

  leave(...args) {
    const { name, emails } = split(args);
    if (!emails.length) throw new Error('Give at least one email address to remove.');
    const household = target(name);
    for (const email of emails) registry.removeMember(household.id, email);

    const after = registry.byId(household.id);
    const warning = after.members.length
      ? ''
      : '\n\nWarning: nobody is left in this household. Its recipes are still on '
        + 'disk, but no one can reach them until somebody joins.';
    return `${where()}\nUpdated:\n\n${describe(after)}${warning}`;
  },

  /**
   * Two names on one line, either of which may contain spaces, so they are
   * separated by `--to` rather than by position:
   *   household rename Shrek's Swamp --to Fiona's Castle
   */
  rename(...args) {
    const at = args.indexOf('--to');
    if (at === -1) {
      throw new Error('Separate the names with --to:\n  household rename Old Name --to New Name');
    }
    const from = args.slice(0, at).join(' ').trim();
    const to = args.slice(at + 1).join(' ').trim();
    if (!from) throw new Error('Say which household to rename.');
    if (!to) throw new Error('Give the new name.');

    const household = find(from);
    household.name = to;
    registry.save();
    return `${where()}\nRenamed:\n\n${describe(household)}`;
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
      + '  npm run household -- join sister@example.com        (one household: no name needed)\n'
      + '  npm run household -- join Parents sister@example.com  (say which, when there are several)\n'
      + '  npm run household -- leave Parents sister@example.com\n'
      + '  npm run household -- rename Parents --to Mum and Dad\n\n'
      + 'On a deployed server, run it against the real data directory:\n'
      + '  sudo -u weekofmeals DATA_ROOT=/var/lib/weekofmeals \\\n'
      + '    node /opt/weekofmeals/server/household.js list';
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
