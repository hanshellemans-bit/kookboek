// The ranking behind the home list AND the detail page: one score per recipe, in the chef's order.
// The home list shows it; the detail page shows the same score and the reasons, and walks through the same order with ‹ ›.
import { chefSuggestions } from './chef.js';
import { planStats, ymd, addDays, fmtDay, parseYmd } from './util.js';

export const SKIP_PLANNED_DAYS = 14;        // a dish on the menu today .. +13 days sinks to the bottom of the list

/** The order of the list as the home page last showed it (after its filters). The detail page's ‹ › follow it. */
export const browse = { ids: [] };

/** 🔗 probable leftovers (x-likelyLeftovers) of the dishes on the menu from yesterday up to 6 days ahead. */
export function linksFromEntries(entries, byId, now = new Date()) {
  const from = ymd(addDays(now, -1)), to = ymd(addDays(now, 6)), out = [];
  for (const e of entries) {
    const r = e.date >= from && e.date <= to ? byId.get(e.recipeId) : null;
    for (const item of r?.['x-likelyLeftovers'] ?? []) out.push({ item, from: r.name, fromId: r.identifier });
  }
  return out;
}

/**
 * recipes: all recipes; entries: active menu entries [{date, recipeId}]; filter: which recipes take part (home filters).
 * -> { items: [{ recipe, score 0-100, why: [...], planned, plannedOn }], pool, plannedInPool, stats }
 * Best first; what is already on the menu for the next 14 days comes last.
 */
export function buildRanking({ recipes, entries, leftovers = [], filter = () => true, now = new Date() }) {
  const stats = planStats(entries, ymd(now));
  const today = ymd(now), until = ymd(addDays(now, SKIP_PLANNED_DAYS - 1));
  const plannedOn = new Map();                                   // recipe id -> first day (today .. +13) on the menu
  for (const e of [...entries].sort((x, y) => x.date.localeCompare(y.date))) {
    if (e.date >= today && e.date <= until && !plannedOn.has(e.recipeId)) plannedOn.set(e.recipeId, e.date);
  }
  const byId = new Map(recipes.map(r => [r.identifier, r]));
  const pool = recipes.filter(filter);
  const scored = chefSuggestions(pool, id => stats.last.get(id), Infinity, now, leftovers, linksFromEntries(entries, byId, now));
  const free = scored.filter(x => !plannedOn.has(x.recipe.identifier));
  const planned = scored.filter(x => plannedOn.has(x.recipe.identifier));
  const items = [...free, ...planned].map(p => {
    const on = plannedOn.get(p.recipe.identifier) ?? null;
    return {
      recipe: p.recipe, score: Math.round(p.score * 100), planned: !!on, plannedOn: on,
      why: [...(on ? [`📅 gepland ${fmtDay(parseYmd(on))}`] : []), ...p.why],
    };
  });
  return { items, pool: pool.length, plannedInPool: planned.length, stats };
}
