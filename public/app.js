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
   verified Cloudflare Access assertion. Null when running unguarded locally.

   `households` is only ever the ones this person is actually in. Most people
   are in one and the interface never mentions the concept to them; the switcher
   appears only when there are two. */
const session = {
  guarded: false, user: null, households: [], household: null,
};

const state = {
  tab: 'week',
  pantry: [],
  week: null,
  boot: null,
  list: null,
  search: '',
  tag: null,
  /* Which category folder is open. null is the top level, where the folders
     themselves are what you see. '*' is "All recipes" — one flat grid. */
  category: null,
  /* Poll being composed: null means "every recipe is on the ballot", a Set
     means the admin is picking a shortlist. */
  pollShortlist: null,
  pollDropped: null,
  poll: null,
};

/* ------------------------------------------------------------- utils -- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/**
 * Photo URL for the household currently being viewed.
 *
 * An <img> cannot carry the x-household header the API calls use, so when
 * somebody is looking at their second household the id has to travel in the
 * query string or the photos would be looked up in the wrong directory and
 * come back 404.
 */
function imageUrl(stored) {
  const url = String(stored || '');
  if (!url.startsWith('/images/')) return url; // a remote URL we failed to cache
  if (!session.household || session.households.length < 2) return url;
  return `${url}?household=${encodeURIComponent(session.household.id)}`;
}

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

/**
 * An error whose explanation is already on screen.
 *
 * Some failures paint a whole screen of their own — "you are not in a
 * household", "we cannot confirm your sign-in" — and then still have to throw,
 * so the caller stops. Without a marker the caller's own catch paints a generic
 * "can't reach the server" over the specific thing the person needed to read.
 */
function handled(message) {
  const err = new Error(message);
  err.handled = true;
  return err;
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    headers: {
      'content-type': 'application/json',
      // Only sent by someone in more than one household; the server ignores an
      // id you are not a member of rather than obeying it.
      ...(session.household && session.households.length > 1
        ? { 'x-household': session.household.id } : {}),
      ...(options.headers || {}),
    },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));

  // Past Access but in nobody's kitchen. Not an error to retry — a state that
  // needs explaining, so it takes over the screen rather than flashing a toast.
  if (res.status === 403 && data.code === 'NO_HOUSEHOLD') {
    renderNoHousehold();
    throw handled(data.error || 'You are not in a household yet.');
  }

  /*
   * Cloudflare Access sits in front of this app, so the browser normally holds
   * a session cookie and sends it automatically. A 401 means that session
   * lapsed, and a reload usually sends us back through Access for a fresh one.
   *
   * "Usually" is why this counts. If the page itself is being served from a
   * cache — Cloudflare's or the browser's — the reload never reaches Access,
   * never obtains a cookie, and comes straight back to this same 401. The old
   * code reloaded unconditionally, so that situation span forever: a toast
   * saying the sign-in expired, a reload, the same toast, for as long as you
   * left the tab open.
   *
   * One automatic attempt, remembered for this tab only, then we stop and say
   * something a person can act on.
   */
  if (res.status === 401) {
    const KEY = 'wom:reauth-attempted';
    let alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(KEY) === '1'; } catch { /* private mode */ }

    if (alreadyTried) {
      renderSignInStalled(data);
      throw handled(data.error || 'Sign-in expired.');
    }

    try { sessionStorage.setItem(KEY, '1'); } catch { /* private mode */ }
    toast('Your sign-in expired. Reloading…', 'bad');
    // Cache-busted so the reload cannot be answered by the copy that got us
    // into this state — which is the whole reason the loop was possible.
    setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.set('reauth', Date.now().toString(36));
      window.location.replace(url.toString());
    }, 1200);
    throw handled(data.error || 'Sign-in expired.');
  }

  // Any successful call means the session is good; forget the attempt so a
  // genuine expiry weeks from now still gets its one automatic retry.
  if (res.ok) {
    try { sessionStorage.removeItem('wom:reauth-attempted'); } catch { /* ignore */ }
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

/**
 * The poll for the week on screen, if there is one.
 *
 * Never fatal: polls are an extra, and a household with sign-in switched off
 * has none. A failure here must not stop the week from rendering.
 */
async function loadPoll() {
  try {
    const { polls: found, canRun } = await api(`/polls?week=${state.week}`);
    state.pollCanRun = Boolean(canRun);
    // The open one if there is one, otherwise the most recent closed one.
    state.poll = found.find((p) => p.status === 'open') || found[found.length - 1] || null;
  } catch {
    state.poll = null;
    state.pollCanRun = false;
  }
}

async function refresh({ list = true } = {}) {
  await loadBoot(state.week);
  if (list) await loadList();
  await loadPoll();
  render();
}

/* ------------------------------------------------------ view: recipes -- */

/**
 * The recipes tab is a two-level browser, not one long grid.
 *
 * Level one is the shelves — Dinner, Dessert, Side — because forty recipes in a
 * single scroll is a pile, and "what are we having for pudding" is a question
 * about one shelf. Level two is the recipes on the shelf you opened.
 *
 * Search escapes the hierarchy rather than filtering inside it: when you are
 * looking for a name you do not want to remember which shelf you filed it on.
 * Typing at the top level searches everything; typing inside a folder searches
 * that folder, and says so.
 */
function renderRecipes() {
  const all = state.boot.recipes;
  const q = state.search.trim().toLowerCase();
  const open = state.category;

  const head = `
    <div class="section-head">
      <p class="eyebrow">${all.length} recipe${all.length === 1 ? '' : 's'}</p>
      <button class="btn primary" data-act="new-recipe">Add a recipe</button>
    </div>

    <input class="search" id="search" type="search"
           placeholder="${open && open !== '*' ? `Search ${esc(labelOfCategory(open))}` : 'Search recipes'}"
           value="${esc(state.search)}" autocomplete="off">`;

  // The top level, at rest: folders only.
  if (!open && !q) return `${head}${renderCategoryIndex(all)}`;

  const inFolder = open && open !== '*' ? all.filter((r) => r.category === open) : all;
  const tags = [...new Set(inFolder.flatMap((r) => r.tags))].sort();

  const shown = inFolder.filter((r) => {
    if (state.tag && !r.tags.includes(state.tag)) return false;
    if (!q) return true;
    return r.title.toLowerCase().includes(q) || r.tags.some((t) => t.includes(q));
  });

  const crumb = `
    <nav class="crumbs">
      <button class="crumb" data-act="close-category">All recipes</button>
      ${open && open !== '*'
    ? `<span class="crumb-sep">/</span><span class="crumb here">${esc(labelOfCategory(open))}</span>`
    : ''}
      ${q ? `<span class="crumb-count">${shown.length} match${shown.length === 1 ? '' : 'es'}</span>` : ''}
    </nav>`;

  return `
    ${head}
    ${crumb}

    ${tags.length ? `<div class="tagrow" style="margin-bottom:16px">
      ${tags.map((t) => `<button class="tag on-dark" data-act="tag" data-tag="${esc(t)}"
        aria-pressed="${state.tag === t}">${esc(t)}</button>`).join('')}
    </div>` : ''}

    ${shown.length ? `<div class="recipe-grid">
      ${shown.map((r) => `
        <button class="recipe-card" data-act="open-recipe" data-id="${r.id}">
          <span class="thumb">${r.image
    ? `<img src="${esc(imageUrl(r.image))}" alt="" loading="lazy" onerror="this.parentNode.classList.add('blank')">`
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

/** Display name for a category key, using whatever the server called it. */
function labelOfCategory(key) {
  const known = (state.boot.categories || []).find((c) => c.key === key);
  if (known) return known.label;
  return String(key).replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/**
 * The shelves themselves: one tile each, plus a way to see the lot.
 *
 * Each tile shows the first few recipes on that shelf rather than just a count.
 * A row of bare labels told you nothing you could not guess, and on a wide
 * screen it left the window almost empty — which is the opposite of what this
 * page is for. The peek makes the tile worth its space and makes the shelf
 * recognisable before you open it.
 */
function renderCategoryIndex(all) {
  const folders = state.boot.categories || [];

  if (!all.length) {
    return `<div class="empty">
      <strong>No recipes yet</strong>
      <p>Paste one in, or import it from a link.</p>
      <button class="btn primary" data-act="new-recipe">Add a recipe</button>
    </div>`;
  }

  const tile = (key, label, count, members) => `
    <button class="folder" data-act="open-category" data-category="${esc(key)}">
      <span class="folder-peek">
        ${members.slice(0, 3).map((r) => `<span class="peek">${r.image
    ? `<img src="${esc(imageUrl(r.image))}" alt="" loading="lazy" onerror="this.parentNode.classList.add('blank')">`
    : ''}<em>${esc(initials(r.title))}</em></span>`).join('')}
        ${count > 3 ? `<span class="peek more">+${count - 3}</span>` : ''}
      </span>
      <span class="folder-head">
        ${FOLDER_ICON}
        <span class="folder-name">${esc(label)}</span>
        <span class="folder-count">${count}</span>
      </span>
    </button>`;

  return `
    <div class="folder-grid">
      ${tile('*', 'All recipes', all.length, all)}
      ${folders.map((c) => tile(
    c.key, c.label, c.count, all.filter((r) => r.category === c.key),
  )).join('')}
    </div>`;
}

const FOLDER_ICON = '<svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true">'
  + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>';

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

    ${pollBanner()}

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
        ${meals.map((m) => {
      /* A planned meal is a way into its recipe. Standing in the kitchen on the
         day, the week is where you already are, and having to go and find the
         thing again in the Recipes tab is a silly walk. The title opens the
         recipe sheet, whose primary button is "Cook this".

         A meal whose recipe has been deleted stays plain text: there is
         nothing to open, and a button that does nothing is worse than none. */
      const alive = state.boot.recipes.some((r) => r.id === m.recipeId);
      return `
          <div class="meal">
            ${alive
    ? `<button class="meal-title" data-act="open-recipe" data-id="${esc(m.recipeId)}"
                 aria-label="Open ${esc(m.title)}">${esc(m.title)}</button>`
    : `<span class="meal-title gone">${esc(m.title)}</span>`}
            ${scaleChips(m)}
            <button class="mini" data-act="unplan" data-id="${m.id}" aria-label="Remove ${esc(m.title)}">&times;</button>
          </div>`;
    }).join('')}
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

    <div class="list-foot">
      <button class="btn ghost" data-act="clear-list" ${on.length ? '' : 'disabled'}>
        Clear the list
      </button>
      <p class="hint">Unticks everything here, for when the shopping is done.
        Nothing in AnyList changes, and the meals stay on the week.</p>
    </div>
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

  // Deleting or re-filing the last recipe on a shelf takes the shelf with it.
  // Without this you are left standing in a folder that no longer exists.
  if (state.category && state.category !== '*'
      && !(state.boot.categories || []).some((c) => c.key === state.category)) {
    state.category = null;
  }

  /* The recipes tab is a grid and wants the whole window; the week and the
     shopping list are columns and want to stay a column. CSS reads this.

     Deliberately `data-view` rather than `data-tab`: the tab buttons already
     carry data-tab, and putting the same attribute on <body> makes every
     `[data-tab="week"]` query match the whole document first. That is a trap
     for anything selecting a tab — a test, a script, a future feature — and it
     costs nothing to avoid. */
  document.body.dataset.view = state.tab;

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

/**
 * Signed in, and in nobody's kitchen.
 *
 * Cloudflare Access let them through, so they are not an intruder — they are
 * somebody the household list has not caught up with. That is an administrative
 * fact, not a failure, so it is worded as one and gives whoever runs the server
 * the exact thing they need to fix it: the address to add.
 */
/**
 * The first thing a new person sees: start a household, or join one.
 *
 * This used to be a dead end telling you to go and find whoever runs the
 * server. Households govern themselves now, so the two ways in are both here,
 * and neither needs anybody's help at a terminal.
 */
function renderNoHousehold() {
  // Somebody already in a household came here to start a second one, so this is
  // an errand rather than a wall: the tabs stay live and there is a way back.
  const hasOne = Boolean(session.household);
  document.body.dataset.view = 'none';
  view.innerHTML = `
    <div class="onboard">
      <p class="eyebrow">${hasOne ? 'Another household' : 'Welcome'}</p>
      <h2>${hasOne ? 'Start or join another' : 'Set up your kitchen'}</h2>
      <p class="sub">Recipes, the week's plan and the shopping list all belong to a
      household. Everyone in one shares them${session.user
    ? `. You're signed in as <strong>${esc(session.user.email)}</strong>.` : '.'}</p>

      <div class="onboard-card">
        <h3>Start a household</h3>
        <p>For your own kitchen. You'll be able to invite whoever you cook with.</p>
        <label class="field"><span>What to call it</span>
          <input id="new-household" placeholder="The Smiths" maxlength="60" autocomplete="off"></label>
        <button class="btn primary wide" data-act="create-household">Create it</button>
      </div>

      <div class="onboard-card">
        <h3>Join one</h3>
        <p>If somebody has sent you a code, type it here.</p>
        <label class="field"><span>Invite code</span>
          <input id="join-code" placeholder="ABCD-EFGH" maxlength="9"
                 autocomplete="off" autocapitalize="characters" spellcheck="false"></label>
        <button class="btn wide" data-act="join-household">Join</button>
      </div>

      ${hasOne ? `<div class="sheet-actions" style="justify-content:center">
        <button class="btn ghost" data-act="onboard-cancel">Back to ${esc(session.household.name)}</button>
      </div>` : ''}
    </div>`;

  // With no household nothing below is reachable, and leaving the tabs live
  // only invites a second failed call.
  document.querySelectorAll('.tab').forEach((t) => { t.disabled = !hasOne; });
}

/** Back to a working app once a household exists. */
async function enterHousehold(household, message) {
  session.households = [...session.households.filter((h) => h.id !== household.id), {
    id: household.id, name: household.name, isAdmin: household.isAdmin,
  }];
  session.household = { id: household.id, name: household.name };

  document.querySelectorAll('.tab').forEach((t) => { t.disabled = false; });
  state.week = null;
  state.category = null;
  state.tab = 'recipes';
  await refresh();
  toast(message);
}

/*
 * Why a sign-in was refused, in words, per code from the server.
 *
 * The server distinguishes a dozen causes and says which; the first version of
 * this screen threw that away and asserted "probably a cache" instead. When the
 * cause was something else entirely — a mismatched application id, a clock, an
 * origin that cannot reach Cloudflare — the screen confidently described the
 * wrong problem and there was no way to find the right one from the browser.
 * Never discard a specific diagnosis in favour of a guess.
 */
const AUTH_CAUSES = {
  NO_TOKEN: 'The browser sent no Cloudflare Access sign-in at all. Either the page '
    + 'was served from a cache without going through Access, or the CF_Authorization '
    + 'cookie is missing for this hostname.',
  BAD_AUD: 'The sign-in is valid, but it was issued for a different Access '
    + 'application. CF_ACCESS_AUD on the server does not match the Application '
    + 'Audience tag of the Access app in front of it.',
  BAD_ISS: 'The sign-in came from a different Cloudflare team than CF_ACCESS_TEAM '
    + 'on the server.',
  BAD_KID: 'The sign-in was not signed by a key this team publishes — again usually '
    + 'CF_ACCESS_TEAM pointing at the wrong team.',
  BAD_SIGNATURE: 'The signature did not verify. Treat this as a real failure rather '
    + 'than a configuration slip.',
  EXPIRED: 'The sign-in has genuinely expired — or the server\'s clock is wrong, '
    + 'which looks identical from here.',
  NOT_YET: 'The sign-in is not valid yet, which almost always means the server\'s '
    + 'clock is behind.',
  NO_EMAIL: 'The sign-in carries no email address, so there is nobody to look up.',
  NO_TEAM: 'The server has no CF_ACCESS_TEAM configured.',
  NO_AUD: 'The server has no CF_ACCESS_AUD configured.',
  MALFORMED: 'The sign-in was not a well-formed token.',
};

/**
 * The reload did not fix it, so stop reloading and say what went wrong.
 *
 * A cached page is one cause — the browser runs app.js from cache, so a reload
 * is answered locally and never bounces through Access — but it is only one,
 * and the button below is only a fix for that one. So the server's own reason
 * leads, and the cache remedy is offered as what it is rather than as the
 * diagnosis.
 */
function renderSignInStalled(data = {}) {
  document.body.dataset.view = 'none';
  const code = data.code || 'AUTH';
  const cause = AUTH_CAUSES[code];

  view.innerHTML = `
    <div class="empty">
      <strong>Can't confirm your sign-in</strong>
      <p>${esc(data.error || 'The server would not accept the sign-in.')}</p>
      ${cause ? `<p>${esc(cause)}</p>` : ''}
      <p class="hint">Reported as <code>${esc(code)}</code>. On the server:
        <code>sudo journalctl -u weekofmeals -n 50</code></p>
      <div class="sheet-actions" style="justify-content:center">
        <button class="btn primary" data-act="hard-reload">Reload, skipping the cache</button>
      </div>
    </div>`;
  document.querySelectorAll('.tab').forEach((t) => { t.disabled = true; });
}

/**
 * Who is in this household, and — for an administrator — the levers.
 *
 * A plain member sees the roster and the way out, and no controls they cannot
 * use. Showing disabled buttons would only invite the question of how to enable
 * them, and the answer is "ask somebody", which is not a button.
 */
function householdSheet(h) {
  const me = session.user?.email || '';
  const isAdmin = h.isAdmin;

  const member = (email) => {
    const admin = h.admins.includes(email);
    const isMe = email === me;
    return `<li>
      <span>${esc(email)}${isMe ? ' <em class="tag" style="font-style:normal">you</em>' : ''}
        ${admin ? '<em class="tag" style="font-style:normal">admin</em>' : ''}</span>
      ${isAdmin && !isMe ? `<span class="row-actions">
        <button class="btn ghost dim" data-act="household-admin"
          data-email="${esc(email)}" data-admin="${!admin}">${admin ? 'Make member' : 'Make admin'}</button>
        ${admin ? '' : `<button class="btn ghost dim" data-act="household-remove"
          data-email="${esc(email)}">Remove</button>`}
      </span>` : ''}
    </li>`;
  };

  return `
    <h2>${esc(h.name)}</h2>
    <p class="sub">${h.members.length === 1
    ? 'You are the only person in it. Invite whoever you cook with.'
    : `${h.members.length} people share these recipes, this week's plan and this shopping list.`}</p>

    ${h.claimable ? `<div class="notice on-paper">
      Nobody administers this household. As a member you can take it on.
      <div class="sheet-actions"><button class="btn primary" data-act="household-claim">Take charge</button></div>
    </div>` : ''}

    <p class="eyebrow on-paper" style="margin:22px 0 8px">Who's in it</p>
    <ul class="member-list">${h.members.map(member).join('')}</ul>

    ${isAdmin ? `
      <p class="eyebrow on-paper" style="margin:22px 0 8px">Invite someone</p>
      <div class="notice on-paper">They'll need to sign in with the address your
        Cloudflare Access policy allows. A code is good once, for a week.</div>
      <label class="field"><span>Lock it to one address (optional)</span>
        <input id="invite-email" type="email" placeholder="them@example.com" autocomplete="off">
        <p class="hint">Leave blank for a code anyone can use — simplest to text.
          Fill it in and the code is useless to anybody else.</p></label>
      <div class="sheet-actions">
        <button class="btn primary" data-act="household-invite">Create an invite</button>
      </div>

      ${h.invites?.length ? `
        <p class="eyebrow on-paper" style="margin:22px 0 8px">Waiting to be used</p>
        <ul class="member-list">
          ${h.invites.map((i) => `<li>
            <span><code class="invite-code">${esc(i.code)}</code>
              ${i.email ? `<em style="color:var(--ink-soft)">for ${esc(i.email)}</em>` : ''}</span>
            <span class="row-actions">
              <button class="btn ghost dim" data-act="household-copy" data-code="${esc(i.code)}">Copy</button>
              <button class="btn ghost dim" data-act="household-revoke" data-code="${esc(i.code)}">Revoke</button>
            </span>
          </li>`).join('')}
        </ul>` : ''}

      <p class="eyebrow on-paper" style="margin:22px 0 8px">Rename</p>
      <label class="field"><span>Household name</span>
        <input id="household-name" value="${esc(h.name)}" maxlength="60"></label>
      <div class="sheet-actions">
        <button class="btn" data-act="household-rename">Save name</button>
      </div>` : ''}

    <p class="eyebrow on-paper" style="margin:22px 0 8px">Leave</p>
    <div class="notice on-paper">The recipes stay with the household — they belong
      to it, not to you.</div>
    <div class="sheet-actions">
      <button class="btn danger" data-act="household-leave">Leave ${esc(h.name)}</button>
    </div>`;
}

/**
 * The household section of Settings.
 *
 * The switcher appears only for somebody genuinely in more than one; everyone
 * else simply sees the household they are in and the way to manage it, and the
 * concept of "which household" is never raised with them at all.
 */
function householdSwitcher() {
  if (!session.household) return '';
  const many = session.households.length > 1;

  return `
    <p class="eyebrow on-paper" style="margin:22px 0 8px">Household</p>
    ${many ? `<div class="notice on-paper">You are in more than one. Everything in the
      app — recipes, the week, the shopping list — belongs to whichever is chosen here.</div>
    <div class="tagrow" style="margin:10px 0">
      ${session.households.map((h) => `<button class="tag" data-act="switch-household"
        data-id="${esc(h.id)}" aria-pressed="${session.household?.id === h.id}"
        style="padding:6px 12px">${esc(h.name)}</button>`).join('')}
    </div>` : ''}
    <div class="sheet-actions">
      <button class="btn wide" data-act="household-open">${many ? `Manage ${esc(session.household.name)}` : `${esc(session.household.name)} &middot; members and invites`}</button>
    </div>
    <div class="sheet-actions">
      <button class="btn ghost dim" data-act="household-another">Start or join another</button>
    </div>`;
}

/* -------------------------------------------------------------- polls -- */

/**
 * The poll, wherever it has got to, at the top of the week it is about.
 *
 * One band that changes with the state rather than four screens: nobody should
 * have to go looking for a vote that is waiting on them.
 */
function pollBanner() {
  const poll = state.poll;
  const canRun = state.pollCanRun;

  if (!poll) {
    return canRun ? `
      <div class="poll-band quiet">
        <div>
          <strong>Let everyone choose</strong>
          <p>Open a vote and fill this week with what the household picks.</p>
        </div>
        <button class="btn" data-act="poll-new">Start a vote</button>
      </div>` : '';
  }

  const { voted, of } = poll.turnout;

  if (poll.status === 'open') {
    const mine = poll.myVote !== null;
    return `
      <div class="poll-band ${mine ? '' : 'urgent'}">
        <div>
          <strong>${mine ? "You've voted" : 'Vote on this week'}</strong>
          <p>${voted} of ${of} in${poll.voted.length && mine ? ` &middot; ${poll.voted.map(esc).join(', ')}` : ''}.
            Choosing ${poll.wanted} meal${poll.wanted === 1 ? '' : 's'}.
            ${mine ? 'Results appear when it closes.' : ''}</p>
        </div>
        <div class="poll-band-actions">
          <button class="btn ${mine ? 'ghost' : 'primary'}" data-act="vote-open">${mine ? 'Change my vote' : 'Vote'}</button>
          ${canRun ? `<button class="btn ghost dim" data-act="poll-close-vote" data-id="${esc(poll.id)}">Close it</button>` : ''}
        </div>
      </div>`;
  }

  return `
    <div class="poll-band">
      <div>
        <strong>The votes are in</strong>
        <p>${poll.appliedAt ? 'Already added to the week.' : `Top ${poll.wanted} ready to add.`}</p>
      </div>
      <button class="btn ${poll.appliedAt ? 'ghost' : 'primary'}" data-act="poll-results" data-id="${esc(poll.id)}">
        ${poll.appliedAt ? 'See results' : 'Review and add'}
      </button>
    </div>`;
}

/** What the admin sets up. Four controls, three of them with sane defaults. */
function pollForm() {
  const dates = state.boot.dates;
  const plan = state.boot.plan;
  const shortlist = state.pollShortlist;
  const recipes = state.boot.recipes;

  // Default to the days that have nothing on them yet — the ones you are
  // actually trying to fill.
  const empty = dates.filter((d) => !(plan[d] || []).length);
  const preselected = new Set(empty.length ? empty : dates);

  return `
    <h2>Start a vote</h2>
    <p class="sub">Everyone ticks the meals they'd be happy with. You place the winners.</p>

    <p class="eyebrow on-paper" style="margin:22px 0 8px">Which days</p>
    <div class="tagrow" style="margin-bottom:10px">
      ${['all', 'weekdays', 'weekend'].map((k) => `<button class="tag" data-act="poll-days-preset"
        data-preset="${k}" style="padding:5px 11px">${k === 'all' ? 'All week' : k[0].toUpperCase() + k.slice(1)}</button>`).join('')}
    </div>
    <div class="day-picker">
      ${dates.map((d) => {
    const info = dayOf(d);
    return `<button class="day-pick" data-act="poll-day" data-date="${d}"
        aria-pressed="${preselected.has(d)}"><b>${info.name}</b><i>${info.num}</i></button>`;
  }).join('')}
    </div>
    <p class="hint" id="poll-count">Choosing ${preselected.size} meal${preselected.size === 1 ? '' : 's'}</p>

    <label class="field"><span>Which meal</span>
      <select id="poll-category">
        ${(state.boot.categoryChoices || []).map((c) => `<option value="${esc(c)}"${c === 'dinner' ? ' selected' : ''}>${esc(c)}</option>`).join('')}
      </select></label>

    <p class="eyebrow on-paper" style="margin:22px 0 8px">What's on the ballot</p>
    <div class="tagrow" style="margin-bottom:10px">
      <button class="tag" data-act="poll-scope" data-scope="all" aria-pressed="${shortlist === null}"
        style="padding:5px 11px">Every recipe</button>
      <button class="tag" data-act="poll-scope" data-scope="some" aria-pressed="${shortlist !== null}"
        style="padding:5px 11px">Just these</button>
    </div>
    ${shortlist === null
    ? `<div class="notice on-paper">All ${recipes.length} recipes will be on the ballot.</div>`
    : `<div class="notice on-paper">Tick the ones to offer. <span id="poll-picked">${shortlist.size} chosen</span></div>
       <div class="shortlist">
         ${recipes.map((r) => `<button class="shortlist-item" data-act="poll-pick" data-id="${esc(r.id)}"
           aria-pressed="${shortlist.has(r.id)}">${esc(r.title)}</button>`).join('')}
       </div>`}

    <label class="field"><span>Close automatically on (optional)</span>
      <input id="poll-closes" type="date"></label>

    <div class="sheet-actions">
      <button class="btn primary" data-act="poll-create">Open the vote</button>
      <button class="btn ghost" data-close style="flex:0 0 auto">Cancel</button>
    </div>`;
}

/** The ranking, with the winners marked and a way to drop one before applying. */
function pollResults(poll) {
  const dropped = state.pollDropped || new Set();
  const result = poll.result || [];
  const keeping = result.filter((r) => !dropped.has(r.id)).slice(0, poll.wanted);
  const keptIds = new Set(keeping.map((r) => r.id));

  return `
    <h2>The votes are in</h2>
    <p class="sub">${poll.turnout.voted} of ${poll.turnout.of} voted. Filling
      ${poll.days.length} day${poll.days.length === 1 ? '' : 's'}.</p>

    <ul class="result-list">
      ${result.map((r) => `<li data-in="${keptIds.has(r.id)}">
        <span class="bar" style="--w:${poll.turnout.voted ? Math.round((r.approvals / poll.turnout.voted) * 100) : 0}%"></span>
        <span class="result-title">${esc(r.title)}</span>
        <span class="result-count">${r.approvals}</span>
        <button class="btn ghost dim" data-act="poll-drop" data-id="${esc(r.id)}" data-poll="${esc(poll.id)}"
          >${dropped.has(r.id) ? 'Put back' : 'Drop'}</button>
      </li>`).join('')}
    </ul>

    ${poll.appliedAt ? `<div class="notice on-paper">Added to the week already. Applying
      again will only fill days that are still empty.</div>` : ''}

    <div class="sheet-actions">
      <button class="btn primary" data-act="poll-apply" data-id="${esc(poll.id)}">
        Add ${keeping.length} to the week
      </button>
      <button class="btn ghost dim" data-act="poll-delete" data-id="${esc(poll.id)}">Delete poll</button>
    </div>`;
}

/* --------------------------------------------------------- recipe UI -- */

async function showRecipe(id) {
  const r = await api(`/recipes/${id}`);
  openSheet(`
    ${r.image ? `<div class="hero"><img src="${esc(imageUrl(r.image))}" alt="${esc(r.title)}"
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
  // A new recipe starts on the dinner shelf: this is a dinner-first planner,
  // and a blank category would file every new recipe under "Uncategorized",
  // which is the one shelf nobody browses on purpose.
  const r = recipe || {
    title: '', ingredients: [], steps: [], tags: [], time: '', servings: '',
    source: '', notes: '', category: 'dinner',
  };

  // The canonical shelves, plus any you have invented, minus the placeholder.
  const choices = [...new Set([
    ...(state.boot.categoryChoices || []),
    ...(state.boot.categories || []).map((c) => c.key),
  ])].filter((c) => c !== 'uncategorized');
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
          ${r.image ? `<img src="${esc(imageUrl(r.image))}" alt="">` : '<span>No photo</span>'}
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

    <label class="field"><span>Category</span>
      <input id="f-category" list="category-choices" value="${esc(r.category || '')}"
             placeholder="dinner" autocomplete="off">
      <datalist id="category-choices">
        ${choices.map((c) => `<option value="${esc(c)}">`).join('')}
      </datalist>
      <p class="hint">The shelf it lives on. Pick one of these or type your own.</p></label>

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

  async 'hard-reload'() {
    // Clear the one-shot flag so the fresh page gets its automatic attempt back,
    // and go somewhere the cache has no answer for.
    try { sessionStorage.removeItem('wom:reauth-attempted'); } catch { /* ignore */ }
    const url = new URL(window.location.href);
    url.searchParams.set('reauth', Date.now().toString(36));
    window.location.replace(url.toString());
  },

  async 'create-household'(el) {
    const name = $('#new-household').value.trim();
    if (!name) { toast('Give it a name first.', 'bad'); return; }
    el.classList.add('busy');
    try {
      const { household } = await api('/households', { method: 'POST', body: { name } });
      await enterHousehold(household, `${household.name} is ready.`);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'join-household'(el) {
    const code = $('#join-code').value.trim();
    if (!code) { toast('Type the code you were sent.', 'bad'); return; }
    el.classList.add('busy');
    try {
      const { household } = await api('/households/join', { method: 'POST', body: { code } });
      await enterHousehold(household, `You're in ${household.name}.`);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  /** The management panel, opened from Settings. */
  /** Somebody already in a household wanting a second one. */
  async 'household-another'() {
    closeSheet();
    renderNoHousehold();
  },

  async 'onboard-cancel'() {
    state.tab = 'recipes';
    render();
  },

  async 'household-open'() {
    if (!session.household) return;
    const detail = await api(`/households/${session.household.id}`);
    openSheet(householdSheet(detail));
  },

  async 'household-invite'(el) {
    const email = ($('#invite-email')?.value || '').trim();
    el.classList.add('busy');
    try {
      await api(`/households/${session.household.id}/invites`, { method: 'POST', body: { email } });
      openSheet(householdSheet(await api(`/households/${session.household.id}`)));
      toast('Invite created. Send them the code.');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'household-revoke'(el) {
    await api(`/households/${session.household.id}/invites/${encodeURIComponent(el.dataset.code)}`, { method: 'DELETE' });
    openSheet(householdSheet(await api(`/households/${session.household.id}`)));
    toast('Invite revoked.');
  },

  async 'household-copy'(el) {
    const code = el.dataset.code;
    try {
      await navigator.clipboard.writeText(code);
      toast('Code copied.');
    } catch {
      // Clipboard needs a secure context, which the home wifi is not.
      toast(`Invite code: ${code}`);
    }
  },

  async 'household-remove'(el) {
    const who = el.dataset.email;
    await api(`/households/${session.household.id}/members/${encodeURIComponent(who)}`, { method: 'DELETE' });
    openSheet(householdSheet(await api(`/households/${session.household.id}`)));
    toast(`${who} removed.`);
  },

  async 'household-admin'(el) {
    const who = el.dataset.email;
    const make = el.dataset.admin === 'true';
    await api(`/households/${session.household.id}/members/${encodeURIComponent(who)}/admin`, {
      method: 'PUT', body: { admin: make },
    });
    openSheet(householdSheet(await api(`/households/${session.household.id}`)));
    toast(make ? `${who} can now invite and manage.` : `${who} is a member again.`);
  },

  async 'household-rename'(el) {
    const name = $('#household-name').value.trim();
    if (!name) { toast('Give it a name.', 'bad'); return; }
    el.classList.add('busy');
    try {
      const { household } = await api(`/households/${session.household.id}/name`, {
        method: 'PUT', body: { name },
      });
      session.household.name = household.name;
      const mine = session.households.find((h) => h.id === household.id);
      if (mine) mine.name = household.name;
      openSheet(householdSheet(await api(`/households/${session.household.id}`)));
      toast('Renamed.');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'household-claim'() {
    const { household } = await api(`/households/${session.household.id}/claim`, { method: 'POST' });
    openSheet(householdSheet(await api(`/households/${household.id}`)));
    toast('You now administer this household.');
  },

  async 'household-leave'(el) {
    const name = session.household.name;
    el.classList.add('busy');
    try {
      await api(`/households/${session.household.id}/leave`, { method: 'POST' });
      closeSheet();
      // Whatever is left, if anything. The server is the authority on that.
      const who = await fetch('/api/whoami').then((r) => r.json());
      session.households = who.households || [];
      session.household = who.household || null;
      if (!session.household) { renderNoHousehold(); toast(`You left ${name}.`); return; }
      state.week = null;
      await refresh();
      toast(`You left ${name}.`);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  /* ------------------------------------------------------------- polls -- */

  async 'vote-open'() {
    const { polls: found } = await api(`/polls?week=${state.week}`);
    const open = found.find((p) => p.status === 'open');
    if (!open) { toast('That poll has closed.', 'bad'); await refresh(); return; }
    if (!open.candidates.length) { toast('There are no recipes to vote on yet.', 'bad'); return; }
    openVote(open);
  },

  async 'vote-close'() { closeVote(); },
  async 'vote-undo'() { undo(); },
  async 'vote-yes'() { decide(true); },
  async 'vote-no'() { decide(false); },
  async 'vote-restart'() { vote.at = 0; vote.picks = new Map(); renderDeck(); },

  async 'vote-submit'(el) {
    const approvals = [...vote.picks.entries()].filter(([, v]) => v).map(([id]) => id);
    el.classList.add('busy');
    try {
      await api(`/polls/${vote.poll.id}/vote`, { method: 'PUT', body: { approvals } });
      closeVote();
      await refresh();
      toast('Your vote is in.');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'poll-new'() {
    openSheet(pollForm());
  },

  async 'poll-create'(el) {
    const days = [...document.querySelectorAll('[data-act="poll-day"][aria-pressed="true"]')]
      .map((d) => d.dataset.date);
    if (!days.length) { toast('Pick at least one day.', 'bad'); return; }

    const shortlist = state.pollShortlist === null ? [] : [...state.pollShortlist];
    const closesAt = $('#poll-closes').value
      ? new Date(`${$('#poll-closes').value}T20:00:00`).toISOString() : '';

    el.classList.add('busy');
    try {
      await api('/polls', {
        method: 'POST',
        body: {
          week: state.week, days, category: $('#poll-category').value, candidates: shortlist, closesAt,
        },
      });
      closeSheet();
      await refresh();
      toast('Poll is open. Tell everyone to vote.');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'poll-day'(el) {
    el.setAttribute('aria-pressed', el.getAttribute('aria-pressed') !== 'true');
    const n = document.querySelectorAll('[data-act="poll-day"][aria-pressed="true"]').length;
    $('#poll-count').textContent = n ? `Choosing ${n} meal${n === 1 ? '' : 's'}` : 'Pick at least one day';
  },

  async 'poll-days-preset'(el) {
    const want = el.dataset.preset;
    document.querySelectorAll('[data-act="poll-day"]').forEach((d) => {
      const dow = new Date(`${d.dataset.date}T12:00:00`).getDay();
      const on = want === 'all' || (want === 'weekdays' && dow > 0 && dow < 6)
        || (want === 'weekend' && (dow === 0 || dow === 6));
      d.setAttribute('aria-pressed', on);
    });
    const n = document.querySelectorAll('[data-act="poll-day"][aria-pressed="true"]').length;
    $('#poll-count').textContent = `Choosing ${n} meal${n === 1 ? '' : 's'}`;
  },

  /** Flip between "any recipe" and a shortlist the admin ticks. */
  async 'poll-scope'(el) {
    state.pollShortlist = el.dataset.scope === 'all' ? null : new Set();
    openSheet(pollForm());
  },

  async 'poll-pick'(el) {
    if (!state.pollShortlist) state.pollShortlist = new Set();
    const id = el.dataset.id;
    if (state.pollShortlist.has(id)) state.pollShortlist.delete(id);
    else state.pollShortlist.add(id);
    el.setAttribute('aria-pressed', state.pollShortlist.has(id));
    $('#poll-picked').textContent = `${state.pollShortlist.size} chosen`;
  },

  async 'poll-close-vote'(el) {
    el.classList.add('busy');
    try {
      await api(`/polls/${el.dataset.id}/close`, { method: 'POST' });
      await refresh();
      toast('Poll closed. Here are the results.');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'poll-results'(el) {
    const { polls: found } = await api(`/polls?week=${state.week}`);
    const poll = found.find((p) => p.id === el.dataset.id);
    if (poll) openSheet(pollResults(poll));
  },

  async 'poll-drop'(el) {
    state.pollDropped = state.pollDropped || new Set();
    if (state.pollDropped.has(el.dataset.id)) state.pollDropped.delete(el.dataset.id);
    else state.pollDropped.add(el.dataset.id);
    const { polls: found } = await api(`/polls?week=${state.week}`);
    openSheet(pollResults(found.find((p) => p.id === el.dataset.poll)));
  },

  async 'poll-apply'(el) {
    const dropped = state.pollDropped || new Set();
    const { polls: found } = await api(`/polls?week=${state.week}`);
    const poll = found.find((p) => p.id === el.dataset.id);
    const recipeIds = (poll.result || []).map((r) => r.id).filter((id) => !dropped.has(id));

    el.classList.add('busy');
    try {
      const { added } = await api(`/polls/${poll.id}/apply`, { method: 'POST', body: { recipeIds } });
      closeSheet();
      state.pollDropped = new Set();
      state.tab = 'week';
      await refresh();
      toast(`${added.length} meal${added.length === 1 ? '' : 's'} added to the week.`);
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'poll-delete'(el) {
    await api(`/polls/${el.dataset.id}`, { method: 'DELETE' });
    closeSheet();
    await refresh();
    toast('Poll deleted.');
  },

  async 'save-anylist'(el) {
    el.classList.add('busy');
    try {
      await api('/anylist/account', {
        method: 'PUT',
        body: {
          email: $('#f-anylist-email').value,
          password: $('#f-anylist-password').value,
        },
      });
      closeSheet();
      await refresh();
      toast('AnyList sign-in saved.');
    } catch (err) {
      toast(err.message, 'bad');
    } finally {
      el.classList.remove('busy');
    }
  },

  async 'switch-household'(el) {
    const next = session.households.find((h) => h.id === el.dataset.id);
    if (!next || next.id === session.household?.id) return;
    session.household = next;

    // A different kitchen entirely: the open folder, the search and the week's
    // tick-offs all describe the one we just left.
    state.category = null;
    state.tag = null;
    state.search = '';
    state.week = null;

    closeSheet();
    await refresh();
    toast(`Now showing ${next.name}.`);
  },

  async 'open-category'(el) {
    state.category = el.dataset.category;
    // A tag chosen on one shelf means nothing on the next one.
    state.tag = null;
    render();
  },

  async 'close-category'() {
    state.category = null;
    state.tag = null;
    // Otherwise "All recipes" lands on a still-filtered grid, which reads as
    // the breadcrumb having done nothing.
    state.search = '';
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
      category: $('#f-category').value,
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

  /**
   * Untick everything, for when the shop is done.
   *
   * The list is worked out from the week's meals rather than stored, so there
   * is no list to delete — clearing it means unticking it. That leaves the
   * ingredients on screen, which is right: they are still what those meals
   * need, and next week's plan will want them again.
   *
   * Nothing is sent to AnyList. Anything already pushed there stays there;
   * this is the copy in the browser.
   */
  async 'clear-list'() {
    const wasOn = state.list.items.filter((i) => i.include).map((i) => i.key);
    if (!wasOn.length) return;

    state.list.items.forEach((i) => { i.include = false; });
    render();
    await api('/list/include', { method: 'PUT', body: { week: state.week, keys: wasOn, include: false } });
    await loadList();
    render();

    // Reinstating two dozen ticks by hand would be a miserable way to recover
    // from a mis-tap, so the whole thing comes back in one press.
    toast(`Cleared ${wasOn.length} item${wasOn.length === 1 ? '' : 's'}. AnyList is untouched.`, 'ok', {
      label: 'Undo',
      ms: 6000,
      onClick: async () => {
        await api('/list/include', { method: 'PUT', body: { week: state.week, keys: wasOn, include: true } });
        await loadList();
        render();
        toast('List restored.');
      },
    });
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

      <p class="eyebrow on-paper" style="margin:22px 0 8px">AnyList</p>
      <div class="notice on-paper">
        ${state.boot.anylist.configured
    ? `Connected${state.boot.settings.listName ? `, sending to &ldquo;${esc(state.boot.settings.listName)}&rdquo;` : ''}.`
    : 'Not set up. The shopping list still works — this only adds the button that pushes it to AnyList.'}
      </div>
      <label class="field"><span>AnyList email</span>
        <input id="f-anylist-email" type="email" autocomplete="off"
               value="${esc(state.boot.anylist.email || '')}" placeholder="you@example.com"></label>
      <label class="field"><span>AnyList password</span>
        <input id="f-anylist-password" type="password" autocomplete="new-password"
               placeholder="${state.boot.anylist.hasPassword ? 'unchanged' : 'your AnyList password'}">
        <p class="hint">This household's own AnyList account, kept apart from any other
          household's. AnyList has no app passwords, so this is the real one — it is
          encrypted before it is stored and never sent back to this page. Leave it blank
          to keep the one already saved.</p></label>
      <div class="sheet-actions">
        <button class="btn" data-act="save-anylist">Save AnyList sign-in</button>
      </div>

      ${session.user ? `<div class="whoami">
        <span>Signed in as ${esc(session.user.email)} via Cloudflare Access</span>
      </div>` : ''}

      ${householdSwitcher()}

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
      session.households = who.households || [];
      session.household = who.household || null;
    } catch { /* not fatal; the app works without knowing your name */ }

    // Ask before loading rather than letting /bootstrap 403: the answer is the
    // same either way, but this way the explanation is the first thing painted
    // instead of arriving after a failed request.
    if (session.guarded && session.user && !session.household) {
      renderNoHousehold();
      return;
    }

    await loadBoot();
    await loadList();
    await loadPoll();
    state.tab = state.boot.recipes.length ? 'week' : 'recipes';
    render();
  } catch (err) {
    // A handled error has already put a better explanation on the screen.
    if (!err.handled) {
      view.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>
        <p>${esc(err.message)}</p></div>`;
    }
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
  preview.innerHTML = url ? `<img src="${esc(imageUrl(url))}" alt="">` : '<span>No photo</span>';
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

/* ============================================================== voting ==
   A deck of cards you throw one way or the other.

   Approval voting is a yes/no question repeated, which is exactly the shape a
   card deck fits: one decision on screen at a time, no scrolling, no hunting
   for the checkbox you meant. It also stops the ballot feeling like a form,
   which matters when you are asking a household to do this every week.

   Pointer events rather than touch events, so a finger and a mouse travel the
   same code path — the desktop drag is not a separate implementation, it is the
   same one. Keys and buttons do the same job for anyone not dragging, and the
   whole thing works without a gesture at all.
*/

const vote = {
  poll: null,
  order: [],      // recipe ids, the order they are shown in
  at: 0,          // how far through
  picks: new Map(), // recipeId -> true (approve) | false (pass)
  drag: null,
};

const voteHost = $('#vote');
const deck = $('#deck');

/** Distance past which a release counts as a decision rather than a wobble. */
const THROW_PX = 90;

async function openVote(poll) {
  vote.poll = poll;
  vote.order = poll.candidates.map((c) => c.id);
  vote.picks = new Map();
  vote.at = 0;

  // Coming back to change your mind: start from the top with what you said
  // last time already filled in, so you can re-throw only what you want to.
  if (poll.myVote) {
    const approved = new Set(poll.myVote);
    for (const c of poll.candidates) vote.picks.set(c.id, approved.has(c.id));
  }

  voteHost.hidden = false;
  document.body.style.overflow = 'hidden';
  renderDeck();
}

function closeVote() {
  voteHost.hidden = true;
  deck.innerHTML = '';
  document.body.style.overflow = '';
  vote.poll = null;
}

function voteCard(candidate, depth) {
  const decided = vote.picks.get(candidate.id);
  return `
    <article class="card-face" data-id="${esc(candidate.id)}" data-depth="${depth}">
      <div class="card-photo">
        ${candidate.image
    ? `<img src="${esc(imageUrl(candidate.image))}" alt="" onerror="this.parentNode.classList.add('blank')">`
    : ''}<em>${esc(initials(candidate.title))}</em>
      </div>
      <div class="card-body">
        <h3>${esc(candidate.title)}</h3>
        <p class="meta">${[candidate.category, candidate.time].filter(Boolean).map(esc).join(' &middot; ') || 'No timing noted'}</p>
      </div>
      <span class="stamp yes" aria-hidden="true">Yes</span>
      <span class="stamp no" aria-hidden="true">Pass</span>
      ${decided === undefined ? '' : `<span class="prior ${decided ? 'yes' : 'no'}">Last time: ${decided ? 'yes' : 'pass'}</span>`}
    </article>`;
}

function renderDeck() {
  const { poll } = vote;
  const left = vote.order.length - vote.at;

  $('#vote-undo').disabled = vote.at === 0;

  if (left <= 0) {
    const yes = [...vote.picks.entries()].filter(([, v]) => v).map(([id]) => id);
    const names = poll.candidates.filter((c) => yes.includes(c.id)).map((c) => c.title);
    $('#vote-progress').textContent = 'All done';
    $('#vote-hint').textContent = '';
    deck.innerHTML = `
      <div class="deck-done">
        <p class="eyebrow">Your ballot</p>
        <h3>${yes.length} of ${vote.order.length}</h3>
        <p class="sub">${names.length
    ? `You'd be happy with ${names.map(esc).join(', ')}.`
    : "You passed on everything. That's a fine answer, but nothing will be picked for you."}</p>
        <div class="sheet-actions" style="justify-content:center">
          <button class="btn primary" data-act="vote-submit">Send it in</button>
          <button class="btn ghost" data-act="vote-restart">Start over</button>
        </div>
      </div>`;
    return;
  }

  // Two cards deep: enough to read as a stack, cheap enough to re-render.
  const upcoming = vote.order.slice(vote.at, vote.at + 2)
    .map((id) => poll.candidates.find((c) => c.id === id))
    .filter(Boolean);

  $('#vote-progress').textContent = `${vote.at + 1} of ${vote.order.length}`;
  $('#vote-hint').textContent = 'Would you be happy to eat this?';
  deck.innerHTML = upcoming.map((c, i) => voteCard(c, i)).reverse().join('');
  armTopCard();
}

const topCard = () => deck.querySelector('.card-face[data-depth="0"]');

/**
 * Commit the visible card.
 * @param {boolean} approved
 * @param {boolean} [silent]  skip the fly-out, for keyboard and buttons
 */
function decide(approved, silent = false) {
  const card = topCard();
  if (!card) return;
  const id = card.dataset.id;
  vote.picks.set(id, approved);
  vote.at += 1;

  const finish = () => renderDeck();
  if (silent || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finish();
    return;
  }

  card.classList.add('flung');
  card.style.transform = `translate(${approved ? 140 : -140}%, 20px) rotate(${approved ? 24 : -24}deg)`;
  card.style.opacity = '0';
  setTimeout(finish, 220);
}

function undo() {
  if (vote.at === 0) return;
  vote.at -= 1;
  vote.picks.delete(vote.order[vote.at]);
  renderDeck();
}

/** Drag, tilt, and a stamp that fades in as you commit. */
function armTopCard() {
  const card = topCard();
  if (!card) return;

  card.addEventListener('pointerdown', (e) => {
    // Ignore the secondary button, and anything that is already a control.
    if (e.button !== 0) return;
    card.setPointerCapture(e.pointerId);
    vote.drag = { x: e.clientX, y: e.clientY, dx: 0 };
    card.classList.add('dragging');
  });

  card.addEventListener('pointermove', (e) => {
    if (!vote.drag) return;
    vote.drag.dx = e.clientX - vote.drag.x;
    const dy = e.clientY - vote.drag.y;
    const tilt = vote.drag.dx / 18;
    card.style.transform = `translate(${vote.drag.dx}px, ${dy * 0.25}px) rotate(${tilt}deg)`;
    // Past the threshold the card says which way it is going before you let go.
    const lean = Math.min(Math.abs(vote.drag.dx) / THROW_PX, 1);
    card.style.setProperty('--yes', vote.drag.dx > 0 ? String(lean) : '0');
    card.style.setProperty('--no', vote.drag.dx < 0 ? String(lean) : '0');
  });

  const release = () => {
    if (!vote.drag) return;
    const { dx } = vote.drag;
    vote.drag = null;
    card.classList.remove('dragging');

    if (Math.abs(dx) >= THROW_PX) { decide(dx > 0); return; }
    // Not far enough: spring back rather than guessing what was meant.
    card.style.transform = '';
    card.style.setProperty('--yes', '0');
    card.style.setProperty('--no', '0');
  };

  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', release);
}

/* Arrow keys are the desktop equivalent of the throw, and the only way through
   the deck for anyone using a keyboard. */
document.addEventListener('keydown', (e) => {
  if (voteHost.hidden) return;
  if (e.key === 'ArrowRight' || e.key === 'y') { e.preventDefault(); decide(true); }
  else if (e.key === 'ArrowLeft' || e.key === 'n') { e.preventDefault(); decide(false); }
  else if (e.key === 'Backspace') { e.preventDefault(); undo(); }
  else if (e.key === 'Escape') closeVote();
});
