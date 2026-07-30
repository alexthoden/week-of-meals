'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { JSDOM } = require('jsdom');

const PUBLIC = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(PUBLIC, 'style.css'), 'utf8');

/*
 * Why this file exists.
 *
 * The app once shipped a blank, unclickable screen. `#cook` carried the hidden
 * attribute, every test asserting `element.hidden === true` passed, and the
 * overlay painted anyway — because `.cook { display: flex }` overrides the
 * browser's `[hidden] { display: none }` rule. Author styles always beat
 * user-agent styles, so a fixed full-viewport opaque panel sat on top of the
 * whole app swallowing clicks.
 *
 * The lesson is that `.hidden` is an attribute, not a rendering assertion.
 * These tests read computed style instead, so the whole class of bug is caught
 * rather than just the one instance of it.
 */

/** Build a document with the real stylesheet inlined so the cascade applies. */
function render() {
  const withCss = html.replace(
    '<link rel="stylesheet" href="/style.css">',
    `<style>${css}</style>`,
  );
  // No scripts: this is about the static document's rendered state.
  const dom = new JSDOM(withCss, { pretendToBeVisual: true });
  return dom.window;
}

test('every element marked hidden is actually not displayed', () => {
  const window = render();
  const marked = [...window.document.querySelectorAll('[hidden]')]
    .filter((el) => el.tagName.toLowerCase() !== 'svg');

  assert.ok(marked.length >= 4, 'expected several hidden elements in the shell');

  for (const el of marked) {
    const display = window.getComputedStyle(el).display;
    const id = el.id || el.className || el.tagName;
    assert.equal(display, 'none',
      `#${id} carries the hidden attribute but computes display:${display}. `
      + 'A class rule is overriding the user-agent [hidden] rule, which paints '
      + 'the element anyway.');
  }
});

test('the cooking overlay specifically stays out of the way until opened', () => {
  // The exact regression: a fixed, opaque, high-z-index panel over everything.
  const window = render();
  const cook = window.document.querySelector('#cook');
  assert.ok(cook, '#cook should exist in the shell');
  assert.ok(cook.hasAttribute('hidden'), '#cook should start hidden');
  assert.equal(window.getComputedStyle(cook).display, 'none');
});

test('the stylesheet carries the guard that makes hidden win', () => {
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/,
    'style.css must force the hidden attribute to beat layout rules');
});

test('the visibility guard is the last rule in the stylesheet', () => {
  // This bug was reintroduced once by appending `.toast { display: flex }`
  // below the guard. `!important` covers it in a real browser, but keeping the
  // guard last means source order protects us too — and this test is what
  // notices when someone appends past it.
  const rules = css.match(/[^{}]+\{[^{}]*\}/g) || [];
  const last = rules[rules.length - 1] || '';
  assert.match(last, /\[hidden\]/,
    `the last rule in style.css should be the [hidden] guard, but it is: ${last.trim().slice(0, 80)}. `
    + 'Add new styles above the guard block.');
});

test('the shell renders its chrome so a failed script still shows something', () => {
  const window = render();
  const doc = window.document;
  for (const sel of ['.topbar', '.wordmark', '.tabbar', '#view']) {
    const el = doc.querySelector(sel);
    assert.ok(el, `${sel} should exist`);
    assert.notEqual(window.getComputedStyle(el).display, 'none',
      `${sel} should be visible even before app.js runs`);
  }
  assert.equal(doc.querySelectorAll('.tab').length, 3, 'three navigation tabs');
});

test('no stylesheet rule hides the main view or navigation', () => {
  const window = render();
  const view = window.document.querySelector('#view');
  const style = window.getComputedStyle(view);
  assert.notEqual(style.display, 'none');
  assert.notEqual(style.visibility, 'hidden');
});

test('the monogram fallback is not hidden behind its own container', () => {
  /*
   * A recipe with no photo shows its initials instead. That monogram is a later
   * sibling of the <img>, so it needs to sit underneath — and the obvious way to
   * write that, `z-index: -1`, is wrong here.
   *
   * A negative z-index puts an element behind the nearest ancestor that
   * establishes a stacking context. `.thumb` is only `position: relative`, which
   * is not enough to establish one, so the monogram went behind `.thumb`'s own
   * background and vanished. Every photo-less recipe rendered a dead grey
   * rectangle, and the folder tiles inherited it.
   *
   * The fix lifts the photo (`z-index: 1`) instead of sinking the monogram, so
   * this asserts the monogram rules carry no negative index.
   */
  const monogramRules = (css.match(/\.(?:recipe-card \.thumb|peek) em\s*\{[^}]*\}/g) || []);
  assert.ok(monogramRules.length >= 2,
    'expected monogram rules for both the recipe cards and the folder tiles');

  for (const rule of monogramRules) {
    assert.doesNotMatch(rule, /z-index:\s*-/,
      `a negative z-index hides this monogram behind its own container: ${rule.slice(0, 60)}…`);
  }
});

test('index.html references only local assets for app code and styling', () => {
  // A blocked third-party stylesheet must never be able to break layout, and a
  // blocked script must never be able to stop the app booting.
  const localScript = /<script src="\/app\.js"/.test(html);
  assert.ok(localScript, 'app.js should be served from this origin');

  const remoteScripts = [...html.matchAll(/<script[^>]+src="(https?:\/\/[^"]+)"/g)];
  assert.equal(remoteScripts.length, 0,
    `no remote scripts should be required: found ${remoteScripts.map((m) => m[1]).join(', ')}`);
});
