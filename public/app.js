/* Week of Meals — no build step, no framework, no bundler.
   Three views, one render function each, and event delegation on the shell.
   The whole app is small enough that a virtual DOM would cost more than it
   saves, and this file will still run unchanged in five years. */

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const sheetHost = $('#sheet-host');
const sheetBody = $('#sheet-body');

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/* Who the server says we are. Populated from /api/whoami, which reads the
   verified Cloudflare Access assertion. Null when running unguarded locally. */
const session = { guarded: false, user: null };

const state = {
  tab: 'week',
  pantry: [],
  week: null,
  boot: null,
  list: null,
  search: '',
  tag: null,
};

/* ------------------------------------------------------------- utils -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* Local date parts, never toISOString(). For anyone east of UTC that
   conversion rolls the date back a day and lands you on the wrong week. */
function isoOf(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayOf(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return { name: DAY_NAMES[d.getDay()], full: FULL_DAYS[d.getDay()], num: d.getDate(), month: MONTHS[d.getMonth()] };
}

/* Scrolling is a nicety. It must never be able to throw and take a whole
   screen down with it, so every call goes through here. */
function scrollTo(el, block = 'center') {
  try { el?.scrollIntoView({ behavior: 'smooth', block }); } catch { /* not fatal */ }
}

/**
 * @param {string} message
 * @param {string} kind        'ok' | 'bad'
 * @param {object} [action]    {label, onClick, ms} to offer an undo
 */
function toast(message, kind = 'ok', action = null) {
  const el = $('#toast');
  el.dataset.kind = kind;
  el.innerHTML = '';

  const text = document.createElement('span');
  text.textContent = message;
  el.appendChild(text);

  const life = action ? (action.ms || 5000) : (kind === 'bad' ? 5200 : 2800);

  if (action) {
    const button = document.createElement('button');
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', async () => {
      clearTimeout(toast._t);
      el.hidden = true;
      await action.onClick();
    });
    el.appendChild(button);

    // A countdown bar, so five seconds doesn't have to be guessed at.
    const bar = document.createElement('i');
    bar.className = 'toast-bar';
    bar.style.animationDuration = `${life}ms`;
    el.appendChild(bar);
  }

  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, life);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));

  // Cloudflare Access sits in front of this app, so the browser already holds a
  // session cookie and sends it automatically. A 401 here means that session
  // lapsed; a reload sends us back through Access to pick up a fresh one.
  if (res.status === 401) {
    toast('Your sign-in expired. Reloading…', 'bad');
    setTimeout(() => window.location.reload(), 1200);
    throw new Error(data.error || 'Sign-in expired.');
  }
  if (!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
  return data;
}

/* ------------------------------------------------------------ sheets -- */

function openSheet(html) {
  sheetBody.innerHTML = html;
  sheetHost.hidden = false;
  document.body.style.overflow = 'hidden';
  sheetBody.scrollTop = 0;
  const focusable = sheetBody.querySelector('input, textarea, button');
  if (focusable && focusable.tagName !== 'BUTTON') focusable.focus();
}

function closeSheet() {
  sheetHost.hidden = true;
  sheetBody.innerHTML = '';
  document.body.style.overflow = '';
}

sheetHost.addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) closeSheet();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sheetHost.hidden) closeSheet();
});

/* -------------------------------------------------------------- load -- */

async function loadBoot(week) {
  state.boot = await api(`/bootstrap${week ? `?week=${week}` : ''}`);
  state.week = state.boot.weekOf;
  return state.boot;
}

async function loadList() {
  state.list = await api(`/list?week=${state.week}`);
  state.pantry = state.list.pantry || [];
  const active = state.list.items.filter((i) => i.include).length;
  const badge = $('#list-count');
  badge.textContent = active;
  badge.hidden = active === 0;
  return state.list;
}

async function refresh({ list = true } = {}) {
  await loadBoot(state.week);
  if (list) await loadList();
  render();
}

/* ------------------------------------------------------ view: recipes -- */

function renderRecipes() {
  const all = state.boot.recipes;
  const tags = [...new Set(all.flatMap((r) => r.tags))].sort();
  const q = state.search.trim().toLowerCase();

  const shown = all.filter((r) => {
    if (state.tag && !r.tags.includes(state.tag)) return false;
    if (!q) return true;
    return r.title.toLowerCase().includes(q) || r.tags.some((t) => t.includes(q));
  });

  return `
    <div class="section-head">
      <p class="eyebrow">${all.length} recipe${all.length === 1 ? '' : 's'}</p>
      <button class="btn primary" data-act="new-recipe">Add a recipe</button>
    </div>

    <input class="search" id="search" type="search" placeholder="Search recipes"
           value="${esc(state.search)}" autocomplete="off">

    ${tags.length ? `<div class="tagrow" style="margin-bottom:16px">
      ${tags.map((t) => `<button class="tag on-dark" data-act="tag" data-tag="${esc(t)}"
        aria-pressed="${state.tag === t}">${esc(t)}</button>`).join('')}
    </div>` : ''}

    ${shown.length ? `<div class="recipe-grid">
      ${shown.map((r) => `
        <button class="recipe-card" data-act="open-recipe" data-id="${r.id}">
          <span class="thumb">${r.image
    ? `<img src="${esc(r.image)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('blank')">`
    : ''}<em>${esc(initials(r.title))}</em></span>
          <h3>${esc(r.title)}</h3>
          ${r.tags.length ? `<div class="tagrow">${r.tags.slice(0, 2).map((t) => `<em class="tag" style="font-style:normal">${esc(t)}</em>`).join('')}</div>` : ''}
          <p class="meta">${r.ingredientCount} ingredients${r.time ? ` &middot; ${esc(r.time)}` : ''}</p>
        </button>`).join('')}
    </div>` : `
      <div class="empty">
        <strong>${all.length ? 'Nothing matches that' : 'No recipes yet'}</strong>
        <p>${all.length ? 'Try a different word, or clear the filter.' : 'Paste one in, or import it from a link.'}</p>
        <button class="btn primary" data-act="new-recipe">Add a recipe</button>
      </div>`}
  `;
}

/* --------------------------------------------------------- view: week -- */

function renderWeek() {
  const { dates, plan, today } = state.boot;
  const first = dayOf(dates[0]);
  const last = dayOf(dates[6]);
  const label = first.month === last.month
    ? `${first.month} ${first.num} – ${last.num}`
    : `${first.month} ${first.num} – ${last.month} ${last.num}`;
  const total = dates.reduce((n, d) => n + (plan[d]?.length || 0), 0);

  return `
    <div class="week-nav">
      <button data-act="week" data-dir="-1" aria-label="Previous week">&larr;</button>
      <h2>${esc(label)}</h2>
      <button data-act="week" data-dir="1" aria-label="Next week">&rarr;</button>
    </div>

    <div class="ribbon">
      ${dates.map((d) => {
    const n = plan[d]?.length || 0;
    const info = dayOf(d);
    return `<button class="rib" data-act="jump" data-date="${d}"
              data-filled="${n > 0}" data-today="${d === today}"
              aria-label="${info.name} ${info.num}, ${n} meal${n === 1 ? '' : 's'}">
              <b>${info.name[0]}</b><i>${info.num}</i>
            </button>`;
  }).join('')}
    </div>

    ${total === 0 ? `
      <div class="notice">Tap a day to add a meal. The shopping list builds itself as you go.</div>
      <button class="btn ghost wide" data-act="copy-week" style="margin-bottom:20px">
        Copy a previous week
      </button>` : ''}

    ${dates.map((d) => {
    const info = dayOf(d);
    const meals = plan[d] || [];
    return `
      <section class="day" id="day-${d}" data-today="${d === state.boot.today}">
        <div class="day-head">
          <h3>${info.full}</h3>
          <span class="date">${info.month} ${info.num}</span>
        </div>
        ${meals.map((m) => `
          <div class="meal">
            <span class="meal-title">${esc(m.title)}</span>
            ${scaleChips(m)}
            <button class="mini" data-act="unplan" data-id="${m.id}" aria-label="Remove ${esc(m.title)}">&times;</button>
          </div>`).join('')}
        <button class="add-meal" data-act="pick-recipe" data-date="${d}">+ Add a meal</button>
      </section>`;
  }).join('')}

    ${total ? `<div class="sheet-actions" style="margin-top:22px">
      <button class="btn ghost" data-act="copy-week">Copy a previous week</button>
      <button class="btn ghost" data-act="clear-week">Clear this week</button>
    </div>` : ''}
  `;
}

/* --------------------------------------------------------- view: list -- */

function renderList() {
  const { items, lastExport } = state.list;
  const on = items.filter((i) => i.include);

  if (!items.length) {
    return `<div class="empty">
      <strong>Nothing to buy yet</strong>
      <p>Plan a few meals and the ingredients land here, added up and sorted by aisle.</p>
      <button class="btn primary" data-act="goto" data-tab="week">Go to the week</button>
    </div>`;
  }

  const groups = state.list.aisles
    .map((aisle) => [aisle, items.filter((i) => i.aisle === aisle)])
    .filter(([, rows]) => rows.length);

  return `
    <div class="listbar">
      <span class="count"><b>${on.length}</b> of ${items.length} selected${
  state.pantry.length ? ` &middot; ${state.pantry.length} in pantry` : ''}</span>
      <button class="btn ghost" data-act="copy">Copy</button>
      <button class="btn primary" data-act="export" ${on.length ? '' : 'disabled'}>Send to AnyList</button>
    </div>

    ${lastExport ? `<div class="notice">Last sent ${esc(relative(lastExport.at))} to
      &ldquo;${esc(lastExport.listName)}&rdquo; &middot; ${lastExport.count} item${lastExport.count === 1 ? '' : 's'}.</div>` : ''}

    ${groups.map(([aisle, rows]) => `
      <section class="aisle">
        <div class="aisle-head">
          <p class="eyebrow">${esc(aisle)}</p>
          <button class="tag on-dark" data-act="toggle-aisle" data-aisle="${esc(aisle)}"
            >${rows.every((r) => r.include) ? 'none' : 'all'}</button>
        </div>
        ${rows.map((i) => `
          <div class="line" data-on="${i.include}">
            <button class="check" data-act="toggle" data-key="${esc(i.key)}"
              role="checkbox" aria-checked="${i.include}" aria-label="${esc(i.name)}">
              <svg viewBox="0 0 24 24"><path d="m5 13 4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
            <div>
              <div class="line-main">
                ${i.quantity ? `<span class="qty ${i.splitAmounts ? 'split' : ''}">${esc(i.quantity)}</span>` : ''}
                <span class="line-name">${esc(i.name)}</span>
                ${i.exportedBefore ? '<span class="sent-flag">sent</span>' : ''}
                <button class="pantry-pin ${i.inPantry ? 'on' : ''}"
                        data-act="pantry-toggle" data-key="${esc(i.key)}"
                        title="${i.inPantry ? 'In the pantry — always skipped' : 'Always have this in'}"
                        aria-pressed="${i.inPantry}">${i.inPantry ? 'in pantry' : 'always have'}</button>
              </div>
              <div class="from">
                ${i.recipes.map((r) => `<span><b>${dayOf(r.day).name}</b>${esc(r.title)}</span>`).join('')}
              </div>
              ${i.splitAmounts ? '<p class="line-note">Two kinds of amount, kept apart on purpose.</p>' : ''}
            </div>
          </div>`).join('')}
      </section>`).join('')}
  `;
}

function relative(iso) {
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.round(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/* ------------------------------------------------------------ render -- */

function render() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.setAttribute('aria-selected', t.dataset.tab === state.tab);
  });
  view.innerHTML = state.tab === 'recipes' ? renderRecipes()
    : state.tab === 'list' ? renderList() : renderWeek();

  const search = $('#search');
  if (search) {
    search.addEventListener('input', (e) => {
      state.search = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const next = $('#search');
      next.focus();
      next.setSelectionRange(pos, pos);
    });
  }
}

/* --------------------------------------------------------- recipe UI -- */

async function showRecipe(id) {
  const r = await api(`/recipes/${id}`);
  openSheet(`
    ${r.image ? `<div class="hero"><img src="${esc(r.image)}" alt="${esc(r.title)}"
      onerror="this.closest('.hero').remove()"></div>` : ''}
    <h2>${esc(r.title)}</h2>
    <p class="sub">${[r.time, r.servings].filter(Boolean).map(esc).join(' &middot; ') || 'No timing noted'}</p>

    <button class="btn primary wide cook-cta" data-act="cook" data-id="${r.id}">
      Cook this &mdash; keeps the screen on
    </button>

    <p class="eyebrow on-paper" style="margin-bottom:8px">Ingredients</p>
    <ul class="ing-list">
      ${r.parsed.map((p) => `<li>
        <span class="amt">${esc(p.amount === null ? '' : `${fmt(p.amount)} ${p.unit === 'each' ? '' : p.unit}`.trim())}</span>
        <span>${esc(p.name)}${p.note ? `<em style="color:var(--ink-soft)">, ${esc(p.note)}</em>` : ''}</span>
      </li>`).join('')}
    </ul>

    ${r.steps.length ? `<p class="eyebrow on-paper" style="margin-bottom:8px">Method</p>
      <ol class="step-list">${r.steps.map((s) => `<li><span>${esc(s)}</span></li>`).join('')}</ol>` : ''}

    ${r.notes ? `<div class="notice on-paper">${esc(r.notes)}</div>` : ''}
    ${r.source ? `<p class="sub"><a href="${esc(r.source)}" target="_blank" rel="noopener" style="color:var(--ink-soft)">${esc(r.source.slice(0, 60))}</a></p>` : ''}

    <div class="sheet-actions">
      <button class="btn primary" data-act="plan-this" data-id="${r.id}">Add to a day</button>
      <button class="btn" data-act="edit-recipe" data-id="${r.id}">Edit</button>
      <button class="btn danger" data-act="delete-recipe" data-id="${r.id}">Delete</button>
    </div>
  `);
}

function fmt(n) {
  const glyphs = { 0.125: '⅛', 0.25: '¼', 0.333: '⅓', 0.375: '⅜', 0.5: '½', 0.625: '⅝', 0.667: '⅔', 0.75: '¾', 0.875: '⅞' };
  const whole = Math.floor(n);
  const frac = Math.round((n - whole) * 1000) / 1000;
  if (!frac) return String(whole);
  const key = Object.keys(glyphs).find((k) => Math.abs(Number(k) - frac) < 0.02);
  if (!key) return String(Math.round(n * 100) / 100);
  return whole ? `${whole}${glyphs[key]}` : glyphs[key];
}

function recipeForm(recipe) {
  const r = recipe || { title: '', ingredients: [], steps: [], tags: [], time: '', servings: '', source: '', notes: '' };
  return `
    <h2>${recipe ? 'Edit recipe' : 'Add a recipe'}</h2>
    <p class="sub">One ingredient per line, the way it reads in the recipe.</p>

    ${recipe ? '' : `
      <div class="field">
        <span>Import from a link</span>
        <div style="display:flex;gap:8px">
          <input id="import-url" type="url" placeholder="https://" autocomplete="off">
          <button class="btn" data-act="do-import">Fetch</button>
        </div>
        <p class="hint">Works on most recipe sites. If it doesn't, paste the ingredients in below.</p>
      </div>`}

    <label class="field"><span>Title</span>
      <input id="f-title" value="${esc(r.title)}" placeholder="Sunday roast chicken"></label>

    <div class="field">
      <span>Photo</span>
      <input type="hidden" id="f-image" value="${esc(r.image || '')}">
      <div class="photo-picker" id="photo-picker">
        <div class="photo-preview ${r.image ? '' : 'blank'}" id="photo-preview">
          ${r.image ? `<img src="${esc(r.image)}" alt="">` : '<span>No photo</span>'}
        </div>
        <div class="photo-actions">
          <button class="btn" data-act="pick-image">Choose a photo</button>
          <button class="btn ghost dim" data-act="clear-image">Remove</button>
        </div>
      </div>
      <input type="file" id="f-file" accept="image/*" hidden>
      <p class="hint">Imported recipes bring their own picture. Anything you choose here is
        resized in the browser and kept with the recipe.</p>
    </div>

    <label class="field"><span>Ingredients</span>
      <textarea id="f-ingredients" placeholder="2 cloves garlic, minced&#10;1 lb ground beef&#10;1 can (14 oz) diced tomatoes">${esc((r.ingredients || []).join('\n'))}</textarea></label>

    <label class="field"><span>Method</span>
      <textarea id="f-steps" style="min-height:90px" placeholder="One step per line">${esc((r.steps || []).join('\n'))}</textarea></label>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <label class="field"><span>Time</span><input id="f-time" value="${esc(r.time)}" placeholder="45 min"></label>
      <label class="field"><span>Serves</span><input id="f-servings" value="${esc(r.servings)}" placeholder="4"></label>
    </div>

    <label class="field"><span>Tags</span>
      <input id="f-tags" value="${esc((r.tags || []).join(', '))}" placeholder="weeknight, kid approved"></label>

    <div class="sheet-actions">
      <button class="btn primary" data-act="save-recipe" data-id="${recipe ? recipe.id : ''}">Save recipe</button>
      <button class="btn ghost" data-close style="flex:0 0 auto">Cancel</button>
    </div>
  `;
}

function dayPicker(recipeId) {
  return `
    <h2>Which day?</h2>
    <p class="sub">You can put more than one meal on a day.</p>
    <div class="picker">
      ${state.boot.dates.map((d) => {
    const info = dayOf(d);
    const n = state.boot.plan[d]?.length || 0;
    return `<button data-act="confirm-plan" data-date="${d}" data-id="${recipeId}">
        <span>${info.name}, ${info.month} ${info.num}</span>
        <small>${n ? `${n} planned` : 'free'}</small>
      </button>`;
  }).join('')}
    </div>
  `;
}

function recipePicker(date) {
  const info = dayOf(date);
  return `
    <h2>${info.name}, ${info.month} ${info.num}</h2>
    <p class="sub">Pick something to cook.</p>
    <div class="picker">
      ${state.boot.recipes.map((r) => `
        <button data-act="confirm-plan" data-date="${date}" data-id="${r.id}">
          <span>${esc(r.title)}</span>
          <small>${r.time ? esc(r.time) : `${r.ingredientCount} ing`}</small>
        </button>`).join('')}
    </div>
  `;
}

/* --------------------------------------------------------- export UI -- */

async function exportSheet() {
  const on = state.list.items.filter((i) => i.include);
  const alreadySent = on.filter((i) => i.exportedBefore).length;

  if (!state.boot.anylist.configured) {
    openSheet(`
      <h2>AnyList isn't set up</h2>
      <p class="sub">The server needs your AnyList sign-in before it can add anything.</p>
      <div class="notice on-paper">Create a file called <code>.env</code> next to <code>package.json</code> with
        <code>ANYLIST_EMAIL</code> and <code>ANYLIST_PASSWORD</code>, then restart the server.</div>
      <div class="sheet-actions">
        <button class="btn primary" data-act="copy">Copy the list instead</button>
      </div>`);
    return;
  }

  openSheet(`
    <h2>Send ${on.length} item${on.length === 1 ? '' : 's'}</h2>
    <p class="sub">Loading your lists…</p>
    <div class="picker" id="list-picker"></div>
  `);

  let names;
  try {
    ({ lists: names } = await api('/anylist/lists'));
  } catch (err) {
    openSheet(`
      <h2>Couldn't reach AnyList</h2>
      <p class="sub">${esc(err.message)}</p>
      <div class="notice on-paper">This integration is unofficial, so it can break when AnyList updates.
        The list is still yours — copy it and paste it in by hand.</div>
      <div class="sheet-actions">
        <button class="btn primary" data-act="copy">Copy the list</button>
        <button class="btn ghost" data-act="export" style="flex:0 0 auto">Retry</button>
      </div>`);
    return;
  }

  const preferred = state.boot.settings.listName;
  openSheet(`
    <h2>Send ${on.length} item${on.length === 1 ? '' : 's'}</h2>
    <p class="sub">Choose a list in AnyList.</p>

    <label class="field"><span>List</span>
      <select id="list-name">
        ${names.map((n) => `<option ${n === preferred ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select></label>

    <label class="switch">
      <span>Skip anything already on that list<small>Compares by name, ignoring checked-off items.</small></span>
      <input type="checkbox" id="opt-skip" checked>
    </label>

    <label class="switch">
      <span>Only what hasn't been sent yet<small>${alreadySent} of these went over in an earlier send.</small></span>
      <input type="checkbox" id="opt-new" ${alreadySent ? 'checked' : ''} ${alreadySent ? '' : 'disabled'}>
    </label>

    <div class="sheet-actions" style="margin-top:18px">
      <button class="btn primary" data-act="do-export">Add to AnyList</button>
    </div>
  `);
}

function listAsText() {
  return state.list.items
    .filter((i) => i.include)
    .map((i) => `${i.quantity ? `${i.quantity} ` : ''}${i.name}`)
    .join('\n');
}

/* ------------------------------------------------------------ actions -- */

const actions = {
  async 'goto'(el) { state.tab = el.dataset.tab; render(); },

  async 'tag'(el) {
    state.tag = state.tag === el.dataset.tag ? null : el.dataset.tag;
    render();
  },

  async 'open-recipe'(el) { await showRecipe(el.dataset.id); },

  async 'new-recipe'() { openSheet(recipeForm(null)); },

  async 'edit-recipe'(el) {
    const r = await api(`/recipes/${el.dataset.id}`);
    openSheet(recipeForm(r));
  },

  async 'do-import'(el) {
    const url = $('#import-url').value.trim();
    if (!url) return;
    el.classList.add('busy');
    try {
      const r = await api('/recipes/import', { method: 'POST', body: { url } });
      $('#f-title').value = r.title;
      $('#f-ingredients').value = r.ingredients.join('\n');
      $('#f-steps').value = r.steps.join('\n');
      $('#f-time').value = r.time;
      $('#f-servings').value = r.servings;
      $('#f-tags').value = r.tags.join(', ');
      if (r.image) setFormImage(r.image);
      toast(`Found "${r.title}" — check it over before saving.`);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'save-recipe'(el) {
    const body = {
      title: $('#f-title').value,
      ingredients: $('#f-ingredients').value,
      steps: $('#f-steps').value,
      time: $('#f-time').value,
      servings: $('#f-servings').value,
      tags: $('#f-tags').value,
      image: $('#f-image').value,
    };
    if (!body.title.trim()) { toast('Give it a name first.', 'bad'); return; }

    el.classList.add('busy');
    try {
      const id = el.dataset.id;
      await api(id ? `/recipes/${id}` : '/recipes', { method: id ? 'PUT' : 'POST', body });
      closeSheet();
      await refresh();
      toast(id ? 'Recipe updated.' : 'Recipe saved.');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'delete-recipe'(el) {
    // No confirm dialog: an undo you can actually reach is friendlier than a
    // question you have to answer before you have seen what happens.
    const title = $('#sheet-body h2')?.textContent?.trim() || 'Recipe';
    const { undo } = await api(`/recipes/${el.dataset.id}`, { method: 'DELETE' });
    closeSheet();
    await refresh();

    const planned = undo.placements.length;
    toast(
      `Deleted ${title}${planned ? ` and ${planned} planned meal${planned === 1 ? '' : 's'}` : ''}.`,
      'ok',
      {
        label: 'Undo',
        ms: 6000,
        onClick: async () => {
          await api('/recipes/restore', { method: 'POST', body: undo });
          await refresh();
          toast(`${title} is back.`);
        },
      },
    );
  },

  async 'plan-this'(el) { openSheet(dayPicker(el.dataset.id)); },

  async 'pick-recipe'(el) {
    if (!state.boot.recipes.length) {
      state.tab = 'recipes';
      render();
      openSheet(recipeForm(null));
      return;
    }
    openSheet(recipePicker(el.dataset.date));
  },

  async 'confirm-plan'(el) {
    await api('/plan', { method: 'POST', body: { date: el.dataset.date, recipeId: el.dataset.id } });
    closeSheet();
    state.tab = 'week';
    await refresh();
    scrollTo($(`#day-${el.dataset.date}`));
  },

  async 'unplan'(el) {
    await api(`/plan/${el.dataset.id}`, { method: 'DELETE' });
    await refresh();
  },

  async 'scale'(el) {
    await api(`/plan/${el.dataset.id}`, { method: 'PATCH', body: { scale: Number(el.dataset.scale) } });
    await refresh();
  },

  async 'clear-week'() {
    if (!confirm('Clear every meal from this week?')) return;
    await api('/plan/clear', { method: 'POST', body: { week: state.week } });
    await refresh();
    toast('Week cleared.');
  },

  async 'week'(el) {
    const d = new Date(`${state.week}T12:00:00`);
    d.setDate(d.getDate() + (7 * Number(el.dataset.dir)));
    state.week = isoOf(d);
    await refresh();
  },

  async 'jump'(el) {
    scrollTo($(`#day-${el.dataset.date}`), 'start');
  },

  async 'toggle'(el) {
    const key = el.dataset.key;
    const item = state.list.items.find((i) => i.key === key);
    const next = !item.include;
    item.include = next;
    render();
    await api('/list/include', { method: 'PUT', body: { week: state.week, key, include: next } });
    await loadList();
    render();
  },

  async 'toggle-aisle'(el) {
    const aisle = el.dataset.aisle;
    const rows = state.list.items.filter((i) => i.aisle === aisle);
    const include = !rows.every((r) => r.include);
    rows.forEach((r) => { r.include = include; });
    render();
    await api('/list/include', { method: 'PUT', body: { week: state.week, keys: rows.map((r) => r.key), include } });
    await loadList();
    render();
  },

  async 'copy'() {
    const text = listAsText();
    try {
      await navigator.clipboard.writeText(text);
      toast('Shopping list copied.');
    } catch {
      openSheet(`<h2>Copy this</h2><label class="field"><span>Shopping list</span>
        <textarea style="min-height:260px">${esc(text)}</textarea></label>`);
    }
  },

  async 'export'() { await exportSheet(); },

  async 'do-export'(el) {
    el.classList.add('busy');
    try {
      const result = await api('/anylist/export', {
        method: 'POST',
        body: {
          week: state.week,
          listName: $('#list-name').value,
          skipExisting: $('#opt-skip').checked,
          onlyNew: $('#opt-new').checked,
        },
      });
      closeSheet();
      await refresh();
      const skipped = result.skipped.length ? `, ${result.skipped.length} already there` : '';
      toast(`Added ${result.added.length} to ${result.listName}${skipped}.`);
    } catch (err) {
      el.classList.remove('busy');
      toast(err.message, 'bad');
    }
  },

  async 'settings'() {
    openSheet(`
      <h2>Settings</h2>
      <p class="sub">Stored on the server, shared by everyone at home.</p>

      <label class="switch">
        <span>Start the week on Monday<small>Otherwise it starts on Sunday.</small></span>
        <input type="checkbox" id="opt-monday" ${state.boot.settings.startOfWeek === 1 ? 'checked' : ''}>
      </label>

      <div class="notice on-paper" style="margin-top:16px">
        AnyList: ${state.boot.anylist.configured
    ? `connected${state.boot.settings.listName ? `, sending to &ldquo;${esc(state.boot.settings.listName)}&rdquo;` : ''}`
    : 'not set up — add credentials to <code>.env</code> and restart'}
      </div>

      ${session.user ? `<div class="whoami">
        <span>Signed in as ${esc(session.user.email)} via Cloudflare Access</span>
      </div>` : ''}

      <p class="eyebrow on-paper" style="margin:22px 0 8px">Kitchen</p>
      <div class="sheet-actions">
        <button class="btn wide" data-act="pantry-open">Pantry${
  state.pantry.length ? ` &middot; ${state.pantry.length}` : ''}</button>
      </div>

      <p class="eyebrow on-paper" style="margin:22px 0 8px">Your data</p>
      <div class="notice on-paper">Recipes and meal plans are saved on the server the moment you
        change them, so nothing needs re-entering. This downloads a copy you can keep somewhere else.</div>
      <div class="sheet-actions">
        <button class="btn" data-act="backup">Download a backup</button>
        <button class="btn ghost dim" data-act="restore">Restore</button>
      </div>
      <input type="file" id="f-restore" accept="application/json,.json" hidden>

      <div class="sheet-actions" style="margin-top:20px">
        <button class="btn primary" data-act="save-settings">Save</button>
      </div>`);
  },

  async 'save-settings'() {
    await api('/settings', { method: 'PUT', body: { startOfWeek: $('#opt-monday').checked ? 1 : 0 } });
    closeSheet();
    state.week = null;
    await refresh();
    toast('Settings saved.');
  },
};

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  try {
    await fn(el);
  } catch (err) {
    toast(err.message, 'bad');
  }
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    render();
  });
});

$('#btn-settings').addEventListener('click', () => actions.settings());

/* -------------------------------------------------------------- boot -- */

(async () => {
  try {
    // Whoever reached this page has already been through Access. This only asks
    // the server to name them, so Settings can show it.
    try {
      const who = await fetch('/api/whoami').then((r) => r.json());
      session.guarded = Boolean(who.authRequired);
      session.user = who.user || null;
    } catch { /* not fatal; the app works without knowing your name */ }

    await loadBoot();
    await loadList();
    state.tab = state.boot.recipes.length ? 'week' : 'recipes';
    render();
  } catch (err) {
    view.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>
      <p>${esc(err.message)}</p></div>`;
  }
})();

/* ============================================================ cook mode ==
   A full-screen, hands-free view for actually standing at the stove.

   The screen must not sleep mid-recipe. Two mechanisms, because one of them
   is unavailable in exactly the setup this app is built for:

     1. The Wake Lock API, which is the proper answer but requires a secure
        context. Opening the app at http://192.168.1.x on the home wifi is
        NOT a secure context, so Wake Lock silently refuses there.
     2. A muted looping video, which browsers treat as "something is playing,
        keep the screen up" and which works fine over plain http.

   We ask for the lock, and fall back to the video when it is refused. The
   badge in the header says which one is holding, so if the screen ever does
   dim you know why rather than guessing.
*/

const cook = {
  recipe: null,
  step: 0,
  done: new Set(),
  lock: null,
  mode: 'off',
};

async function keepAwakeOn() {
  if ('wakeLock' in navigator && window.isSecureContext) {
    try {
      cook.lock = await navigator.wakeLock.request('screen');
      cook.mode = 'lock';
      cook.lock.addEventListener('release', () => {
        if (cook.mode === 'lock') cook.mode = 'idle';
        paintAwakeBadge();
      });
      paintAwakeBadge();
      return;
    } catch { /* refused; fall through to the video */ }
  }
  const video = $('#nosleep');
  try {
    await video.play();
    cook.mode = 'video';
  } catch {
    cook.mode = 'off';
  }
  paintAwakeBadge();
}

async function keepAwakeOff() {
  try { await cook.lock?.release(); } catch { /* already gone */ }
  cook.lock = null;
  const video = $('#nosleep');
  if (video) { video.pause(); video.currentTime = 0; }
  cook.mode = 'off';
}

function paintAwakeBadge() {
  const badge = $('#awake-badge');
  if (!badge) return;
  const label = {
    lock: 'Screen stays on',
    video: 'Screen stays on',
    idle: 'Tap to keep awake',
    off: 'Screen may sleep',
  }[cook.mode] || '';
  badge.textContent = label;
  badge.dataset.mode = cook.mode;
}

/* Re-acquire after the phone locks, a call comes in, or you switch apps. */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !$('#cook').hidden) keepAwakeOn();
});

async function openCook(id) {
  cook.recipe = await api(`/recipes/${id}`);
  cook.step = 0;
  cook.done = new Set();
  $('#cook').hidden = false;
  document.body.style.overflow = 'hidden';
  closeSheet();
  renderCook();
  await keepAwakeOn();
}

async function closeCook() {
  await keepAwakeOff();
  $('#cook').hidden = true;
  $('#cook-body').innerHTML = '';
  document.body.style.overflow = '';
  cook.recipe = null;
}

function renderCook() {
  const r = cook.recipe;
  if (!r) return;
  const steps = r.steps.length ? r.steps : ['This recipe has no method saved. The ingredients are above.'];
  cook.step = Math.max(0, Math.min(cook.step, steps.length - 1));

  $('#cook-title').textContent = r.title;

  $('#cook-body').innerHTML = `
    <section class="cook-ing">
      <p class="eyebrow">Ingredients &middot; tap to cross off</p>
      <ul>
        ${r.parsed.map((p, i) => `
          <li data-act="cook-ing" data-i="${i}" class="${cook.done.has(`i${i}`) ? 'struck' : ''}">
            <span class="amt">${esc(p.amount === null ? '' : `${fmt(p.amount)} ${p.unit === 'each' ? '' : p.unit}`.trim())}</span>
            <span>${esc(p.name)}${p.note ? `<em>, ${esc(p.note)}</em>` : ''}</span>
          </li>`).join('')}
      </ul>
    </section>

    <section class="cook-steps">
      <p class="eyebrow">Method</p>
      ${steps.map((text, i) => `
        <article class="cook-step ${i === cook.step ? 'now' : ''} ${cook.done.has(`s${i}`) ? 'struck' : ''}"
                 id="cs-${i}" data-act="cook-goto" data-i="${i}">
          <b>${i + 1}</b>
          <p>${esc(text)}</p>
        </article>`).join('')}
    </section>
  `;

  $('#cook-pos').textContent = `${cook.step + 1} / ${steps.length}`;
  $('#cook-prev').disabled = cook.step === 0;
  $('#cook-next').textContent = cook.step === steps.length - 1 ? 'Done' : 'Next step';

  scrollTo($(`#cs-${cook.step}`));
  paintAwakeBadge();
}

/* --------------------------------------------------------- image helper -- */

function initials(title) {
  return String(title || '?').replace(/[^A-Za-z ]/g, '').trim().split(/\s+/)
    .slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}

function setFormImage(url) {
  $('#f-image').value = url;
  const preview = $('#photo-preview');
  if (!preview) return;
  preview.classList.toggle('blank', !url);
  preview.innerHTML = url ? `<img src="${esc(url)}" alt="">` : '<span>No photo</span>';
}

/** Resize in the browser so the server never needs an image library. */
async function shrinkImage(file, max = 1000, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', quality);
}

/* --------------------------------------------------------- cook actions -- */

Object.assign(actions, {
  async cook(el) { await openCook(el.dataset.id); },
  async 'cook-close'() { await closeCook(); },

  async 'cook-goto'(el) { cook.step = Number(el.dataset.i); renderCook(); },

  async 'cook-ing'(el) {
    const key = `i${el.dataset.i}`;
    if (cook.done.has(key)) cook.done.delete(key); else cook.done.add(key);
    el.classList.toggle('struck');
  },

  async 'cook-prev'() { cook.step -= 1; renderCook(); },

  async 'cook-next'() {
    const total = Math.max(1, cook.recipe.steps.length);
    cook.done.add(`s${cook.step}`);
    if (cook.step >= total - 1) { await closeCook(); toast('Enjoy.'); return; }
    cook.step += 1;
    renderCook();
  },

  async 'cook-awake'() { await keepAwakeOn(); },

  async 'pick-image'() { $('#f-file').click(); },

  async 'clear-image'() { setFormImage(''); },

  async backup() { window.location.href = '/api/backup'; },

  async restore() { $('#f-restore').click(); },
});

/* ------------------------------------------------------- file listeners -- */

document.addEventListener('change', async (e) => {
  if (e.target.id === 'f-file') {
    const file = e.target.files[0];
    if (!file) return;
    try {
      toast('Preparing the photo…');
      const dataUrl = await shrinkImage(file);
      const { url } = await api('/images', { method: 'POST', body: { dataUrl } });
      setFormImage(url);
      toast('Photo added.');
    } catch (err) {
      toast(err.message || 'That photo could not be read.', 'bad');
    }
    e.target.value = '';
  }

  if (e.target.id === 'f-restore') {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!confirm(`Replace everything with this backup? It has ${data.recipes?.length ?? 0} recipes.`)) return;
      const out = await api('/restore', { method: 'POST', body: { data } });
      closeSheet();
      state.week = null;
      await refresh();
      toast(`Restored ${out.recipes} recipes.`);
    } catch (err) {
      toast(err.message || 'That file could not be read.', 'bad');
    }
    e.target.value = '';
  }
});

document.addEventListener('keydown', (e) => {
  if ($('#cook').hidden) return;
  if (e.key === 'Escape') closeCook();
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); actions['cook-next'](); }
  if (e.key === 'ArrowLeft' && cook.step > 0) actions['cook-prev']();
});

/* ================================================== sprint additions ==== */

/**
 * Batch-size chips.
 *
 * The three presets cover most weeknights, so they stay one tap away. Anything
 * else — cooking for nine, halving a recipe — goes through the custom button
 * rather than forcing the nearest preset and quietly getting the shopping list
 * wrong.
 */
function scaleChips(meal) {
  const current = Number(meal.scale) || 1;
  const presets = [1, 1.5, 2];
  const custom = !presets.includes(current);

  return `${presets.map((n) => `<button class="scale" data-act="scale" data-id="${meal.id}"
      data-scale="${n}" data-on="${current === n}"
      aria-label="Cook ${n} times the recipe">&times;${n}</button>`).join('')}
    <button class="scale custom" data-act="scale-custom" data-id="${meal.id}"
      data-on="${custom}" aria-label="Cook a custom amount"
      >${custom ? `&times;${fmt(current)}` : '&hellip;'}</button>`;
}

/** Pull a serving count out of "4 servings", "Serves 6-8", "makes 12". */
function servingsOf(text) {
  const m = String(text || '').match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function customScaleSheet(meal, recipe) {
  const base = servingsOf(recipe && recipe.servings);
  const current = Number(meal.scale) || 1;
  return `
    <h2>How much of it?</h2>
    <p class="sub">${esc(recipe ? recipe.title : 'This meal')}${base ? ` &middot; recipe serves ${base}` : ''}</p>

    <div class="scale-grid">
      ${[0.5, 1, 1.5, 2, 2.5, 3, 4, 6].map((n) => `
        <button class="btn ${n === current ? 'primary' : ''}" data-act="scale-pick"
          data-id="${meal.id}" data-scale="${n}">&times;${fmt(n)}${
  base ? `<small>${Math.round(base * n)}</small>` : ''}</button>`).join('')}
    </div>

    <label class="field" style="margin-top:18px"><span>Or a number of your own</span>
      <input id="scale-input" type="number" inputmode="decimal" min="0.25" max="20" step="0.25"
             value="${current}"></label>
    ${base ? `<p class="hint" id="scale-hint">Serves about ${Math.round(base * current)}.</p>` : ''}

    <div class="sheet-actions" style="margin-top:14px">
      <button class="btn primary" data-act="scale-save" data-id="${meal.id}">Save</button>
      <button class="btn ghost" data-close style="flex:0 0 auto">Cancel</button>
    </div>
  `;
}

function copyWeekSheet(weeks) {
  if (!weeks.length) {
    return `
      <h2>Nothing to copy yet</h2>
      <p class="sub">No meals were planned in the last eight weeks.</p>
      <div class="sheet-actions"><button class="btn ghost wide" data-close>Close</button></div>`;
  }
  return `
    <h2>Copy a previous week</h2>
    <p class="sub">The meals are copied, not moved — the week you take them from is left alone.</p>
    <div class="picker">
      ${weeks.map((w) => {
    const first = dayOf(w.weekOf);
    const last = dayOf(isoOf(new Date(new Date(`${w.weekOf}T12:00:00`).getTime() + (6 * 86400000))));
    const label = first.month === last.month
      ? `${first.month} ${first.num} – ${last.num}`
      : `${first.month} ${first.num} – ${last.month} ${last.num}`;
    return `<button data-act="copy-week-pick" data-from="${w.weekOf}">
        <span>${label}</span>
        <small>${w.meals} meal${w.meals === 1 ? '' : 's'}</small>
      </button>`;
  }).join('')}
    </div>
    <label class="switch" style="margin-top:16px">
      <span>Replace what is already there<small>Off by default, so a copy adds alongside anything you have planned.</small></span>
      <input type="checkbox" id="copy-replace">
    </label>
  `;
}

function pantrySheet() {
  const items = state.pantry.slice().sort();
  return `
    <h2>Pantry</h2>
    <p class="sub">${items.length
    ? `${items.length} thing${items.length === 1 ? '' : 's'} you always have in`
    : 'Nothing here yet'}</p>

    <div class="notice on-paper">Anything listed here is left off the shopping list
      every week, so you stop unticking the same olive oil. Tap <b>always have</b> on
      a list item to add it.</div>

    ${items.length ? `<ul class="pantry-list">
      ${items.map((key) => `<li>
        <span>${esc(key)}</span>
        <button class="btn ghost dim" data-act="pantry-remove" data-key="${esc(key)}">Remove</button>
      </li>`).join('')}
    </ul>` : ''}

    <div class="sheet-actions">
      <button class="btn ghost wide" data-close>Done</button>
    </div>
  `;
}

Object.assign(actions, {
  /* ------------------------------------------------------- custom scale -- */
  async 'scale-custom'(el) {
    const meal = findMeal(el.dataset.id);
    const recipe = meal ? await api(`/recipes/${meal.recipeId}`).catch(() => null) : null;
    openSheet(customScaleSheet(meal || { id: el.dataset.id, scale: 1 }, recipe));

    const input = $('#scale-input');
    const hint = $('#scale-hint');
    const base = servingsOf(recipe && recipe.servings);
    if (input && hint && base) {
      input.addEventListener('input', () => {
        const n = Number(input.value);
        hint.textContent = n > 0 ? `Serves about ${Math.round(base * n)}.` : '';
      });
    }
  },

  async 'scale-pick'(el) {
    await api(`/plan/${el.dataset.id}`, { method: 'PATCH', body: { scale: Number(el.dataset.scale) } });
    closeSheet();
    await refresh();
  },

  async 'scale-save'(el) {
    const value = Number($('#scale-input').value);
    if (!(value > 0)) { toast('Give it a number above zero.', 'bad'); return; }
    await api(`/plan/${el.dataset.id}`, { method: 'PATCH', body: { scale: value } });
    closeSheet();
    await refresh();
    toast(`Scaled to ×${fmt(Math.round(Math.min(value, 20) * 100) / 100)}.`);
  },

  /* ---------------------------------------------------------- copy week -- */
  async 'copy-week'() {
    const { weeks } = await api(`/plan/weeks?week=${state.week}`);
    openSheet(copyWeekSheet(weeks));
  },

  async 'copy-week-pick'(el) {
    const replace = $('#copy-replace')?.checked === true;
    const out = await api('/plan/copy', {
      method: 'POST',
      body: { from: el.dataset.from, to: state.week, replace },
    });
    closeSheet();
    await refresh();
    toast(`Copied ${out.copied} meal${out.copied === 1 ? '' : 's'} across.`);
  },

  /* ------------------------------------------------------------- pantry -- */
  async 'pantry-toggle'(el) {
    const key = el.dataset.key;
    const adding = el.getAttribute('aria-pressed') !== 'true';
    await api('/pantry', {
      method: 'PUT',
      body: { key, inPantry: adding, week: state.week },
    });
    await loadList();
    render();
    toast(adding ? `"${key}" is in the pantry now.` : `"${key}" is back on the list.`, 'ok', {
      label: 'Undo',
      onClick: async () => {
        await api('/pantry', { method: 'PUT', body: { key, inPantry: !adding, week: state.week } });
        await loadList();
        render();
      },
    });
  },

  async 'pantry-open'() {
    const { pantry } = await api('/pantry');
    state.pantry = pantry;
    openSheet(pantrySheet());
  },

  async 'pantry-remove'(el) {
    await api('/pantry', { method: 'PUT', body: { key: el.dataset.key, inPantry: false, week: state.week } });
    const { pantry } = await api('/pantry');
    state.pantry = pantry;
    openSheet(pantrySheet());
    await loadList();
  },
});

/** The meal objects live in the bootstrap payload, keyed by date. */
function findMeal(mealId) {
  for (const meals of Object.values(state.boot.plan || {})) {
    const found = meals.find((m) => m.id === mealId);
    if (found) return found;
  }
  return null;
}
