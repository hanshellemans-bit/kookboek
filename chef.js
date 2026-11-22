// "Suggesties van de chef": first version of the scoring algorithm. Meant to be refined later.
//
// Every part is 0..1:
//   stars   : (rating - 1) / 4; unrated = 0.5 (neutral)
//   recency : never made = 0.9; otherwise days since last made / 90, capped at 1 (made today = 0)
//   season  : share of the recipe's Belgian produce that is in season now; no such produce = 0.5 (neutral)
//   eco     : how many of your leftovers ("ECO Cooking") the recipe uses; using 3 or more (or all, if you listed fewer) = 1
//
// score = wStars*stars + wRecency*recency + wSeason*season                     (no leftovers listed)
// score = ... + wEco*eco, with weights that favour eco                          (leftovers listed: recipes that use them rank high)

import { seasonInfo } from './season.js';
import { lineMatches } from './leftovers.js';
import { agoText, daysBetween, ymd } from './util.js';

export const WEIGHTS = { stars: 0.40, recency: 0.35, season: 0.25 };
export const WEIGHTS_ECO = { stars: 0.20, recency: 0.15, season: 0.15, eco: 0.50 };
export const RECENCY_FULL_DAYS = 90;       // after this many days a recipe counts as "due again"
export const NEVER_MADE_RECENCY = 0.9;
export const ECO_FULL_AT = 3;              // using this many leftovers is the maximum eco score

/** Which of the leftovers does this recipe use? */
export function ecoMatches(recipe, leftovers = []) {
  const lines = recipe.recipeIngredient ?? [];
  return leftovers.filter(l => lines.some(line => lineMatches(l, line)));
}

export function scoreRecipe(recipe, { lastCooked, today = ymd(new Date()), month = new Date().getMonth() + 1, leftovers = [] }) {
  const rating = recipe['x-rating'] || 0;
  const stars = rating ? (rating - 1) / 4 : 0.5;

  const days = lastCooked ? daysBetween(lastCooked, today) : null;
  const recency = days == null ? NEVER_MADE_RECENCY : Math.min(1, Math.max(0, days) / RECENCY_FULL_DAYS);

  const season = seasonInfo(recipe, month);
  const seasonScore = season.score ?? 0.5;

  const matched = ecoMatches(recipe, leftovers);
  const eco = Math.min(1, matched.length / Math.max(1, Math.min(leftovers.length, ECO_FULL_AT)));

  const w = leftovers.length ? WEIGHTS_ECO : WEIGHTS;
  const score = w.stars * stars + w.recency * recency + w.season * seasonScore + (leftovers.length ? w.eco * eco : 0);

  const why = [];
  if (matched.length) why.push('🌿 gebruikt je overschotten: ' + matched.join(', '));
  why.push(days == null ? '🍽 nog nooit gemaakt' : `🍽 laatst gemaakt ${agoText(days)}`);
  if (season.inSeason.length) why.push('🌱 in seizoen: ' + season.inSeason.join(', '));
  if (season.outSeason.length) why.push('⚠ buiten seizoen: ' + season.outSeason.join(', '));

  return { score, parts: { stars, recency, season: seasonScore, eco }, why, matched };
}

/** Best `limit` recipes first. `lastCookedOf(id)` returns 'YYYY-MM-DD' or undefined; `leftovers` = the ECO Cooking list. */
export function chefSuggestions(recipes, lastCookedOf, limit = 8, now = new Date(), leftovers = []) {
  const ctx = { today: ymd(now), month: now.getMonth() + 1, leftovers };
  return recipes
    .map(recipe => ({ recipe, ...scoreRecipe(recipe, { ...ctx, lastCooked: lastCookedOf(recipe.identifier) }) }))
    .sort((a, b) => b.score - a.score || a.recipe.name.localeCompare(b.recipe.name, 'nl'))
    .slice(0, limit);
}
