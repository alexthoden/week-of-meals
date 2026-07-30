'use strict';

/**
 * Units are grouped into three "dimensions":
 *
 *   volume   - convertible among themselves (base: millilitres)
 *   weight   - convertible among themselves (base: grams)
 *   discrete - countable things (cloves, cans, bunches). NOT convertible to
 *              anything else, and not convertible to each other. "2 cloves of
 *              garlic" and "1 head of garlic" must never be added together.
 *
 * A line with no unit at all ("3 bell peppers") gets the pseudo-unit "each",
 * which is its own discrete bucket.
 */

const VOLUME = {
  tsp: 4.92892,
  tbsp: 14.7868,
  cup: 236.588,
  'fl oz': 29.5735,
  pint: 473.176,
  quart: 946.353,
  gallon: 3785.41,
  ml: 1,
  l: 1000,
};

const WEIGHT = {
  g: 1,
  kg: 1000,
  oz: 28.3495,
  lb: 453.592,
};

// Countable units. Value is the singular display form.
const DISCRETE = [
  'each', 'clove', 'can', 'jar', 'bottle', 'package', 'bag', 'box', 'bunch',
  'head', 'stalk', 'sprig', 'slice', 'strip', 'ear', 'fillet', 'breast',
  'thigh', 'rib', 'loaf', 'sheet', 'stick', 'pinch', 'dash', 'handful',
  'piece', 'cube', 'wedge', 'link', 'patty', 'scoop', 'drop', 'leaf',
];

/**
 * Every spelling we accept, mapped to its canonical unit name.
 * Order matters only in that multi-word keys are matched before single words.
 */
const ALIASES = new Map(Object.entries({
  // volume
  t: 'tsp', tsp: 'tsp', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  T: 'tbsp', tbs: 'tbsp', tbsp: 'tbsp', tbsps: 'tbsp', tblsp: 'tbsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp',
  c: 'cup', cup: 'cup', cups: 'cup',
  'fl oz': 'fl oz', 'fl. oz.': 'fl oz', floz: 'fl oz',
  'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  pt: 'pint', pint: 'pint', pints: 'pint',
  qt: 'quart', quart: 'quart', quarts: 'quart',
  gal: 'gallon', gallon: 'gallon', gallons: 'gallon',
  ml: 'ml', mL: 'ml', milliliter: 'ml', millilitre: 'ml',
  milliliters: 'ml', millilitres: 'ml',
  l: 'l', liter: 'l', litre: 'l', liters: 'l', litres: 'l',

  // weight
  g: 'g', gram: 'g', grams: 'g', gr: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb', '#': 'lb',

  // discrete (plurals + common spellings)
  cloves: 'clove', cans: 'can', jars: 'jar', bottles: 'bottle',
  pkg: 'package', pkgs: 'package', packages: 'package', packet: 'package',
  packets: 'package', bags: 'bag', boxes: 'box', bunches: 'bunch',
  heads: 'head', stalks: 'stalk', sprigs: 'sprig', slices: 'slice',
  strips: 'strip', ears: 'ear', fillets: 'fillet', filet: 'fillet',
  filets: 'fillet', breasts: 'breast', thighs: 'thigh', ribs: 'rib',
  loaves: 'loaf', sheets: 'sheet', sticks: 'stick', pinches: 'pinch',
  dashes: 'dash', handfuls: 'handful', pieces: 'piece', cubes: 'cube',
  wedges: 'wedge', links: 'link', patties: 'patty', scoops: 'scoop',
  drops: 'drop', leaves: 'leaf',
}));

// Identity entries for canonical discrete names.
for (const d of DISCRETE) if (!ALIASES.has(d)) ALIASES.set(d, d);

/** Longest alias first, so "fl oz" wins over "oz". */
const ALIAS_KEYS = [...ALIASES.keys()].sort((a, b) => b.length - a.length);

function dimensionOf(unit) {
  if (unit in VOLUME) return 'volume';
  if (unit in WEIGHT) return 'weight';
  return 'discrete';
}

/** Resolve a raw token (case-insensitive except the T/t tablespoon convention). */
function resolveUnit(token) {
  if (!token) return null;
  const cleaned = token.replace(/\.$/, '').trim();
  if (cleaned === 'T') return 'tbsp';
  if (cleaned === 't') return 'tsp';
  const lower = cleaned.toLowerCase();
  return ALIASES.get(lower) || ALIASES.get(cleaned) || null;
}

/** Convert an amount to the dimension's base unit (ml, g, or "count"). */
function toBase(amount, unit) {
  const dim = dimensionOf(unit);
  if (dim === 'volume') return amount * VOLUME[unit];
  if (dim === 'weight') return amount * WEIGHT[unit];
  return amount;
}

const FRACTIONS = [
  [1, '⅛'], [1 / 6, '⅙'], [1 / 4, '¼'], [1 / 3, '⅓'], [3 / 8, '⅜'],
  [1 / 2, '½'], [5 / 8, '⅝'], [2 / 3, '⅔'], [3 / 4, '¾'], [7 / 8, '⅞'],
];
const GLYPHS = new Map([
  [0.125, '⅛'], [1 / 6, '⅙'], [0.25, '¼'], [1 / 3, '⅓'], [0.375, '⅜'],
  [0.5, '½'], [0.625, '⅝'], [2 / 3, '⅔'], [0.75, '¾'], [0.875, '⅞'],
]);

/** 1.5 -> "1½", 0.25 -> "¼", 2 -> "2", 1.37 -> "1⅜" */
function formatAmount(n) {
  if (n === null || n === undefined || !isFinite(n)) return '';
  const whole = Math.floor(n);
  const frac = n - whole;
  if (frac < 0.05) return String(whole || 0);
  let best = null;
  let bestErr = Infinity;
  for (const [value, glyph] of GLYPHS) {
    const err = Math.abs(frac - value);
    if (err < bestErr) { bestErr = err; best = glyph; }
  }
  if (bestErr > 0.06) return String(Math.round(n * 100) / 100);
  return whole ? `${whole}${best}` : best;
}

/**
 * Pick the friendliest unit for a summed amount and render it.
 * Volume and weight are rendered in US kitchen units, which is what the
 * recipes and the store shelf both speak.
 */
function formatQuantity(baseAmount, unit) {
  const dim = dimensionOf(unit);

  if (dim === 'volume') {
    const ml = baseAmount;
    if (ml >= VOLUME.gallon * 0.9) return `${formatAmount(ml / VOLUME.gallon)} gal`;
    if (ml >= VOLUME.quart * 0.9) return `${formatAmount(ml / VOLUME.quart)} qt`;
    if (ml >= VOLUME.cup * 0.5) {
      const cups = ml / VOLUME.cup;
      return `${formatAmount(cups)} ${cups > 1 ? 'cups' : 'cup'}`;
    }
    if (ml >= VOLUME.tbsp * 0.9) return `${formatAmount(ml / VOLUME.tbsp)} tbsp`;
    return `${formatAmount(ml / VOLUME.tsp)} tsp`;
  }

  if (dim === 'weight') {
    const g = baseAmount;
    if (g >= WEIGHT.lb * 0.9) return `${formatAmount(g / WEIGHT.lb)} lb`;
    if (g >= WEIGHT.oz * 0.9) return `${formatAmount(g / WEIGHT.oz)} oz`;
    return `${Math.round(g)} g`;
  }

  const n = Math.round(baseAmount * 100) / 100;
  if (unit === 'each') return formatAmount(n);
  return `${formatAmount(n)} ${pluralize(unit, n)}`;
}

function pluralize(unit, n) {
  // A half clove is still "clove". Only amounts above one take the plural.
  if (n <= 1) return unit;
  if (unit === 'leaf') return 'leaves';
  if (unit === 'loaf') return 'loaves';
  if (unit === 'patty') return 'patties';
  if (/(ch|sh|s|x)$/.test(unit)) return `${unit}es`;
  return `${unit}s`;
}

module.exports = {
  VOLUME, WEIGHT, DISCRETE, ALIAS_KEYS,
  resolveUnit, dimensionOf, toBase, formatAmount, formatQuantity, pluralize,
  FRACTIONS,
};
