# Week of Meals

A small web app for planning a household's dinners and pushing the resulting
grocery list into AnyList. Runs on one machine at home; everyone opens it in a
browser on the wifi and adds it to their phone's home screen.

---

## Two ways to run this

**On a machine at home** — the instructions below. One command, no accounts.

**On a free cloud VM, reachable from anywhere** — see **[VM-SETUP.md](VM-SETUP.md)**.
A Google Cloud e2-micro (permanently free), a Cloudflare Tunnel so there are no
open ports, and Cloudflare Access for Gmail sign-in. The application code is
identical either way; only where it stores its data and whether it checks a
sign-in differ, and both are environment variables.

## Setup

You need [Node.js](https://nodejs.org) 20.6 or newer.

```bash
npm install
cp .env.example .env      # then edit it with your AnyList sign-in
npm run seed              # optional: ten starter recipes
npm start
```

Open <http://localhost:4321>. To use it from a phone, find the machine's local
address (`ipconfig getifaddr en0` on a Mac, `hostname -I` on Linux) and visit
`http://192.168.x.x:4321` — then use the browser's "Add to Home Screen" so it
opens like an app, full screen and without the address bar.

To keep it running after you close the terminal, use whatever your machine
already has: `pm2 start server/index.js`, a `launchd` plist on macOS, or a
`systemd` unit on Linux.

```bash
npm test                  # unit tests for the ingredient logic
```

---

## How it works

Three tabs, which is the whole app:

**Recipes** — the directory, and it browses like one. The top level is shelves
— Breakfast, Dinner, Dessert — each showing a peek at what is on it. Open one to
get its recipes; the breadcrumb takes you back. Search cuts straight through the
hierarchy, because when you are looking for a name you should not have to
remember which shelf you filed it on. Within a shelf you can still filter by
tag. Cards show the dish; recipes without a photo fall back to a monogram.
Add one by typing it in, or paste a link and let it pull the recipe down.

**Cook** — open any recipe and press *Cook this*. Full screen, big type,
ingredients you can cross off with a thumb, and one step at a time with the
current one on a white card you can read from across the kitchen. **The screen
will not sleep while it is open.**

**Week** — seven days. Tap a day, pick a meal. The ×1 / ×1.5 / ×2 control
scales a recipe when you're cooking for company or want leftovers, and the
shopping list follows along. Arrows move between weeks; past weeks stay put.

**List** — everything the week needs, added up and sorted by aisle. Uncheck
what you already have, then send it to AnyList. Tap **always have** on a line to
put it in the pantry and stop it appearing at all.

---

## Notes on the parts that were fiddly

### Importing from a link

Paste a URL on the *Add a recipe* form and press Fetch. The importer reads the
schema.org data recipe sites publish so Google can show the card in search
results, which is a far steadier target than scraping page markup.

It was built by running it against **saved HTML from eighteen real recipe
sites** — Serious Eats, NYT Cooking, Budget Bytes, Bon Appétit, Smitten
Kitchen, King Arthur, Half Baked Harvest, Love and Lemons, Epicurious,
AllRecipes, Delish, The Kitchn, Simply Recipes, Pinch of Yum, Skinnytaste,
BBC Good Food, Food.com and Taste of Home. Every branch in `import.js` exists
because one of them needed it:

* **Love and Lemons** writes `<script type=application/ld+json>` with the
  attribute value unquoted, which is legal HTML5 and defeats a naive regex.
* **King Arthur** puts the entire method in one string of `<p>` tags, so block
  boundaries have to become line breaks *before* the tags are stripped —
  otherwise twelve steps arrive as one wall of text.
* **Delish** nests steps in `HowToSection` instead of listing `HowToStep`.
* **Epicurious** publishes no JSON-LD at all, so there is a microdata fallback.
* **The `image` field** turns up as a string, an array of strings, an
  `ImageObject`, or an array of `ImageObject`. All four appear in the fixtures.

Where a site ships the whole method as one unbroken paragraph, it is split at
sentence ends — but *only* when the recipe collapsed to a single step. Applying
that everywhere shredded correctly-separated instructions into fragments, which
is why the rule is narrow.

Import is best-effort by design. Some sites sit behind bot protection and will
refuse; when that happens you get a plain sentence saying so, and the paste box
is right underneath. Always give an imported recipe a glance before saving — it
lands in the form, not straight in your library.

### Households

Everything in the app — recipes, the week, the shopping list, the pantry, the
AnyList account — belongs to a household rather than to the installation. Two
families can share one server and never see each other's dinner.

Each household is one JSON file:

```
data/
  households.json          who is in which household
  households/<id>.json     that household's recipes, week, list, settings
  households/backups/<id>/ its timestamped copies
  images/<id>/             its photos
```

One file each rather than one file keyed by household, because the store
rewrites the whole file on every save. Sharing one would mean adding a recipe
rewrites every other family's data, and one corrupt file would cost all of them
their library instead of one of them.

Cloudflare Access still decides *who may use the app at all*. The registry
decides *whose kitchen they land in*, which is a different question and one only
this application can answer. Somebody who gets past Access but is in no
household is told so plainly, with the address to add — they are not an
intruder, just somebody the list has not caught up with.

Membership is many-to-many, so you can be in your own household and your
parents'. Almost nobody is, so the interface never mentions the concept until
you are in two, at which point a switcher appears in Settings. Each household
keeps its **own AnyList account**, entered in its own Settings — sharing one
would mean your parents' shopping list arriving in your AnyList.

**Households govern themselves.** Whoever creates one administers it: they can
invite, remove, rename, and hand the role to somebody else. There is no
server-wide superuser — Cloudflare Access decides who may reach the application
at all, and from there each household is its own business.

Somebody signing in for the first time is offered the two ways in, and needs
nobody's help at a terminal for either:

* **Start a household** — for their own kitchen. They administer it.
* **Join one** — with an invite code from somebody who already administers one.

Invite codes are eight characters shown as `ABCD-EFGH`, good **once**, for a
**week**. The alphabet leaves out every pair that looks alike — no `O` or `0`,
no `I`, `L` or `1` — because they are read off a phone screen and typed by hand.
An invitation can optionally be **locked to one address**, which makes it inert
if the message goes astray; leave it blank for a code that is simplest to text.

Two rules exist to stop a household becoming unmanageable, and both are refusals
rather than warnings after the fact: an administrator cannot be removed without
being demoted first, and the last administrator cannot step down or leave while
anybody else is still in the household. A household that ends up with nobody in
charge anyway — a registry migrated from before any of this existed — can be
taken over by any of its members.

Joining somebody else's household never makes you an administrator of it, and a
household you are not in is a 404 rather than a 403: it should not be possible
to tell that it exists.

**The command line remains** for the person who owns the machine, as break-glass
for the case where the last administrator has gone:

```
npm run household -- list
npm run household -- admin me@example.com            # grant, for when nobody can
npm run household -- admin them@example.com --revoke
npm run household -- join sister@example.com         # one household: no name needed
npm run household -- add Parents mum@example.com
npm run household -- rename Parents --to Mum and Dad
```

**With a single household the name is optional**, which is worth using. Naming
one is where things go wrong: `npm run` does not reliably keep quoting intact,
and a name like `Shrek's Swamp` contains an apostrophe that opens a shell quote
the terminal then waits forever to have closed — the command looks like it has
hung when in fact it never ran. Where a name is genuinely needed, the id from
`list` never has this problem.

**On a deployed server, run it against the real data directory**, not from a
source checkout:

```bash
sudo -u weekofmeals DATA_ROOT=/var/lib/weekofmeals \
  node /opt/weekofmeals/server/household.js list
```

This is worth being careful about. The registry path comes from `DATA_ROOT`, so
running the command in a checkout edits `./data/households.json` — a different,
usually empty registry that the running server never reads. It would report
success and change nothing. Every run therefore prints the file it touched, and
warns loudly if it had to create one.

**Photos are served per household**, which has one consequence worth knowing:
their responses are `Cache-Control: private`, so Cloudflare will not cache them
at the edge. It cannot — a shared cache holding a `public` response has no idea
the URL is household-specific, and would serve one family's photo to the next
person who asked for it. Browsers still cache them for thirty days, which is
what matters on a phone; the cost is that each browser fetches each photo from
the origin once.

**Upgrading from before households** happens by itself: the old `db.json`
becomes household number one, whoever was in `ALLOWED_EMAILS` becomes its
founding members, and the original is left on disk as `db.json.migrated` so a
botched upgrade is one `mv` away from being undone.

### When a sign-in is refused

Cloudflare Access authenticates the person; the origin verifies the assertion
again, because "the edge checked it" is only true of traffic that came through
the edge. When that second check fails the browser says so and names the cause,
and the origin logs it:

```bash
sudo journalctl -u weekofmeals -n 50 | grep 'sign-in refused'
```

| Code | What it means |
| --- | --- |
| `NO_TOKEN` | No `CF_Authorization` cookie reached the origin at all. Usually the page came from a cache without passing Access, or the hostname is not the one the Access application covers. |
| `BAD_AUD` | A genuine sign-in, minted for a **different Access application**. `CF_ACCESS_AUD` does not match that application's Application Audience tag. The log prints both values. |
| `BAD_ISS`, `BAD_KID` | `CF_ACCESS_TEAM` names the wrong team. |
| `EXPIRED`, `NOT_YET` | Genuinely expired, or the machine's clock has drifted — `timedatectl` will say which. |
| `BAD_SIGNATURE` | The signature did not verify. Treat as a real failure, not a configuration slip. |

`BAD_AUD` is the one most people meet. Surrounding quotes, stray whitespace, a
carriage return from an editor on Windows and a difference in case are all
tolerated now — every one of them printed identically to the correct value while
failing an exact comparison, so "I checked, it matches" and "it does not match"
could both be true at once. What remains is a genuine mismatch: the tag was
copied from the wrong application, or a second Access application covers the
same hostname and is minting the assertion instead. The log prints both values
in angle brackets, so the answer is whichever of the two you did not expect.

A `CF_ACCESS_AUD` that is not 64 hex characters cannot match anything, so the
server says so at startup rather than letting you discover it one refused
sign-in at a time.

The assertion itself is never logged. It is a live credential; the AUD tag
beside it merely names an application and cannot authenticate anything.

### Categories, and why they are not tags

A recipe has many tags and exactly one category. That is the whole distinction,
and it is what makes the folder view possible: tags are adjectives you pile on
("fast", "one pan", "kid approved") and a recipe wears as many as fit, while a
category is the single shelf it lives on. Because every recipe is in exactly one
place, the shelves add up to the whole collection with nothing double-counted
and nothing missing — which is the property a directory needs and a tag cloud
can never have.

Seven are offered — breakfast, lunch, dinner, dessert, snack, side, drink — but
the field is free text, so if you want a Baking shelf you type it and get one.

Recipes written before categories existed have no category field. Rather than
tipping all of them into "Uncategorized", the shelf is read off the tags first:
a recipe already tagged `breakfast` plainly is one. This is a **read-time
default, not a migration** — nothing is rewritten on disk until you next save
that recipe, so the guess is never destructive and never has to be undone. Open
a recipe's edit form and the guess is sitting in the field, ready to be
confirmed or corrected.

### The pantry

Salt, olive oil and flour arrive pre-unticked every week because they are
flagged as staples, but that list is a guess about a general kitchen rather than
a fact about yours. The pantry is where you correct it: tap **always have** on
any shopping-list line and that ingredient is left off the list every week from
then on, no unticking required.

It is keyed on the *canonical* ingredient name — the same form the consolidator
uses to add amounts together — so putting garlic in the pantry covers "2 cloves
garlic", "1 head garlic" and "4 cloves garlic, minced" in one go.

Three states decide whether something is on the list, in this order of
authority:

1. An explicit tick or untick for **this week** always wins.
2. Otherwise, anything in the **pantry** or flagged a **staple** starts off it.
3. Everything else starts on it.

So you can still buy garlic on a week you have run out, without taking it out of
the pantry. Manage the whole list from Settings → Pantry.

### Undoing a delete

Deleting a recipe does not ask you to confirm. It deletes, then offers **Undo**
for six seconds with a countdown bar, and restores the recipe *and* every day it
was planned for. Pressing undo twice is harmless.

The photo is deliberately not deleted at the same time — an undo would otherwise
restore a recipe pointing at a missing file. Orphaned photos are swept up by
`POST /api/images/tidy` instead.

### Batch sizes

The ×1 / ×1.5 / ×2 chips cover most weeknights. The fourth chip opens a sheet
with more presets and a free number entry, so "I need this for nine people" is
expressible rather than rounded to the nearest preset. Where the recipe records
how many it serves, the sheet shows the resulting serving count as you type.

Values are clamped to between 0 and 20 and rounded to two decimals — a scale of
zero or of four hundred produces a shopping list nobody wants.

### Copying a week

Eating the same rotation? **Copy a previous week** on the week view offers any of
the last eight weeks that had meals in them, with the meal count for each. Meals
are copied rather than moved, batch sizes come across intact, and the week you
took them from is untouched. By default the copy adds alongside anything already
planned; there is a switch to replace instead.

### Adding up ingredients

This is the part that quietly goes wrong in apps like this, so a few rules are
enforced deliberately.

**Amounts are only combined when they mean the same kind of thing.** Volumes
merge with volumes, weights with weights, and each countable unit only with
itself. So two cloves of garlic plus one head of garlic comes out as
`2 cloves + 1 head` on one line, marked as a split amount — not as a fictional
"3." Guessing a conversion there would be worse than showing you the truth.

**Nothing merges unless the names match exactly** after plurals are folded and
a short synonym list is applied (green onion → scallion, garbanzo → chickpea).
Fuzzy matching "bell pepper" to "green pepper" is the kind of cleverness that
puts the wrong thing in your cart, so it isn't there.

**Every line shows where it came from** — small chips naming the day and the
dinner that put it on the list. If you're standing in the store wondering why
you need three bunches of parsley, the answer is right under the item.

The parser handles what recipes actually look like: `1 1/2` and `1½`, ranges
like `2-3 tbsp` (it buys for the larger amount), parentheticals like
`1 can (14.5 oz) diced tomatoes`, size words on either side of the unit
(`1 large head broccoli`), and `Juice of 1 lemon` (buy the lemon). It knows
that "ground" belongs to *ground beef* rather than being a preparation step.

Salt, pepper, flour and other staples arrive pre-unchecked. One tap adds them
back on the week you actually run out.

### Sign-in

There is none when you run this at home, which is deliberate: it is on your own
network and adding accounts to a family kitchen tool is friction for no gain.

Deployed to a public URL it is a different matter, and
[VM-SETUP.md](VM-SETUP.md) puts Cloudflare Access in front — Google sign-in,
checked against a list of your household's addresses at Cloudflare's edge before
a request ever reaches the app. The app then verifies that assertion again
itself, so anything reaching the port by another route is still refused.
`server/lib/auth.js` does that verification, and `test/auth.test.js` mints real
signed tokens to prove it rejects the known ways past a JWT check.

### Keeping the screen awake

There are two ways to stop a phone sleeping, and the app uses both because the
good one is unavailable in exactly the setup this app is built for.

The **Wake Lock API** is the proper answer, but browsers only expose it in a
*secure context*. Opening the app at `http://192.168.1.50:4321` on your own
wifi is not a secure context, so Wake Lock silently refuses there — it works at
`http://localhost` on the host machine and over HTTPS, and nowhere else.

So the fallback is a **muted looping video** (`public/nosleep.*`, three seconds
of black, under 2 KB). Browsers keep the screen lit while something is playing,
and this works fine over plain HTTP. It is the mechanism your phones will
actually use.

The badge in the top right of cooking mode tells you which one is holding:

| Badge | Meaning |
|---|---|
| **Screen stays on** | Wake Lock or the video has it. You're fine. |
| **Tap to keep awake** | The lock was dropped (a call came in, you switched apps). Tap to take it back. |
| **Screen may sleep** | Neither worked. Raise the screen timeout in your phone's settings. |

The lock is re-acquired automatically whenever you come back to the app.

### Photos

A recipe imported from a link brings its picture with it. You can also choose
one from the camera or photo library on the *Add a recipe* form.

Either way the file is **copied into `data/images/`** rather than hot-linked.
Hot-linking looks cheaper until the source site reorganises and the whole
library goes grey, or you're cooking in a basement kitchen with no signal.
Uploads are resized in the browser (long edge 1000px, JPEG) before they are
sent, so the server needs no image library and nothing has to compile.

### The AnyList integration

**There is no official AnyList API.** This uses the `anylist` npm package, which
is reverse-engineered from their apps. Three consequences shaped the code:

1. **It can break when AnyList ships an update.** Every call is wrapped, and a
   failure comes back as a plain sentence rather than a stack trace. The Copy
   button on the list always works, so a broken export is an annoyance rather
   than a dead end.
2. **Auth is your actual email and password**, not a revocable token. Each
   household stores its own under Settings, because a shared account would mean
   your parents' shopping list arriving in your AnyList — a privacy failure
   rather than a missing feature, and a silent one, since the export would
   report success either way. A household with no account simply cannot export;
   it never falls back to another household's.

   Because AnyList offers nothing more limited to use, that really is somebody's
   account password, so it is **encrypted at rest** (AES-256-GCM) before it
   touches the disk and never sent back to the browser — the page is told only
   whether a password exists. The key comes from `SECRET_KEY`, or is generated
   once into `data/secret.key` with mode 0600.

   Be clear about what that buys: it protects the database file and every backup
   of it, which are the things that get tarred up nightly and copied off the box.
   It does not protect against somebody who already has root on the running
   server, because the process must be able to decrypt in order to log in. There
   is no way around that for a credential used unattended. Losing the key costs
   you the stored passwords and nothing else; they can be typed in again.

   This is still not a service you should open to sign-ups. Holding a handful of
   family members' third-party passwords is one thing; holding strangers' is a
   serious undertaking, and this isn't one.
3. **Exports are idempotent-ish on purpose.** Sending twice won't duplicate
   items — it skips anything already sitting unchecked on the target list, and
   remembers what it sent so you can choose "only what hasn't been sent yet"
   after adding a meal mid-week.

⚠️ **Point this at a scratch list the first time.** Make a list called `Test` in
AnyList and send to that before you trust it with your real Groceries list.
The export path is the one piece that couldn't be verified without live
credentials.

### Compression

Responses are gzipped (or brotli'd, if the client asks) by `compression`,
mounted as the very first middleware so it can wrap the static handler and every
route. Measured on the real assets:

| | before | after |
|---|---|---|
| `app.js` | 47.0 KB | 14.5 KB |
| `style.css` | 28.7 KB | 7.0 KB |
| shopping list JSON | 27.7 KB | 2.7 KB |
| a cold page load | 78.3 KB | 23.1 KB |

Worth doing even with Cloudflare in front, because Cloudflare only compresses
edge-to-browser — the origin-to-edge hop sends whatever this process sends.

Defaults are left alone where they were already right. The `compressible` table
skips `image/*` and `video/*`, so recipe photos and the keep-awake clips pass
through untouched instead of burning CPU to make already-compressed bytes
slightly larger. Brotli quality defaults to 4 rather than 11, which matters on a
shared-core VM. And the 1 KB threshold leaves `/api/healthz` alone.

`test/compression.test.js` checks all three of those things, and checks that what
comes back out is byte-for-byte what went in — a response 90% smaller but subtly
wrong would be far worse than an uncompressed one.

### Storage — nothing needs re-entering

Every change is written to `data/db.json` the moment you make it. There is no
save button and no session: add a recipe, plan a week, tick something off the
list, and it is on disk before the request returns. Restarting the server,
rebooting the machine, and closing every phone in the house all leave it alone.
This is verified in `test/store.test.js`, which writes through a store, throws
the instance away, opens a fresh one over the same file, and checks it all came
back.

A few dozen recipes and one week at a time does not need a database server, and
a flat file is readable, greppable, backed up with `cp`, and survives Node
upgrades without a native rebuild. Writes are atomic — a temp file, then a
rename — so a crash mid-save cannot leave a half-written database.

Three layers of safety net:

* **Automatic snapshots.** The last ten copies live in `data/backups/`, one
  taken each time the server starts.
* **Download a backup.** Settings → *Download a backup* hands you a single
  JSON file with every recipe, plan and setting in it.
* **Restore.** Settings → *Restore* takes that file back. It snapshots what is
  currently there first, in case the restore was the mistake.

To move the whole thing to a new machine, copy `data/` — the database and the
photos both live there.

---

## Layout

```
server/
  index.js              Express app and API routes
  seed.js               starter recipes
  household.js          the membership command line
  lib/
    units.js            unit table, conversion, how amounts get written
    parse.js            one ingredient line -> quantity, unit, item, note
    consolidate.js      a week of meals -> one shopping list
    store.js            the JSON file, written atomically
    categories.js       which shelf a recipe lives on
    households.js       the registry: who shares a kitchen
    secrets.js          encryption at rest for AnyList passwords
    anylist.js          AnyList session, dedupe, error handling
    import.js           pull a recipe off a web page
    images.js           copy photos in, serve them, tidy up after
public/
  index.html            the shell
  app.js                the whole front end, no framework, no build step
  style.css             the visual system
  lib/
    auth.js             verifies Cloudflare Access assertions at the origin
    storage.js          picks where the database and photos live
public/
  nosleep.mp4/.webm     three seconds of black, keeps phone screens lit
deploy/
  setup.sh              provisions a fresh Debian/Ubuntu VM, idempotent
  update.sh             ships new code, rolls back if it won't start
  backup.sh             nightly archive, optionally pushed off the box
  weekofmeals.service   hardened systemd unit
  cloudflared-config.yml  reference tunnel configuration
  env.example           the shape of /etc/weekofmeals/env
test/
  ingredients.test.js   parser, conversion, and consolidation
  import.test.js        one case per real-world site quirk
  store.test.js         data survives the process that wrote it
  render.test.js        hidden elements are really hidden (see below)
  compression.test.js   responses shrink, and survive the round trip
```

The front end is plain JavaScript on purpose. There's no bundler to keep
current and no dependency tree to audit, which for something that needs to
still work in five years is worth more than the ergonomics of a framework.

---

## One bug worth knowing about

The app once served a blank, unclickable screen. `#cook` carried the `hidden`
attribute and every test asserting `element.hidden === true` passed — but the
overlay painted anyway, because `.cook { display: flex }` overrides the browser's
`[hidden] { display: none }` rule. Author styles always beat user-agent styles,
so a fixed, full-viewport, opaque panel sat on top of everything, swallowing
clicks, with nothing visibly wrong in the markup.

`element.hidden` is an attribute, not a rendering assertion. `render.test.js`
reads *computed style* for every element carrying `hidden`, so the whole class of
bug is caught rather than the one instance. The guard rule lives at the very
bottom of `style.css` and there is a test asserting it stays there — appending
`.toast { display: flex }` below it reintroduced the same bug once already.

## Things worth adding later, roughly in order of payoff

- **Timers in cooking mode**, started by tapping a duration in a step.
- **Reusable week templates** — "the easy week," "the company week" — saved by
  name rather than copied from a specific past week.
- **Ad-hoc shopping list items**, for the paper towels and dish soap that never
  came from a recipe.
- **Shopping mode**: a stripped-down checklist view for the store itself, though
  AnyList already does this well, which is rather the point.
- **A synonym editor** in the UI, so you can teach it your own equivalences
  rather than editing `SYNONYMS` in `parse.js`.
