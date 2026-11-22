// Shopping list UI: a panel for the third column and a full-screen "in the shop" mode.
// The list is built from the dishes on the menu for the next 7 days (see shop.js for the rules).
import * as db from './db.js';
import { h, ymd, addDays, fmtDay, parseYmd } from './util.js';
import { icon } from './icons.js';
import { buildShopping, resolveState, withMode, withChecked, sectionOf, shopRange } from './shop.js';

const views = new Set();                       // every live list (panel + full-screen) refreshes after a change
export const refreshShopViews = () => views.forEach(v => v.refresh());

async function load() {
  const range = shopRange(ymd(new Date()));
  const [recipes, plan, prefs, checks] = await Promise.all([
    db.listRecipes(), db.listPlan(), db.getSetting('shopPrefs', {}), db.getSetting('shopChecks', {}),
  ]);
  const byId = new Map(recipes.map(r => [r.identifier, r]));
  const dishes = plan.filter(p => p.date >= range.from && p.date <= range.to).sort((a, b) => a.date.localeCompare(b.date));
  const entries = dishes.map(p => ({ recipe: byId.get(p.recipeId)?.name ?? p.name, lines: byId.get(p.recipeId)?.recipeIngredient ?? [] }));
  return { range, dishes, prefs, checks, items: buildShopping(entries) };
}

const rangeText = ({ from, to }) =>
  `${parseYmd(from).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })} – ${parseYmd(to).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })}`;

/** The list itself. `big` = larger rows for use in the shop. */
export function createShopView({ big = false } = {}) {
  const el = h('div', { class: 'shoplist' + (big ? ' big' : '') });
  const info = h('p', { class: 'muted small-text' });
  let alive = true;

  async function save(prefs, checks) {
    await db.setSetting('shopPrefs', prefs);
    await db.setSetting('shopChecks', checks);
    refreshShopViews();
  }

  const row = (item, st, data) => {
    const box = h('input', { type: 'checkbox', checked: st.checked, onchange: async e => {
      await save(data.prefs, withChecked(data.checks, item.key, e.target.checked));
    } });
    const toggle = (kind, titleOn, titleOff) => h('button', {
      type: 'button', class: `ico-btn ${kind}` + (st.mode === kind ? ' on' : ''), title: st.mode === kind ? titleOff : titleOn,
      'aria-pressed': String(st.mode === kind),
      onclick: async () => {
        const next = withMode(data.prefs, data.checks, item.key, st.mode === kind ? '' : kind);   // pin and watch exclude each other
        await save(next.prefs, next.checks);
      },
    }, icon(kind === 'pin' ? 'pin' : 'search', big ? 20 : 16));
    return h('li', { class: 'shoprow' + (st.checked ? ' done' : '') + (st.mode ? ' ' + st.mode : ''), title: item.recipes.join(', ') },
      h('label', { class: 'shopmain' }, box, h('span', { class: 'sname' }, item.name), item.text && h('span', { class: 'sqty' }, item.text)),
      toggle('watch', 'Voorraad nakijken (vergrootglas)', 'Vergrootglas weghalen'),
      toggle('pin', 'Altijd in huis (vastpinnen)', 'Pin weghalen'));
  };

  const section = (title, rows, cls) => rows.length
    ? [h('h4', { class: 'shophead ' + cls }, title, h('span', { class: 'muted' }, ` ${rows.length}`)), h('ul', { class: 'shopul ' + cls }, rows)] : [];

  async function refresh() {
    if (!alive) return;
    const data = await load();
    const parts = { watch: [], buy: [], done: [] };
    for (const item of data.items) {
      const st = resolveState(item.key, data.prefs, data.checks);
      parts[sectionOf(st)].push(row(item, st, data));
    }
    info.textContent = data.dishes.length
      ? `${data.dishes.length} ${data.dishes.length === 1 ? 'gerecht' : 'gerechten'} · ${rangeText(data.range)}`
      : `Geen gerechten op het menu voor ${rangeText(data.range)}.`;
    el.replaceChildren(info,
      ...(data.dishes.length ? [] : [h('p', { class: 'muted' }, 'Zet gerechten op het menu van de komende 7 dagen; hun ingrediënten verschijnen dan hier.')]),
      ...section('🔍 Eerst thuis nakijken', parts.watch, 'watch'),
      ...section('🛒 Te kopen', parts.buy, 'buy'),
      ...section('✓ Afgevinkt / altijd in huis', parts.done, 'done'));
  }

  const view = { el, refresh, destroy() { alive = false; views.delete(view); } };
  views.add(view);
  refresh();
  return view;
}

/** Full-screen shop mode: big rows, screen stays on. */
let overlay = null;
export function closeShopFullscreen() {
  if (!overlay) return;
  overlay.view.destroy();
  overlay.wake?.release().catch(() => {});
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  overlay.el.remove();
  overlay = null;
}

export async function openShopFullscreen() {
  closeShopFullscreen();
  const view = createShopView({ big: true });
  const el = h('div', { class: 'shopfull' },
    h('div', { class: 'shopfull-head' },
      h('h2', {}, '🛒 Boodschappen'),
      h('button', { class: 'btn', type: 'button', onclick: closeShopFullscreen }, icon('close', 20), ' Sluiten')),
    view.el);
  document.body.append(el);
  overlay = { el, view, wake: null };
  try { await el.requestFullscreen?.({ navigationUI: 'hide' }); } catch { /* not allowed: the overlay still covers the page */ }
  try { overlay.wake = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
  // leaving real fullscreen with the browser's own gesture also closes the overlay
  el.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && overlay?.el === el) closeShopFullscreen(); });
}

/** Panel for the third column. */
export function createShopPanel() {
  const view = createShopView();
  const panel = h('section', { class: 'panel shoppanel' },
    h('div', { class: 'row between' },
      h('h2', { style: 'margin:0' }, '🛒 Boodschappen'),
      h('button', { class: 'btn small icon-text', type: 'button', title: 'Schermvullend, om in de winkel af te vinken', onclick: openShopFullscreen },
        icon('fullscreen', 16), ' Winkel')),
    view.el);
  return { el: panel, view };
}
