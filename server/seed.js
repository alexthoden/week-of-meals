'use strict';

const crypto = require('crypto');
const storage = require('./lib/storage');

/*
 * Seeds the first household. With recipes now belonging to a household rather
 * than to the installation, "seed the database" has to name one; the first is
 * the only sensible default, and storage.create() will have made it if this is
 * a fresh checkout.
 */
const { registry, forHousehold } = storage.create();
const household = registry.all()[0] || registry.create({ name: 'Home' });

const RECIPES = [
  {
    title: 'Sheet Pan Chicken and Potatoes',
    time: '50 min', servings: '4 servings', tags: ['weeknight', 'one pan'], category: 'dinner',
    ingredients: [
      '2 lb bone-in chicken thighs',
      '1.5 lb baby potatoes, halved',
      '1 lemon, cut into wedges',
      '4 cloves garlic, smashed',
      '3 tbsp olive oil',
      '1 tsp smoked paprika',
      '1 tsp dried oregano',
      '1 tsp kosher salt',
      'freshly ground black pepper',
    ],
    steps: [
      'Heat the oven to 425°F.',
      'Toss the potatoes and garlic with 2 tbsp olive oil, the paprika, oregano, salt and pepper. Spread on a sheet pan.',
      'Rub the chicken with the remaining oil, season, and nestle it skin side up among the potatoes with the lemon wedges.',
      'Roast 40 to 45 minutes, until the skin is browned and the potatoes are tender.',
    ],
  },
  {
    title: 'Weeknight Beef Chili',
    time: '45 min', servings: '6 servings', tags: ['make ahead', 'freezes well'], category: 'dinner',
    ingredients: [
      '1 lb ground beef',
      '1 large yellow onion, diced',
      '3 cloves garlic, minced',
      '1 red bell pepper, chopped',
      '2 tbsp tomato paste',
      '1 can (28 oz) crushed tomatoes',
      '1 can (15 oz) kidney beans, drained and rinsed',
      '2 tbsp chili powder',
      '1 tbsp ground cumin',
      '1 tsp kosher salt',
      '2 tbsp olive oil',
    ],
    steps: [
      'Brown the beef in the oil over medium-high heat, breaking it up. Set aside.',
      'Soften the onion and bell pepper in the same pot, about 6 minutes. Add the garlic, chili powder and cumin and cook 1 minute more.',
      'Stir in the tomato paste, then the crushed tomatoes, beans, beef and salt.',
      'Simmer uncovered 25 minutes, stirring now and then. Taste and adjust the salt.',
    ],
  },
  {
    title: 'Garlic Butter Shrimp Pasta',
    time: '25 min', servings: '4 servings', tags: ['fast', 'kid approved'], category: 'dinner',
    ingredients: [
      '1 lb linguine',
      '1 lb large shrimp, peeled and deveined',
      '4 tbsp unsalted butter',
      '6 cloves garlic, thinly sliced',
      '1/2 tsp red pepper flakes',
      '1/2 cup dry white wine',
      '1 lemon',
      '1/4 cup fresh parsley, chopped',
      '1/2 cup grated Parmesan',
      'kosher salt',
    ],
    steps: [
      'Boil the linguine in well salted water. Reserve a cup of pasta water before draining.',
      'Melt the butter in a wide skillet, add the garlic and pepper flakes and cook until fragrant, about 1 minute.',
      'Add the shrimp and cook 2 minutes per side. Remove them so they do not overcook.',
      'Pour in the wine and let it reduce by half. Add the pasta, shrimp, a squeeze of lemon and enough pasta water to make a glossy sauce.',
      'Off the heat, toss with the parsley and Parmesan.',
    ],
  },
  {
    title: 'Black Bean and Sweet Potato Tacos',
    time: '35 min', servings: '4 servings', tags: ['vegetarian', 'weeknight'], category: 'dinner',
    ingredients: [
      '2 medium sweet potatoes, cut into 1/2 inch cubes',
      '1 can (15 oz) black beans, drained and rinsed',
      '2 tbsp olive oil',
      '1 tsp ground cumin',
      '1 tsp chili powder',
      '12 corn tortillas',
      '1 avocado, sliced',
      '1/2 cup crumbled feta',
      '1/4 cup fresh cilantro',
      '2 limes',
      '1/2 red onion, thinly sliced',
    ],
    steps: [
      'Heat the oven to 425°F. Toss the sweet potatoes with the oil, cumin and chili powder and roast 25 minutes, turning once.',
      'Warm the beans in a small pot with a splash of water and a pinch of salt.',
      'Char the tortillas directly over a burner or in a dry skillet.',
      'Build the tacos with sweet potato, beans, avocado, feta, red onion, cilantro and a hard squeeze of lime.',
    ],
  },
  {
    title: 'Chicken Stir Fry with Broccoli',
    time: '30 min', servings: '4 servings', tags: ['fast', 'one pan'], category: 'dinner',
    ingredients: [
      '1.5 lb boneless skinless chicken thighs, sliced thin',
      '1 large head broccoli, cut into florets',
      '3 cloves garlic, minced',
      '1 tbsp fresh ginger, grated',
      '1/4 cup soy sauce',
      '2 tbsp oyster sauce',
      '1 tbsp cornstarch',
      '1 tbsp vegetable oil',
      '1 bunch scallions, sliced',
      '2 cups jasmine rice',
      '1 tsp sesame seeds',
    ],
    steps: [
      'Start the rice.',
      'Toss the chicken with the cornstarch. Whisk the soy sauce and oyster sauce with 1/4 cup water.',
      'Sear the chicken in a very hot wok or skillet until browned, about 5 minutes. Remove.',
      'Add the broccoli and a splash of water, cover and steam 3 minutes. Add the garlic and ginger for 30 seconds.',
      'Return the chicken, pour in the sauce and toss until it thickens. Finish with scallions and sesame seeds over rice.',
    ],
  },
  {
    title: 'Baked Ziti',
    time: '1 hr', servings: '8 servings', tags: ['make ahead', 'crowd'], category: 'dinner',
    ingredients: [
      '1 lb ziti',
      '1 lb Italian sausage, casings removed',
      '1 jar (24 oz) marinara sauce',
      '15 oz whole milk ricotta',
      '2 cups shredded mozzarella',
      '1/2 cup grated Parmesan',
      '1 large egg',
      '3 cloves garlic, minced',
      '1/4 cup fresh basil',
      '1 tsp kosher salt',
    ],
    steps: [
      'Heat the oven to 375°F. Boil the ziti two minutes short of the package time and drain.',
      'Brown the sausage with the garlic, then stir in the marinara.',
      'Mix the ricotta with the egg, Parmesan, basil and salt.',
      'Layer half the pasta and sauce in a 9x13 dish, dollop over the ricotta, add the rest, then the mozzarella.',
      'Bake 30 minutes, until bubbling and browned at the edges. Rest 10 minutes before cutting.',
    ],
  },
  {
    title: 'Greek Salad with Grilled Chicken',
    time: '25 min', servings: '4 servings', tags: ['light', 'fast'], category: 'lunch',
    ingredients: [
      '1.5 lb boneless skinless chicken breasts',
      '1 English cucumber, chopped',
      '3 medium tomatoes, cut into wedges',
      '1/2 red onion, thinly sliced',
      '1 cup kalamata olives',
      '6 oz feta, cubed',
      '1/4 cup extra virgin olive oil',
      '2 tbsp red wine vinegar',
      '1 tsp dried oregano',
      '1 lemon',
      'kosher salt',
      'freshly ground black pepper',
    ],
    steps: [
      'Season the chicken with salt, pepper and oregano and grill 6 minutes per side. Rest, then slice.',
      'Whisk the olive oil, vinegar, a squeeze of lemon and a pinch of salt.',
      'Toss the cucumber, tomatoes, onion and olives with the dressing.',
      'Top with the feta and the sliced chicken.',
    ],
  },
  {
    title: 'Creamy Tomato Soup and Grilled Cheese',
    time: '40 min', servings: '4 servings', tags: ['comfort', 'kid approved'], category: 'lunch',
    ingredients: [
      '2 cans (28 oz each) whole peeled tomatoes',
      '1 medium yellow onion, chopped',
      '4 cloves garlic',
      '2 tbsp unsalted butter',
      '1/2 cup heavy cream',
      '1 tsp sugar',
      '1 tsp kosher salt',
      '8 slices sourdough bread',
      '8 oz sharp cheddar, sliced',
      '1/4 cup fresh basil',
    ],
    steps: [
      'Soften the onion and garlic in the butter over medium heat, about 8 minutes.',
      'Add the tomatoes with their juice, the sugar and salt. Simmer 20 minutes.',
      'Blend until smooth, then stir in the cream and the basil.',
      'Butter the bread, build the sandwiches with cheddar and griddle over medium-low until deeply golden.',
    ],
  },
  {
    title: 'Honey Garlic Salmon',
    time: '20 min', servings: '4 servings', tags: ['fast', 'light'], category: 'dinner',
    ingredients: [
      '4 salmon fillets (6 oz each)',
      '3 tbsp honey',
      '3 cloves garlic, minced',
      '2 tbsp soy sauce',
      '1 tbsp rice vinegar',
      '1 tbsp olive oil',
      '1 lb asparagus, trimmed',
      '1 lemon',
      'kosher salt',
    ],
    steps: [
      'Whisk the honey, garlic, soy sauce and vinegar.',
      'Sear the salmon skin side down in the oil over medium-high heat for 4 minutes.',
      'Flip, add the asparagus alongside, pour in the sauce and cook 4 minutes more, spooning the glaze over the fish.',
      'Finish with a squeeze of lemon.',
    ],
  },
  {
    title: 'Breakfast for Dinner Pancakes',
    time: '30 min', servings: '4 servings', tags: ['kid approved', 'breakfast'], category: 'breakfast',
    ingredients: [
      '2 cups all-purpose flour',
      '2 tbsp sugar',
      '2 tsp baking powder',
      '1/2 tsp baking soda',
      '1/2 tsp kosher salt',
      '2 cups buttermilk',
      '2 large eggs',
      '4 tbsp unsalted butter, melted',
      '1 lb bacon',
      'maple syrup, for serving',
    ],
    steps: [
      'Bake the bacon on a sheet pan at 400°F for 18 minutes while you make the batter.',
      'Whisk the dry ingredients. In another bowl whisk the buttermilk, eggs and melted butter.',
      'Fold wet into dry until just combined. Lumps are fine and a rested batter is better.',
      'Cook on a buttered griddle over medium heat until bubbles set at the edges, then flip.',
    ],
  },
];

const { store } = forHousehold(household.id);
const existing = new Set(store.data.recipes.map((r) => r.title.toLowerCase()));
let added = 0;

store.update((d) => {
  for (const r of RECIPES) {
    if (existing.has(r.title.toLowerCase())) continue;
    d.recipes.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      source: '',
      notes: '',
      ...r,
    });
    added += 1;
  }
});

console.log(added
  ? `Added ${added} starter recipe${added === 1 ? '' : 's'} to ${household.name} (${store.file})`
  : 'Starter recipes were already there, nothing to do.');
