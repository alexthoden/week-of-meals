'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const compression = require('compression');

const storage = require('./lib/storage');
const auth = require('./lib/auth');
const { consolidate, AISLE_ORDER } = require('./lib/consolidate');
const { parseIngredient } = require('./lib/parse');
const categories = require('./lib/categories');
const anylist = require('./lib/anylist');
const { importFromUrl } = require('./lib/import');

const PORT = Number(process.env.PORT) || 4321;

const { store, images, kind, describe } = storage.create();
const app = express();

// 12 MB: a browser-resized photo arrives as base64, which inflates by a third.
/*
 * Compress responses. This must come before the static handler and every route,
 * or it has nothing left to wrap.
 *
 * Worth it even though Cloudflare compresses again on the way to the browser:
 * that only covers edge-to-browser. The origin-to-edge hop sends whatever this
 * process sends, so without this the VM was shipping app.js and style.css at
 * full size on every cache miss, plus every uncached API response.
 *
 * Defaults are deliberately left alone where they are already right:
 *   - The `compressible` table skips image/* and video/*, so recipe photos and
 *     the keep-awake clips are passed through untouched rather than burning CPU
 *     to make already-compressed bytes very slightly larger.
 *   - Brotli quality defaults to 4, not 11. On a shared-core e2-micro the top
 *     setting would cost far more CPU than the handful of saved bytes is worth.
 *   - The 1 KB threshold leaves tiny replies like /api/healthz alone.
 */
app.use(compression());

app.use(express.json({ limit: '12mb' }));

// On S3 the photos are served straight from the bucket through CloudFront and
// never touch this process, so there is nothing local to mount.
if (images.IMAGE_DIR) {
  app.use('/images', express.static(images.IMAGE_DIR, { maxAge: '30d', immutable: true }));
}

// Does nothing until GOOGLE_CLIENT_ID is set, which is how it runs at home.
app.use('/api', auth.middleware());

// Reload the document so one phone sees what another just changed. A no-op on
// disk, one small GET on S3.
app.use('/api', (req, res, next) => {
  store.refresh().then(() => next()).catch(next);
});
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

const id = () => crypto.randomUUID();

/* ---------------------------------------------------------------- dates -- */

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekStart(dateish, startDay = 0) {
  const d = dateish ? new Date(`${dateish}T12:00:00`) : new Date();
  d.setHours(12, 0, 0, 0);
  const shift = (d.getDay() - startDay + 7) % 7;
  d.setDate(d.getDate() - shift);
  return isoDate(d);
}

function weekDates(start) {
  const d = new Date(`${start}T12:00:00`);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(d);
    x.setDate(d.getDate() + i);
    return isoDate(x);
  });
}

/* ------------------------------------------------------------- handlers -- */

function wrap(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      const status = err.code === 'NOT_CONFIGURED' ? 400
        : err.code === 'BAD_CREDENTIALS' ? 401
          : err.code === 'NO_SUCH_LIST' ? 404 : 500;
      res.status(status).json({ error: err.message, code: err.code || 'ERROR' });
    }
  };
}

/**
 * Any positive multiplier, not just the three presets, so "I need this for
 * nine people" is expressible. Clamped and rounded because a scale of 0, or of
 * 400, produces a shopping list nobody wants and the arithmetic downstream
 * assumes a sane number.
 */
function cleanScale(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(n, 20) * 100) / 100;
}

function recipeById(rid) {
  return store.data.recipes.find((r) => r.id === rid) || null;
}

function mealsForWeek(start) {
  const out = [];
  for (const date of weekDates(start)) {
    for (const meal of store.data.plan[date] || []) {
      const recipe = recipeById(meal.recipeId);
      if (recipe) out.push({ ...meal, day: date, recipe });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- state -- */

app.get('/api/bootstrap', wrap(async (req, res) => {
  const startDay = store.data.settings.startOfWeek ?? 0;
  const start = weekStart(req.query.week, startDay);
  const dates = weekDates(start);

  res.json({
    today: isoDate(new Date()),
    weekOf: start,
    dates,
    recipes: store.data.recipes.map((r) => ({
      id: r.id, title: r.title, tags: r.tags || [], time: r.time || '',
      servings: r.servings || '', source: r.source || '',
      image: r.image || '',
      category: categories.categoryOf(r),
      ingredientCount: (r.ingredients || []).length,
    })),
    // The shelves that actually hold something, plus the ones we always offer,
    // so the folder view can stand a recipe up in an empty category too.
    categories: categories.summarize(store.data.recipes),
    categoryChoices: categories.CATEGORIES,
    plan: Object.fromEntries(dates.map((d) => [d, (store.data.plan[d] || []).map((m) => ({
      ...m, title: recipeById(m.recipeId)?.title || 'Deleted recipe',
    }))])),
    settings: store.data.settings,
    anylist: { configured: anylist.configured() },
  });
}));

app.get('/api/recipes/:id', wrap(async (req, res) => {
  const recipe = recipeById(req.params.id);
  if (!recipe) return res.status(404).json({ error: 'That recipe is gone.' });
  res.json({
    ...recipe,
    // Resolved, not raw: an older recipe with no category still opens its edit
    // form on the right shelf, and saving makes that guess permanent.
    category: categories.categoryOf(recipe),
    parsed: (recipe.ingredients || []).map(parseIngredient).filter(Boolean),
  });
}));

function cleanRecipe(body) {
  const lines = (v) => (Array.isArray(v) ? v : String(v || '').split('\n'))
    .map((s) => String(s).trim()).filter(Boolean);
  return {
    title: String(body.title || '').trim() || 'Untitled recipe',
    source: String(body.source || '').trim(),
    servings: String(body.servings || '').trim(),
    time: String(body.time || '').trim(),
    tags: (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(','))
      .map((t) => String(t).trim().toLowerCase()).filter(Boolean),
    category: categories.normalizeCategory(body.category),
    ingredients: lines(body.ingredients),
    steps: lines(body.steps),
    notes: String(body.notes || '').trim(),
    image: String(body.image || '').trim(),
  };
}

app.post('/api/recipes', wrap(async (req, res) => {
  const fields = cleanRecipe(req.body);
  // Keep our own copy so the picture survives the source site reorganising.
  fields.image = await images.cacheRemote(fields.image);
  const recipe = { id: id(), createdAt: new Date().toISOString(), ...fields };
  await store.update((d) => d.recipes.push(recipe));
  res.status(201).json(recipe);
}));

app.put('/api/recipes/:id', wrap(async (req, res) => {
  const existing = recipeById(req.params.id);
  if (!existing) return res.status(404).json({ error: 'That recipe is gone.' });
  const fields = cleanRecipe(req.body);
  fields.image = await images.cacheRemote(fields.image);
  if (existing.image && existing.image !== fields.image) images.remove(existing.image);
  await store.update(() => Object.assign(existing, fields));
  res.json(existing);
}));

app.delete('/api/recipes/:id', wrap(async (req, res) => {
  const recipe = recipeById(req.params.id);
  if (!recipe) return res.status(404).json({ error: 'That recipe is already gone.' });

  // Everything needed to undo, captured before anything is removed. The photo
  // is deliberately left on disk: deleting it here would make an undo restore a
  // recipe pointing at a file that no longer exists. Orphans are swept up by
  // the photo tidy instead.
  const undo = {
    recipe: structuredClone(recipe),
    placements: [],
  };

  await store.update((d) => {
    d.recipes = d.recipes.filter((r) => r.id !== req.params.id);
    for (const date of Object.keys(d.plan)) {
      for (const meal of d.plan[date]) {
        if (meal.recipeId === req.params.id) undo.placements.push({ date, meal: structuredClone(meal) });
      }
      d.plan[date] = d.plan[date].filter((m) => m.recipeId !== req.params.id);
      if (!d.plan[date].length) delete d.plan[date];
    }
  });

  res.json({ ok: true, undo });
}));

/**
 * Put a deleted recipe back, along with the days it was planned for.
 * Idempotent: pressing undo twice does not create a duplicate.
 */
app.post('/api/recipes/restore', wrap(async (req, res) => {
  const incoming = req.body && req.body.recipe;
  if (!incoming || !incoming.id) {
    return res.status(400).json({ error: 'Nothing to restore.' });
  }
  const placements = Array.isArray(req.body.placements) ? req.body.placements : [];

  await store.update((d) => {
    if (!d.recipes.some((r) => r.id === incoming.id)) d.recipes.push(incoming);
    for (const { date, meal } of placements) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) continue;
      d.plan[date] = d.plan[date] || [];
      if (!d.plan[date].some((m) => m.id === meal.id)) d.plan[date].push(meal);
    }
  });

  res.json({ ok: true, recipe: incoming });
}));

/** Delete photos no recipe refers to any more. */
app.post('/api/images/tidy', wrap(async (req, res) => {
  res.json({ removed: await images.collectGarbage(store.data.recipes) });
}));

app.post('/api/recipes/import', wrap(async (req, res) => {
  const recipe = await importFromUrl(String(req.body.url || ''));
  res.json(recipe);
}));

/* ----------------------------------------------------------------- plan -- */

app.post('/api/plan', wrap(async (req, res) => {
  const date = String(req.body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Pick a day first.' });
  if (!recipeById(req.body.recipeId)) return res.status(404).json({ error: 'That recipe is gone.' });

  const meal = { id: id(), recipeId: req.body.recipeId, scale: cleanScale(req.body.scale) };
  await store.update((d) => {
    d.plan[date] = d.plan[date] || [];
    d.plan[date].push(meal);
  });
  res.status(201).json(meal);
}));

app.patch('/api/plan/:mealId', wrap(async (req, res) => {
  await store.update((d) => {
    for (const [date, meals] of Object.entries(d.plan)) {
      const meal = meals.find((m) => m.id === req.params.mealId);
      if (!meal) continue;
      if (req.body.scale !== undefined) meal.scale = cleanScale(req.body.scale);
      if (req.body.date && req.body.date !== date) {
        d.plan[date] = meals.filter((m) => m.id !== meal.id);
        if (!d.plan[date].length) delete d.plan[date];
        d.plan[req.body.date] = d.plan[req.body.date] || [];
        d.plan[req.body.date].push(meal);
      }
      return;
    }
  });
  res.json({ ok: true });
}));

app.delete('/api/plan/:mealId', wrap(async (req, res) => {
  await store.update((d) => {
    for (const [date, meals] of Object.entries(d.plan)) {
      const next = meals.filter((m) => m.id !== req.params.mealId);
      if (next.length !== meals.length) {
        d.plan[date] = next;
        if (!next.length) delete d.plan[date];
        return;
      }
    }
  });
  res.json({ ok: true });
}));

app.post('/api/plan/clear', wrap(async (req, res) => {
  const start = weekStart(req.body.week, store.data.settings.startOfWeek ?? 0);
  await store.update((d) => {
    for (const date of weekDates(start)) delete d.plan[date];
    delete d.checked[start];
  });
  res.json({ ok: true });
}));

/**
 * Copy every meal from one week onto another.
 * `from` defaults to the week before `to`, which is the common case: you are
 * eating the same rotation as last week.
 */
app.post('/api/plan/copy', wrap(async (req, res) => {
  const startDay = store.data.settings.startOfWeek ?? 0;
  const to = weekStart(req.body.to, startDay);

  let from = req.body.from ? weekStart(req.body.from, startDay) : null;
  if (!from) {
    const d = new Date(`${to}T12:00:00`);
    d.setDate(d.getDate() - 7);
    from = isoDate(d);
  }
  if (from === to) return res.status(400).json({ error: 'That is the same week.' });

  const sourceDates = weekDates(from);
  const targetDates = weekDates(to);
  const replace = req.body.replace === true;

  let copied = 0;
  await store.update((d) => {
    for (let i = 0; i < 7; i += 1) {
      const source = d.plan[sourceDates[i]] || [];
      if (replace) delete d.plan[targetDates[i]];
      if (!source.length) continue;

      d.plan[targetDates[i]] = d.plan[targetDates[i]] || [];
      for (const meal of source) {
        // New ids: the copies are their own meals, movable and removable
        // without disturbing the week they came from.
        d.plan[targetDates[i]].push({ id: id(), recipeId: meal.recipeId, scale: meal.scale || 1 });
        copied += 1;
      }
    }
    for (const date of targetDates) {
      if (d.plan[date] && !d.plan[date].length) delete d.plan[date];
    }
    // The old tick-offs describe a different shopping list now.
    delete d.checked[to];
  });

  if (!copied) return res.status(400).json({ error: 'There was nothing planned that week.' });
  res.json({ ok: true, copied, from, to });
}));

/** Which recent weeks actually have meals, so the UI can offer them. */
app.get('/api/plan/weeks', wrap(async (req, res) => {
  const startDay = store.data.settings.startOfWeek ?? 0;
  const current = weekStart(req.query.week, startDay);
  const out = [];
  for (let back = 1; back <= 8; back += 1) {
    const d = new Date(`${current}T12:00:00`);
    d.setDate(d.getDate() - (7 * back));
    const start = weekStart(isoDate(d), startDay);
    const count = weekDates(start).reduce((n, date) => n + (store.data.plan[date]?.length || 0), 0);
    if (count) out.push({ weekOf: start, meals: count });
  }
  res.json({ weeks: out });
}));

/* ----------------------------------------------------------- shopping ---- */

function buildList(start) {
  const items = consolidate(mealsForWeek(start));
  const checked = store.data.checked[start] || {};
  const pantry = new Set(store.data.settings.pantry || []);
  const lastExport = [...store.data.exports].reverse().find((e) => e.weekOf === start) || null;

  return {
    weekOf: start,
    aisles: AISLE_ORDER,
    lastExport,
    pantry: [...pantry],
    items: items.map((item) => {
      const inPantry = pantry.has(item.key);
      return {
        ...item,
        inPantry,
        // Three states, in order of authority: an explicit tick for this week
        // wins; otherwise anything in the pantry or flagged a staple starts
        // off the list; everything else starts on it.
        include: checked[item.key] !== undefined ? checked[item.key] : !(item.staple || inPantry),
        exportedBefore: Boolean(lastExport && lastExport.keys.includes(item.key)),
      };
    }),
  };
}

app.get('/api/list', wrap(async (req, res) => {
  res.json(buildList(weekStart(req.query.week, store.data.settings.startOfWeek ?? 0)));
}));

app.put('/api/list/include', wrap(async (req, res) => {
  const start = weekStart(req.body.week, store.data.settings.startOfWeek ?? 0);
  await store.update((d) => {
    d.checked[start] = d.checked[start] || {};
    if (Array.isArray(req.body.keys)) {
      for (const key of req.body.keys) d.checked[start][key] = Boolean(req.body.include);
    } else {
      d.checked[start][req.body.key] = Boolean(req.body.include);
    }
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------- anylist -- */

app.get('/api/anylist/lists', wrap(async (req, res) => {
  res.json({ lists: await anylist.listNames() });
}));

app.post('/api/anylist/export', wrap(async (req, res) => {
  const start = weekStart(req.body.week, store.data.settings.startOfWeek ?? 0);
  const listName = String(req.body.listName || store.data.settings.listName || '').trim();
  if (!listName) return res.status(400).json({ error: 'Choose which AnyList list to add to.' });

  const list = buildList(start);
  let chosen = list.items.filter((i) => i.include);
  if (req.body.onlyNew) chosen = chosen.filter((i) => !i.exportedBefore);

  if (!chosen.length) {
    return res.status(400).json({ error: 'Nothing selected to send.' });
  }

  const payload = chosen.map((i) => ({
    name: i.name,
    quantity: i.quantity,
    // Provenance travels with the item, so in the store you know why it's there.
    details: i.recipes.map((r) => r.title).join(', '),
  }));

  const result = await anylist.addItems(listName, payload, {
    skipExisting: req.body.skipExisting !== false,
  });

  await store.update((d) => {
    d.settings.listName = listName;
    d.exports.push({
      id: id(),
      at: new Date().toISOString(),
      weekOf: start,
      listName,
      keys: chosen.map((i) => i.key),
      count: result.added.length,
    });
    d.exports = d.exports.slice(-100);
  });

  res.json(result);
}));

/* ---------------------------------------------------------------- who -- */

/**
 * Public on purpose: the browser has to be able to ask what it should show
 * before it has a token. It leaks only whether sign-in is required and the
 * client ID, which is public by design in OAuth.
 */
app.get('/api/whoami', (req, res) => {
  const guarded = Boolean(process.env.CF_ACCESS_TEAM && process.env.CF_ACCESS_AUD);
  res.json({
    authRequired: guarded,
    user: req.user && !req.user.local ? req.user : null,
  });
});

/** For the systemd watchdog and any uptime check you point at it. */
app.get('/api/healthz', (req, res) => {
  res.json({ ok: true, recipes: store.data.recipes.length, uptime: Math.round(process.uptime()) });
});

/* -------------------------------------------------------------- pantry -- */

/**
 * The pantry is a list of canonical ingredient keys ("olive oil", "kosher
 * salt") you always have in. They are dropped from the shopping list every week
 * without you unticking them again.
 *
 * Keys rather than display names, so "2 cloves garlic" and "1 head garlic"
 * resolve to the same pantry entry — the same canonical form the consolidator
 * uses to add amounts together.
 */
app.get('/api/pantry', wrap(async (req, res) => {
  res.json({ pantry: (store.data.settings.pantry || []).slice().sort() });
}));

app.put('/api/pantry', wrap(async (req, res) => {
  const keys = Array.isArray(req.body.keys) ? req.body.keys : [req.body.key];
  const clean = keys
    .map((k) => String(k || '').trim().toLowerCase())
    .filter(Boolean);
  if (!clean.length) return res.status(400).json({ error: 'Nothing to add.' });
  const keep = req.body.inPantry !== false;

  await store.update((d) => {
    const set = new Set(d.settings.pantry || []);
    for (const key of clean) {
      if (keep) set.add(key); else set.delete(key);
    }
    d.settings.pantry = [...set].sort();

    // A standing pantry statement should override a stale per-week tick, or the
    // item would keep reappearing on the week you are currently looking at.
    if (req.body.week) {
      const start = weekStart(req.body.week, d.settings.startOfWeek ?? 0);
      if (d.checked[start]) {
        for (const key of clean) delete d.checked[start][key];
      }
    }
  });

  res.json({ pantry: store.data.settings.pantry });
}));

/* -------------------------------------------------------------- photos -- */

app.post('/api/images', wrap(async (req, res) => {
  res.status(201).json({ url: await images.saveDataUrl(req.body.dataUrl) });
}));

/* ------------------------------------------------------------- backups -- */

app.get('/api/backup', wrap(async (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('content-disposition', `attachment; filename="week-of-meals-${stamp}.json"`);
  res.setHeader('content-type', 'application/json');
  res.send(JSON.stringify(store.data, null, 2));
}));

app.post('/api/restore', wrap(async (req, res) => {
  const incoming = req.body && req.body.data;
  if (!incoming || !Array.isArray(incoming.recipes)) {
    return res.status(400).json({ error: "That file doesn't look like a Week of Meals backup." });
  }
  await store.backup(); // snapshot what is here now, in case the restore was a mistake
  await store.update((d) => {
    d.recipes = incoming.recipes;
    d.plan = incoming.plan || {};
    d.checked = incoming.checked || {};
    d.exports = incoming.exports || [];
    d.settings = { ...d.settings, ...(incoming.settings || {}) };
  });
  res.json({ ok: true, recipes: store.data.recipes.length });
}));

/* ------------------------------------------------------------ settings -- */

app.put('/api/settings', wrap(async (req, res) => {
  await store.update((d) => {
    if (req.body.listName !== undefined) d.settings.listName = String(req.body.listName);
    if (req.body.startOfWeek !== undefined) d.settings.startOfWeek = Number(req.body.startOfWeek) ? 1 : 0;
  });
  res.json(store.data.settings);
}));

/* ------------------------------------------------------------- startup -- */

async function start() {
  await store.ready();
  await store.backup();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n  Meal plan running at http://localhost:${PORT}`);
    console.log(`  Storage: ${kind === 's3' ? describe : `file ${describe}`}`);
      console.log(`  Sign-in: ${process.env.CF_ACCESS_TEAM ? `Cloudflare Access (${process.env.CF_ACCESS_TEAM})` : 'none — do not expose this port'}`);
    console.log(anylist.configured()
      ? '  AnyList: credentials found\n'
      : '  AnyList: not configured (export is disabled until you add credentials to .env)\n');
  });
}

// Only bind a port when started directly. Under Lambda the handler imports
// this module for its `app` and must not open a socket.
if (require.main === module) {
  start().catch((err) => {
    console.error(`\n  Could not start: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { app, store, start, weekStart, weekDates, buildList };
