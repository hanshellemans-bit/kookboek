// Shopping list UI: a panel for the third column and a full-screen "in the shop" mode.
// The list is built from the dishes on the menu for the next 7 days plus items typed in by hand (see shop.js for the rules).
import * as db from './db.js';
import { h, fill, ymd, parseYmd } from './util.js';
import { icon } from './icons.js';
import {
  buildShopping, resolveState, withMode, withChecked, sectionOf, shopRange, MANUAL_LABEL, activeManualLines,
  withExtraAdded, withExtraRemoved, isCleared, clearCandidates, withCleared,
} from './shop.js';

const views = new Set();                       // every live list (panel + full-screen) refreshes after a change
export const refreshShopViews = () => views.forEach(v => v.refresh());

async function load() {
  const range = shopRange(ymd(new Date()));
  const [recipes, plan, prefs, checks, extra] = await Promise.all([
    db.listRecipes(), db.listPlan(), db.getSetting('shopPrefs', {}), db.getSetting('shopChecks', {}), db.getSetting('shopExtra', {}),
  ]);
  const byId = new Map(recipes.map(r => [r.identifier, r]));
  const dishes = plan.filter(p => p.date >= range.from && p.date <= range.to).sort((a, b) => a.date.localeCompare(b.date));
  const entries = dishes.map(p => ({ recipe: byId.get(p.recipeId)?.name ?? p.name, lines: byId.get(p.recipeId)?.recipeIngredient ?? [] }));
  const manual = activeManualLines(extra, checks);
  if (manual.length) entries.push({ recipe: MANUAL_LABEL, lines: manual });

  const now = Date.now();
  const all = buildShopping(entries);
  const visible = [];                                                          // "Opruimen" hides ticked plain items
  for (const item of all) {
    const st = resolveState(item.key, prefs, checks, now, item.sig);
    if (!isCleared(item, st, checks, now)) visible.push({ item, st });
  }
  return { range, dishes, manual: manual.length, prefs, checks, extra, all, visible };
}

const rangeText = ({ from, to }) =>
  `${parseYmd(from).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })} – ${parseYmd(to).toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' })}`;

/** The list itself. `big` = larger rows for use in the shop. */
export function createShopView({ big = false } = {}) {
  const el = h('div', { class: 'shoplist' + (big ? ' big' : '') });
  const info = h('p', { class: 'muted small-text' });
  let alive = true;
  let candidates = [];                                          // what "Opruimen" would hide right now

  /** Write the given parts of the shopping state, then refresh every list. */
  async function persist({ prefs, checks, extra }) {
    if (prefs) await db.setSetting('shopPrefs', prefs);
    if (checks) await db.setSetting('shopChecks', checks);
    if (extra) await db.setSetting('shopExtra', extra);
    refreshShopViews();
  }

  // --- add your own items (built once, so typed text survives refreshes) ---
  const addForm = h('form', { class: 'add shopadd', onsubmit: async e => {
    e.preventDefault();
    const input = e.target.elements.newitem;                        // not 'item': elements.item is a built-in method
    const texts = input.value.split(/[,;\n]/).map(x => x.trim()).filter(Boolean);
    if (!texts.length) return;
    input.value = '';
    const [extra, checks] = await Promise.all([db.getSetting('shopExtra', {}), db.getSetting('shopChecks', {})]);
    await persist(withExtraAdded(extra, checks, texts));
  } },
    h('input', { name: 'newitem', placeholder: 'Eigen item toevoegen (bv. 2 l melk, brood)…', autocomplete: 'off' }),
    h('button', { class: 'btn primary', type: 'submit', title: 'Toevoegen aan de lijst' }, '+'));

  // --- clean up: hide every ticked plain item (no pin, no magnifier) ---
  const cleanBtn = h('button', { class: 'btn small', type: 'button', onclick: async () => {
    if (!candidates.length) return;
    if (!confirm(`${candidates.length} afgevinkte ${candidates.length === 1 ? 'item' : 'items'} van de lijst halen?\n` +
      'Items met pin of vergrootglas blijven staan. Komt er later meer van nodig (bv. een extra gerecht), dan verschijnt het item weer.')) return;
    const checks = await db.getSetting('shopChecks', {});
    await persist({ checks: withCleared(checks, candidates) });
  } });

  const row = (item, st, data) => {
    const box = h('input', { type: 'checkbox', checked: st.checked, onchange: async e => {
      await persist({ checks: withChecked(data.checks, item.key, e.target.checked) });
    } });
    const toggle = (kind, titleOn, titleOff) => h('button', {
      type: 'button', class: `ico-btn ${kind}` + (st.mode === kind ? ' on' : ''), title: st.mode === kind ? titleOff : titleOn,
      'aria-pressed': String(st.mode === kind),
      onclick: async () => {
        const next = withMode(data.prefs, data.checks, item.key, st.mode === kind ? '' : kind);   // pin and watch exclude each other
        await persist(next);
      },
    }, icon(kind === 'pin' ? 'pin' : 'search', big ? 20 : 16));
    const own = item.recipes.includes(MANUAL_LABEL);
    return h('li', { class: 'shoprow' + (st.checked ? ' done' : '') + (st.mode ? ' ' + st.mode : '') + (own ? ' own' : ''), title: item.recipes.join(', ') },
      h('label', { class: 'shopmain' }, box, h('span', { class: 'sname' }, item.name), item.text && h('span', { class: 'sqty' }, item.text)),
      toggle('watch', 'Voorraad nakijken (vergrootglas)', 'Vergrootglas weghalen'),
      toggle('pin', 'Altijd in huis (vastpinnen)', 'Pin weghalen'),
      own && h('button', { type: 'button', class: 'ico-btn del', title: 'Zelf toegevoegd item verwijderen', onclick: async () => {
        await persist({ extra: withExtraRemoved(data.extra, item.key) });
      } }, icon('close', big ? 20 : 16)));
  };

  const section = (title, rows, cls) => rows.length
    ? [h('h4', { class: 'shophead ' + cls }, title, h('span', { class: 'muted' }, ` ${rows.length}`)), h('ul', { class: 'shopul ' + cls }, rows)] : [];

  async function refresh() {
    if (!alive) return;
    const data = await load();
    const parts = { watch: [], buy: [], done: [], pin: [] };
    const pinDone = [];                                             // pinned + ticked: after the pinned items still to buy
    for (const { item, st } of data.visible) {
      const sec = sectionOf(st);
      (sec === 'pin' && st.checked ? pinDone : parts[sec]).push(row(item, st, data));
    }
    parts.pin.push(...pinDone);

    candidates = clearCandidates(data.all, data.prefs, data.checks);
    cleanBtn.replaceChildren('🧹 Opruimen' + (candidates.length ? ` (${candidates.length})` : ''));
    cleanBtn.disabled = !candidates.length;
    cleanBtn.title = candidates.length
      ? 'Haal alle afgevinkte items zonder pin of vergrootglas van de lijst'
      : 'Niets op te ruimen: vink eerst items af';

    info.textContent = [
      data.dishes.length ? `${data.dishes.length} ${data.dishes.length === 1 ? 'gerecht' : 'gerechten'} · ${rangeText(data.range)}`
        : `Geen gerechten op het menu voor ${rangeText(data.range)}`,
      data.manual ? `${data.manual} eigen ${data.manual === 1 ? 'item' : 'items'}` : '',
    ].filter(Boolean).join(' · ');

    fill(el, addForm, h('div', { class: 'shoptools' }, info, cleanBtn),
      !data.visible.length && h('p', { class: 'muted' },
        data.dishes.length || data.manual ? 'Alles is opgeruimd.' : 'Zet gerechten op het menu van de komende 7 dagen of voeg zelf iets toe; de ingrediënten verschijnen dan hier.'),
      section('🔍 Eerst thuis nakijken', parts.watch, 'watch'),
      section('🛒 Te kopen', parts.buy, 'buy'),
      section('✓ Afgevinkt', parts.done, 'done'),
      section('📌 Altijd in huis', parts.pin, 'pin'));
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
