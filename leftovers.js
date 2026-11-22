// Match leftover ingredients ("overschotten") against recipe ingredient lines.
// Heuristic for Dutch: compare words; allow plurals/inflections (ui/uien, ei/eieren)
// and compounds (gehakt/rundsgehakt, kaas/roomkaas).

const norm = s =>
  s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, ' ');
const words = s => norm(s).split(/\s+/).filter(Boolean);

// Short words that are units/fillers, not ingredients.
const STOP = new Set(['el', 'tl', 'g', 'gr', 'kg', 'ml', 'dl', 'cl', 'l', 'oz', 'st', 'of', 'en', 'de', 'het', 'een',
  'in', 'te', 'op', 'om', 'met', 'voor', 'per', 'tot', 'bos', 'tak', 'plus']);

// Crude Dutch stemmer: tomaat/tomaten -> tomat, eieren -> eier
function stem(w) {
  w = w.replace(/([aeou])\1/g, '$1');
  if (w.length > 4 && w.endsWith('en')) w = w.slice(0, -2);
  return w;
}

// Short terms (ui, ei, kip): the word may continue with a plural/diminutive ending (uien, uitje) or a compound
// (kipfilet, eiwit), but not with the preposition 'uit' ('tonijn uit blik', 'uitgelekt').
const SHORT_SUFFIXES = ['en', 's', 'e', 'er', 'tje', 'tjes', 'je', 'jes'];

function wordMatches(term, w) {
  if (STOP.has(w) || STOP.has(term)) return false;
  const t = stem(term), x = stem(w);
  if (t === x) return true;
  if (t.length <= 3) {
    if (x.startsWith(t)) {
      const rest = x.slice(t.length);
      if (SHORT_SUFFIXES.includes(rest)) return true;
      if (rest.length >= 3 && !x.startsWith('uit')) return true;
    }
  }
  else if (x.startsWith(t)) return true;                     // varkens -> varkenshaas
  if (x.length >= 2 && t.startsWith(x)) return true;        // eieren -> ei
  if (term.length >= 4 && x.endsWith(t)) return true;          // gehakt -> rundsgehakt
  return false;
}

/** Does a single ingredient line contain the leftover (all its words)? */
export function lineMatches(leftover, line) {
  const lw = words(line);
  const tw = words(leftover);
  return tw.length > 0 && tw.every(t => lw.some(w => wordMatches(t, w)));
}

/** Returns recipes that use at least one leftover, best first, with the matched leftovers. */
export function suggest(recipes, leftovers) {
  if (!leftovers.length) return [];
  return recipes
    .map(recipe => {
      const lines = recipe.recipeIngredient ?? [];
      const matched = leftovers.filter(l => lines.some(line => lineMatches(l, line)));
      return { recipe, matched };
    })
    .filter(x => x.matched.length)
    .sort((a, b) =>
      b.matched.length - a.matched.length ||
      (b.matched.length / (b.recipe.recipeIngredient?.length || 1)) -
        (a.matched.length / (a.recipe.recipeIngredient?.length || 1)) ||
      a.recipe.name.localeCompare(b.recipe.name, 'nl'));
}
