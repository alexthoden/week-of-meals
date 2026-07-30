'use strict';

/**
 * What kind of meal a recipe is: dinner, dessert, a side.
 *
 * Deliberately not a tag. Tags are adjectives you can pile on — "fast",
 * "one pan", "kid approved" — and a recipe wears as many as fit. A category is
 * the single shelf the recipe lives on, which is what makes a folder view
 * possible: every recipe is in exactly one place, and the places add up to the
 * whole collection with nothing double-counted.
 *
 * Stored lowercase (the same shape as tags and pantry keys) and title-cased
 * only for display.
 */

/** The shelves offered in the picker. Anything else you type is kept as-is. */
const CATEGORIES = [
  'breakfast',
  'lunch',
  'dinner',
  'dessert',
  'snack',
  'side',
  'drink',
];

/** Where a recipe goes when nobody has said. Not a real category; a fallback. */
const UNCATEGORIZED = 'uncategorized';

function normalizeCategory(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 40);
}

/**
 * The shelf a recipe belongs on.
 *
 * Recipes written before categories existed have no `category` field, so rather
 * than dumping every one of them into "Uncategorized" we read the tags first:
 * a recipe already tagged "breakfast" plainly is one. This is a read-time
 * default, not a migration — nothing is rewritten on disk until you edit the
 * recipe, so the guess is never destructive and never has to be undone.
 */
function categoryOf(recipe) {
  const explicit = normalizeCategory(recipe && recipe.category);
  if (explicit) return explicit;

  const tags = (recipe && recipe.tags) || [];
  const match = tags.map(normalizeCategory).find((t) => CATEGORIES.includes(t));
  return match || UNCATEGORIZED;
}

/** "side" -> "Side", "make ahead" -> "Make Ahead". */
function labelFor(category) {
  const name = normalizeCategory(category) || UNCATEGORIZED;
  return name.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}

/**
 * Every shelf in use, with counts, ordered the way a day runs — breakfast
 * through dessert — then any you invented, then the empty-by-definition
 * "Uncategorized" last so it never leads.
 */
function summarize(recipes) {
  const counts = new Map();
  for (const recipe of recipes) {
    const key = categoryOf(recipe);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const rank = (key) => {
    if (key === UNCATEGORIZED) return CATEGORIES.length + 1;
    const i = CATEGORIES.indexOf(key);
    return i === -1 ? CATEGORIES.length : i;
  };

  return [...counts.entries()]
    .map(([key, count]) => ({ key, label: labelFor(key), count }))
    .sort((a, b) => rank(a.key) - rank(b.key) || a.label.localeCompare(b.label));
}

module.exports = {
  CATEGORIES, UNCATEGORIZED, normalizeCategory, categoryOf, labelFor, summarize,
};
