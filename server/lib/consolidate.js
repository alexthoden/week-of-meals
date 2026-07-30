'use strict';

const { parseIngredient } = require('./parse');
const { dimensionOf, toBase, formatQuantity } = require('./units');

const AISLE_ORDER = ['Produce', 'Meat & Seafood', 'Dairy & Eggs', 'Bakery', 'Frozen', 'Pantry', 'Other'];

/**
 * Turn a week of planned meals into one shopping list.
 *
 * Amounts are only ever added together when they share a dimension:
 * volumes with volumes, weights with weights, and each countable unit with
 * itself. "2 cloves garlic" plus "1 head garlic" stays two separate amounts on
 * one line, because that is the truth and guessing would be worse.
 *
 * @param {Array} meals  [{recipe: {id, title, ingredients: []}, day, scale}]
 * @returns {Array} items grouped and sorted, ready for the list view
 */
function consolidate(meals) {
  const items = new Map();

  for (const meal of meals) {
    const recipe = meal.recipe;
    if (!recipe) continue;
    const scale = Number(meal.scale) > 0 ? Number(meal.scale) : 1;

    for (const line of recipe.ingredients || []) {
      const p = parseIngredient(typeof line === 'string' ? line : line.raw);
      if (!p || !p.canonical) continue;

      if (!items.has(p.canonical)) {
        items.set(p.canonical, {
          key: p.canonical,
          names: new Map(),
          aisle: p.aisle,
          staple: p.staple,
          buckets: new Map(), // unit-or-dimension -> {dim, unit, base}
          unquantified: false,
          approx: false,
          sources: [],
          notes: [],
        });
      }
      const item = items.get(p.canonical);

      item.names.set(p.name, (item.names.get(p.name) || 0) + 1);
      if (p.approx) item.approx = true;
      if (p.note && !item.notes.includes(p.note)) item.notes.push(p.note);

      item.sources.push({
        recipeId: recipe.id,
        title: recipe.title,
        day: meal.day,
        raw: p.raw,
        scale,
      });

      if (p.amount === null) {
        item.unquantified = true;
        continue;
      }

      const dim = dimensionOf(p.unit);
      // Volumes and weights each collapse into one bucket; countables get one
      // bucket per unit so cloves never turn into heads.
      const bucketKey = dim === 'discrete' ? `d:${p.unit}` : dim;
      if (!item.buckets.has(bucketKey)) {
        item.buckets.set(bucketKey, { dim, unit: p.unit, base: 0 });
      }
      const bucket = item.buckets.get(bucketKey);
      bucket.base += toBase(p.amount, p.unit) * scale;
      // Keep the largest unit seen so 1000 ml renders as quarts, not tsp.
      if (dim !== 'discrete') bucket.unit = p.unit;
    }
  }

  const out = [];
  for (const item of items.values()) {
    const parts = [...item.buckets.values()]
      .sort((a, b) => (a.dim === 'discrete' ? 1 : 0) - (b.dim === 'discrete' ? 1 : 0))
      .map((b) => formatQuantity(b.base, b.unit));

    let quantity = parts.join(' + ');
    if (!quantity) quantity = item.unquantified ? '' : '';
    else if (item.unquantified) quantity += ' + more';
    if (item.approx && quantity) quantity = `${quantity}`;

    const name = [...item.names.entries()]
      .sort((a, b) => b[1] - a[1])[0][0];

    out.push({
      key: item.key,
      name,
      quantity,
      aisle: item.aisle,
      staple: item.staple,
      notes: item.notes,
      sources: item.sources,
      recipes: [...new Map(item.sources.map((s) => [`${s.day}|${s.recipeId}`, { title: s.title, day: s.day }])).values()],
      splitAmounts: parts.length > 1,
    });
  }

  out.sort((a, b) => {
    const ai = AISLE_ORDER.indexOf(a.aisle);
    const bi = AISLE_ORDER.indexOf(b.aisle);
    if (ai !== bi) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    return a.name.localeCompare(b.name);
  });

  return out;
}

module.exports = { consolidate, AISLE_ORDER };
