// "Suggesties van de chef": first version of the scoring algorithm. Meant to be refined later.
//
// score = wStars * stars + wRecency * recency + wSeason * season      (every part is 0..1)
//   stars   : (rating - 1) / 4; unrated = 0.5 (neutral)
//   recency : never made = 0.9; otherwise days since last made / 90, capped at 1 (made today = 0)
//   season  : share of the recipe's Belgian produce that is in season now; no such produce = 0.5 (neutral)

import { seasonInfo } from './season.js';
import { agoText, daysBetween, ymd } from './util.js';

export const WEIGHTS = { stars: 0.40, recency: 0.35, season: 0.25 };
export const RECENCY_FULL_DAYS = 90;       // after this many days a recipe counts as "due again"
export const NEVER_MADE_RECENCY = 0.9;

export function scoreRecipe(recipe, { lastCooked, today = ymd(new Date()), month = new Date().getMonth() + 1 }) {
  const rating = recipe['x-rating'] || 0;
  const stars = rating ? (rating - 1) / 4 : 0.5;

  const days = lastCooked ? daysBetween(lastCooked, today) : null;
  const recency = days == null ? NEVER_MADE_RECENCY : Math.min(1, Math.max(0, days) / RECENCY_FULL_DAYS);

  const season = seasonInfo(recipe, month);
  const seasonScore = season.score ?? 0.5;

  const score = WEIGHTS.stars * stars + WEIGHTS.recency * recency + WEIGHTS.season * seasonScore;

  const why = [];
  why.push(days == null ? '🍽 nog nooit gemaakt' : `🍽 laatst gemaakt ${agoText(days)}`);
  if (season.inSeason.length) why.push('🌱 in seizoen: ' + season.inSeason.join(', '));
  if (season.outSeason.length) why.push('⚠ buiten seizoen: ' + season.outSeason.join(', '));

  return { score, parts: { stars, recency, season: seasonScore }, why };
}

/** Best `limit` recipes first. `lastCookedOf(id)` returns 'YYYY-MM-DD' or undefined. */
export function chefSuggestions(recipes, lastCookedOf, limit = 8, now = new Date()) {
  const ctx = { today: ymd(now), month: now.getMonth() + 1 };
  return recipes
    .map(recipe => ({ recipe, ...scoreRecipe(recipe, { ...ctx, lastCooked: lastCookedOf(recipe.identifier) }) }))
    .sort((a, b) => b.score - a.score || a.recipe.name.localeCompare(b.recipe.name, 'nl'))
    .slice(0, limit);
}
