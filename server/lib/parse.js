'use strict';

const { resolveUnit } = require('./units');

const VULGAR = {
  '½': 0.5, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 0.25, '¾': 0.75,
  '⅕': 0.2, '⅖': 0.4, '⅗': 0.6, '⅘': 0.8, '⅙': 1 / 6, '⅚': 5 / 6,
  '⅛': 0.125, '⅜': 0.375, '⅝': 0.625, '⅞': 0.875,
};

const WORD_NUMBERS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, dozen: 12,
};

/** Size words sit between the quantity and the thing. They are not units. */
const SIZE_WORDS = new Set([
  'small', 'medium', 'med', 'large', 'lg', 'extra-large', 'x-large', 'xl',
  'jumbo', 'big', 'thin', 'thick',
]);

/** Trailing phrases that describe usage, not amount. */
const TRAILING_NOTES = [
  /,?\s*(or\s+)?to taste\b.*$/i,
  /,?\s*for (serving|garnish|drizzling|dusting|topping|dipping|brushing|greasing|the pan|frying)\b.*$/i,
  /,?\s*plus more\b.*$/i,
  /,?\s*divided\b\.?$/i,
  /,?\s*\(?optional\)?\.?$/i,
  /,?\s*at room temperature\b\.?$/i,
  /,?\s*if (needed|desired)\b\.?$/i,
];

/** Only merged when the canonical names match exactly. Deliberately short. */
const SYNONYMS = new Map(Object.entries({
  'green onion': 'scallion',
  'spring onion': 'scallion',
  'coriander leaf': 'cilantro',
  'fresh coriander': 'cilantro',
  'garbanzo bean': 'chickpea',
  aubergine: 'eggplant',
  courgette: 'zucchini',
  'confectioners sugar': 'powdered sugar',
  'icing sugar': 'powdered sugar',
  'bicarbonate of soda': 'baking soda',
  'roma tomato': 'plum tomato',
  'chile': 'chili',
}));

/** Things almost everyone already owns. Pre-unchecked on the list, one tap to add. */
const STAPLES = [
  'salt', 'kosher salt', 'sea salt', 'table salt', 'pepper', 'black pepper',
  'water', 'ice', 'olive oil', 'extra virgin olive oil', 'vegetable oil',
  'canola oil', 'cooking spray', 'sugar', 'granulated sugar', 'flour',
  'all purpose flour', 'salt and pepper', 'baking powder', 'baking soda', 'vanilla extract',
];

const SPICES = new Set([
  'black pepper', 'white pepper', 'peppercorn', 'red pepper flake',
  'cayenne pepper', 'chili powder', 'chili flake', 'paprika', 'smoked paprika',
  'cumin', 'coriander', 'turmeric', 'cinnamon', 'nutmeg', 'clove', 'allspice',
  'cardamom', 'oregano', 'basil', 'thyme', 'rosemary', 'sage', 'bay leaf',
  'garlic powder', 'onion powder', 'curry powder', 'garam masala', 'za atar',
  'italian seasoning', 'old bay', 'saffron', 'fennel seed', 'mustard seed',
  'sesame seed', 'poppy seed', 'ginger powder', 'dill weed', 'tarragon',
]);

/** Known collisions where a keyword scan would guess wrong. */
const AISLE_OVERRIDES = new Map(Object.entries({
  'chicken broth': 'Pantry', 'chicken stock': 'Pantry',
  'beef broth': 'Pantry', 'beef stock': 'Pantry',
  'vegetable broth': 'Pantry', 'vegetable stock': 'Pantry',
  'fish sauce': 'Pantry', 'oyster sauce': 'Pantry', 'anchovy paste': 'Pantry',
  'tomato paste': 'Pantry', 'tomato sauce': 'Pantry', 'crushed tomato': 'Pantry',
  'coconut milk': 'Pantry', 'almond milk': 'Pantry', 'oat milk': 'Pantry',
  'peanut butter': 'Pantry', 'almond butter': 'Pantry',
  'chickpea': 'Pantry', 'black bean': 'Pantry', 'kidney bean': 'Pantry',
  'cannellini bean': 'Pantry', 'pinto bean': 'Pantry', 'lentil': 'Pantry',
  'green bean': 'Produce', 'egg noodle': 'Pantry', 'rice noodle': 'Pantry',
  'flour tortilla': 'Bakery', 'corn tortilla': 'Bakery',
  'breadcrumb': 'Pantry', 'panko': 'Pantry', 'bread flour': 'Pantry',
  'butter lettuce': 'Produce', 'buttermilk': 'Dairy & Eggs',
  'eggplant': 'Produce', 'egg roll wrapper': 'Frozen',
  'ice': 'Other', 'water': 'Other', 'salt and pepper': 'Pantry',
}));

/** Scanned in this order; first hit wins. */
const AISLES = [
  ['Frozen', ['frozen', 'ice cream', 'puff pastry', 'phyllo']],
  ['Meat & Seafood', ['chicken', 'beef', 'pork', 'lamb', 'turkey', 'bacon', 'sausage', 'ham', 'steak', 'shrimp', 'salmon', 'tuna', 'cod', 'halibut', 'tilapia', 'fish', 'scallop', 'mussel', 'clam', 'chorizo', 'pancetta', 'prosciutto', 'tofu', 'tempeh', 'brisket', 'roast', 'veal', 'duck']],
  ['Dairy & Eggs', ['milk', 'cream', 'butter', 'cheese', 'yogurt', 'egg', 'eggs', 'parmesan', 'mozzarella', 'cheddar', 'feta', 'ricotta', 'gruyere', 'provolone', 'mascarpone', 'creme fraiche']],
  ['Bakery', ['bread', 'bun', 'roll', 'tortilla', 'pita', 'baguette', 'naan', 'bagel', 'croissant', 'brioche', 'sourdough', 'pie crust']],
  ['Produce', ['lettuce', 'spinach', 'kale', 'arugula', 'romaine', 'tomato', 'onion', 'scallion', 'shallot', 'garlic', 'ginger', 'potato', 'carrot', 'celery', 'cucumber', 'zucchini', 'squash', 'broccoli', 'cauliflower', 'mushroom', 'cabbage', 'avocado', 'lemon', 'lime', 'orange', 'apple', 'banana', 'berry', 'strawberry', 'blueberry', 'raspberry', 'grape', 'melon', 'cilantro', 'parsley', 'mint', 'dill', 'chive', 'corn', 'pea', 'asparagus', 'leek', 'radish', 'beet', 'chili', 'chile', 'jalapeno', 'serrano', 'poblano', 'habanero', 'sprout', 'pepper', 'bell pepper', 'herb', 'greens', 'fennel', 'turnip', 'parsnip', 'artichoke', 'pear', 'peach', 'plum', 'mango', 'pineapple', 'cantaloupe']],
  ['Pantry', ['flour', 'sugar', 'rice', 'pasta', 'noodle', 'spaghetti', 'penne', 'linguine', 'macaroni', 'orzo', 'couscous', 'oil', 'vinegar', 'sauce', 'soy', 'stock', 'broth', 'bean', 'lentil', 'chickpea', 'oat', 'quinoa', 'canned', 'honey', 'syrup', 'mustard', 'mayo', 'mayonnaise', 'ketchup', 'salsa', 'nut', 'almond', 'walnut', 'pecan', 'cashew', 'pistachio', 'seed', 'sesame', 'yeast', 'cornstarch', 'raisin', 'chocolate', 'cocoa', 'vanilla', 'salt', 'baking', 'wine', 'sherry', 'mirin', 'tahini', 'capers', 'olive', 'pickle', 'relish', 'jam', 'jelly', 'molasses', 'extract', 'gelatin', 'sprinkles']],
];

const CANNED_UNITS = new Set(['can', 'jar', 'bottle', 'box', 'package', 'bag']);

/** Words that describe a staple without changing what you buy. */
const DESCRIPTORS = new Set([
  'freshly', 'fresh', 'ground', 'coarse', 'coarsely', 'finely', 'fine',
  'cracked', 'granulated', 'unsalted', 'salted', 'organic', 'raw', 'pure',
  'cold', 'warm', 'hot', 'lukewarm', 'boiling', 'plain', 'light', 'dark',
]);

function stripDescriptors(canonical) {
  let words = canonical.split(' ');
  while (words.length > 1 && DESCRIPTORS.has(words[0])) words = words.slice(1);
  return words.join(' ');
}

function hasWord(haystack, needle) {
  return new RegExp(`(^|\\s)${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es)?($|\\s)`).test(haystack);
}

function aisleFor(canonical, unit) {
  if (!canonical) return 'Other';
  if (AISLE_OVERRIDES.has(canonical)) return AISLE_OVERRIDES.get(canonical);

  const bare = stripDescriptors(canonical);
  if (AISLE_OVERRIDES.has(bare)) return AISLE_OVERRIDES.get(bare);

  // "fresh basil" is a produce item; "dried basil" is a spice jar.
  if (/^fresh /.test(canonical) && SPICES.has(bare)) return 'Produce';
  if (SPICES.has(bare) || SPICES.has(canonical)) return 'Pantry';
  for (const spice of SPICES) if (hasWord(bare, spice)) return 'Pantry';

  if (unit && CANNED_UNITS.has(unit) && !/frozen/.test(canonical)) {
    // A can of anything lives in an aisle, not the produce section.
    if (!/(milk|cream|yogurt|cheese|butter)/.test(canonical)) return 'Pantry';
  }

  for (const [aisle, keywords] of AISLES) {
    for (const k of keywords) if (hasWord(canonical, k)) return aisle;
  }
  return 'Other';
}

function isStaple(canonical) {
  const set = new Set(STAPLES.map(canonicalName));
  return set.has(canonical) || set.has(stripDescriptors(canonical));
}

/** "1 1/2", "1½", "3/4", "2.5", "2 to 3", "2-3", "two" -> number */
function readAmount(text) {
  let s = text;

  // Ranges: buy for the larger amount.
  const range = s.match(/^\s*([\d.\/¼-⅞ ]+?)\s*(?:-|–|—|\bto\b|\bor\b)\s*([\d.\/¼-⅞]+)\s/);
  if (range) {
    const hi = readAmount(range[2] + ' ');
    if (hi && hi.amount !== null) {
      return { amount: hi.amount, rest: s.slice(range[0].length - 1).trim(), approx: true };
    }
  }

  const m = s.match(/^\s*(\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:\.\d+)?\s*[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]|\d+(?:\.\d+)?)\s*/);
  if (m) {
    const token = m[1].trim();
    let amount = 0;
    const vulgarMatch = token.match(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/);
    if (vulgarMatch) {
      const lead = token.replace(vulgarMatch[0], '').trim();
      amount = (lead ? parseFloat(lead) : 0) + VULGAR[vulgarMatch[0]];
    } else if (token.includes('/')) {
      const parts = token.split(/\s+/);
      const frac = parts.pop().split('/');
      amount = (parts.length ? parseFloat(parts[0]) : 0) + Number(frac[0]) / Number(frac[1]);
    } else {
      amount = parseFloat(token);
    }
    return { amount, rest: s.slice(m[0].length), approx: false };
  }

  const word = s.match(/^\s*([A-Za-z]+)\s+/);
  if (word && WORD_NUMBERS[word[1].toLowerCase()] !== undefined) {
    // "a pinch of salt" is worth catching; "an onion" too.
    return { amount: WORD_NUMBERS[word[1].toLowerCase()], rest: s.slice(word[0].length), approx: false };
  }

  return { amount: null, rest: s, approx: false };
}

/** Pull the unit off the front of `rest`, if there is one. */
function readUnit(rest) {
  const two = rest.match(/^\s*(fl\.?\s*oz\.?|fluid ounces?)\s+/i);
  if (two) return { unit: 'fl oz', rest: rest.slice(two[0].length) };

  const m = rest.match(/^\s*([A-Za-z#]+\.?)\s+/);
  if (!m) return { unit: null, rest };
  const unit = resolveUnit(m[1]);
  if (!unit) return { unit: null, rest };
  return { unit, rest: rest.slice(m[0].length) };
}

function singularize(word) {
  const keep = /^(molasses|asparagus|hummus|couscous|greens|oats|grits|chives|leaves|berries|peas|beans|lentils|noodles|oranges)$/i;
  if (keep.test(word)) {
    // Still fold the obvious plurals of countable produce.
    const fold = { berries: 'berry', peas: 'pea', beans: 'bean', lentils: 'lentil', noodles: 'noodle', oranges: 'orange', chives: 'chive', leaves: 'leaf' };
    return fold[word.toLowerCase()] || word;
  }
  if (/ies$/i.test(word)) return word.slice(0, -3) + 'y';
  if (/(ch|sh|ss|x|z)es$/i.test(word)) return word.slice(0, -2);
  if (/oes$/i.test(word)) return word.slice(0, -2);
  if (/[^s]s$/i.test(word)) return word.slice(0, -1);
  return word;
}

/** The string two ingredient lines must share to be added together. */
function canonicalName(name) {
  let s = name.toLowerCase().trim()
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const words = s.split(' ');
  words[words.length - 1] = singularize(words[words.length - 1]);
  s = words.join(' ');
  return SYNONYMS.get(s) || s;
}

/**
 * Parse one ingredient line.
 * Always succeeds - if it cannot find a quantity it hands back the raw text as
 * the item name, which is exactly what you want on a shopping list.
 */
function parseIngredient(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;

  let s = raw.replace(/^[-•*\u2022]\s*/, '').trim();
  const notes = [];

  // "Juice of 1 lemon" / "Zest of 2 limes" -> buy the fruit.
  const squeeze = s.match(/^(juice|zest|juice and zest|zest and juice)\s+(of|from)\s+/i);
  if (squeeze) {
    notes.push(`for ${squeeze[1].toLowerCase()}`);
    s = s.slice(squeeze[0].length).trim();
  }

  // Parentheticals: "(14 oz)", "(optional)", "(about 2 cups)"
  s = s.replace(/\(([^)]*)\)/g, (_, inner) => {
    notes.push(inner.trim());
    return ' ';
  }).replace(/\s+/g, ' ').trim();

  for (const re of TRAILING_NOTES) {
    const hit = s.match(re);
    if (hit) {
      notes.push(hit[0].replace(/^[,\s]+/, '').trim());
      s = s.replace(re, '').trim();
    }
  }

  const { amount, rest: afterAmount, approx } = readAmount(s);
  let rest = afterAmount;
  let unit = null;

  // Size words can sit on either side of the unit: "1 large head broccoli"
  // and "3 large eggs" both need them peeled off before we look for a unit.
  const eatSizeWords = () => {
    for (;;) {
      const m = rest.match(/^([A-Za-z-]+)\s+/);
      if (!m || !SIZE_WORDS.has(m[1].toLowerCase())) return;
      notes.push(m[1].toLowerCase());
      rest = rest.slice(m[0].length).trim();
    }
  };

  if (amount !== null) {
    eatSizeWords();
    const u = readUnit(rest);
    unit = u.unit;
    rest = u.rest;
  }

  rest = rest.replace(/^\s*(of|de)\s+/i, '').trim();
  eatSizeWords();

  // Everything after the first comma is preparation, not identity.
  const comma = rest.indexOf(',');
  let name = rest;
  if (comma > 0) {
    name = rest.slice(0, comma).trim();
    const tail = rest.slice(comma + 1).trim();
    if (tail) notes.push(tail);
  }

  name = name.replace(/\s+/g, ' ').trim();
  if (!name) {
    name = raw;
  }

  const canonical = canonicalName(name);

  return {
    raw,
    amount,
    unit: amount === null ? null : (unit || 'each'),
    name,
    canonical,
    note: notes.filter(Boolean).join(', '),
    approx,
    aisle: aisleFor(canonical, amount === null ? null : (unit || 'each')),
    staple: isStaple(canonical),
  };
}

module.exports = {
  parseIngredient, canonicalName, aisleFor, isStaple,
  STAPLES, AISLES, SPICES, AISLE_OVERRIDES,
};
