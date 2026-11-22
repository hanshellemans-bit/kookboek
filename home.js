// Home view.
//   top (sticky, collapsible): the week menu (drag & drop) with month overview
//   left: ECO cooking (leftovers) + filters   centre: recipes   right: shopping list for the next 7 days
import * as db from './db.js';
import { lineMatches } from './leftovers.js';
import { dnd, makeDraggable } from './dnd.js';
import { importControls } from './importer.js';
import { chefSuggestions } from './chef.js';
import { icon } from './icons.js';
import { createShopPanel, refreshShopViews } from './shopui.js';
import {
  h, urlFor, minutes, fmtMinutes, ymd, parseYmd, addDays, mondayOf, daysBetween, fmtDay, planStats, whenText,
} from './util.js';

// UI state that survives navigating to a recipe and back. The "Gang" filter starts on Hoofdgerecht.
const ui = {
  q: '', cat: 'Hoofdgerecht', chef: '', source: '', tags: [], ingr: '', maxTime: '', since: '', minStars: '', fav: false, sort: 'name',
  weekStart: addDays(new Date(), 0), month: null,          // the week strip starts TODAY (rolling 7 days), not on Monday
};
const MENU_KEY = 'kookboek.menuOpen';

let modal = null;        // open overlay (month view / recipe picker)
let redrawMonth = null;
let layoutObserver = null;
let shopPanel = null;
export function closeModal() {
  modal?.remove();
  modal = null;
  redrawMonth = null;
}

const collator = new Intl.Collator('nl', { sensitivity: 'base' });
const uniqueSorted = list => [...new Set(list.filter(Boolean))].sort(collator.compare);
const tagsOf = r => (r.keywords ?? '').split(',').map(t => t.trim()).filter(Boolean);
const totalMinutes = r => minutes(r.prepTime) + minutes(r.cookTime);

export async function renderHome(root, reload) {
  closeModal();
  const [recipes, planList, savedLeftovers] = await Promise.all([
    db.listRecipes(), db.listPlan(), db.getSetting('leftovers', []),
  ]);

  if (!recipes.length) {
    root.replaceChildren(h('div', { class: 'empty' }, h('p', {}, 'Nog geen recepten.'),
      h('p', { class: 'muted' }, 'Druk rechtsboven op ☁ Sync om je recepten van Google Drive op te halen, of zet een back-up terug via ⚙.'),
      importControls(reload)));
    return;
  }
  recipes.sort((a, b) => collator.compare(a.name, b.name));

  const byId = new Map(recipes.map(r => [r.identifier, r]));
  let leftovers = savedLeftovers;
  const groupByDate = list => {
    const m = new Map();
    for (const e of list) m.set(e.date, [...(m.get(e.date) ?? []), e]);
    return m;
  };
  let plan = groupByDate(planList);                        // date -> [entries]: any number of dishes per day
  const allEntries = () => [...plan.values()].flat();
  let stats = planStats(planList);

  const chefs = uniqueSorted(recipes.map(r => r.author?.name));
  const chefSet = new Set(chefs);
  const cats = uniqueSorted(recipes.map(r => r.recipeCategory));
  const sources = uniqueSorted(recipes.map(r => r.isBasedOn));
  const allTags = uniqueSorted(recipes.flatMap(tagsOf)).filter(t => !chefSet.has(t));  // chef has its own dropdown
  if (ui.cat && !cats.includes(ui.cat)) ui.cat = '';                                   // default course does not exist (yet)

  // ---------- recipe cards ----------
  const card = (r, matched, why, score) => {
    const img = h('img', { class: 'thumb', alt: '', draggable: 'false' });
    if (r.image?.[0]) db.getImage(db.imageKey(r.identifier, r.image[0])).then(b => b && (img.src = urlFor(b)));
    const el = h('a', { class: 'card', href: `#/r/${r.identifier}`, title: score != null ? `Score ${score}/100` : null },
      img,
      h('div', { class: 'info' },
        h('div', { class: 'name' }, (r['x-favourite'] ? '★ ' : '') + r.name),
        h('div', { class: 'sub' }, [r['x-rating'] ? '★'.repeat(r['x-rating']) : '', r.recipeCategory, fmtMinutes(totalMinutes(r))].filter(Boolean).join(' · ')),
        why ? h('div', { class: 'why' }, why.map(w => h('div', {}, w))) : h('div', { class: 'when' }, whenText(r.identifier, stats)),
        matched && h('div', { class: 'match' }, '✓ ' + matched.join(', '))
      )
    );
    makeDraggable(el, { type: 'recipe', id: r.identifier }, r.name);
    return el;
  };

  // ---------- leftovers (left, top): green = recipes available, red = none ----------
  const chips = h('div', { class: 'chips' });
  const recipeCount = item => recipes.filter(r => (r.recipeIngredient ?? []).some(line => lineMatches(item, line))).length;
  const saveLeftovers = async () => {
    await db.setSetting('leftovers', leftovers);
    await db.setSetting('leftoversUpdatedAt', new Date().toISOString());   // for sync
    drawLeftovers(); drawChef();                       // leftovers raise the score of recipes that use them
  };
  const drawLeftovers = () => chips.replaceChildren(...leftovers.map(l => {
    const n = recipeCount(l);
    return h('span', { class: 'chip ' + (n ? 'ok' : 'none'), title: n ? `${n} ${n === 1 ? 'recept' : 'recepten'}` : 'Geen recepten met dit ingrediënt' },
      l, h('button', { type: 'button', title: `Verwijder ${l}`, onclick: () => {
        leftovers = leftovers.filter(x => x !== l); saveLeftovers();
      } }, '×'));
  }));

  const leftoverPanel = h('section', { class: 'panel' },
    h('h2', { style: 'margin-bottom:0' }, '🌿 ECO Cooking'),
    h('p', { class: 'muted small-text', style: 'margin:0 0 8px' }, 'Overschotten of recht van het veld'),
    h('form', { class: 'add', onsubmit: e => {
      e.preventDefault();
      const input = e.target.elements.overschot;
      for (const it of input.value.split(/[,;\n]/).map(x => x.trim()).filter(Boolean)) {
        if (!leftovers.some(l => l.toLowerCase() === it.toLowerCase())) leftovers.push(it);
      }
      input.value = '';
      saveLeftovers();
    } },
      h('input', { name: 'overschot', placeholder: 'bv. kip, prei, room…', autocomplete: 'off' }),
      h('button', { class: 'btn primary', type: 'submit' }, '+')),
    chips,
    h('button', { class: 'btn small', type: 'button', onclick: () => { leftovers = []; saveLeftovers(); } }, 'Lijst wissen')
  );

  // ---------- filters (left, below) ----------
  const select = (label, key, values) =>
    h('label', { class: 'f' }, label,
      h('select', { onchange: e => { ui[key] = e.target.value; drawMain(); } },
        h('option', { value: '', selected: ui[key] === '' }, 'Alle'),
        values.map(([v, text]) => h('option', { value: v, selected: v === ui[key] }, text))));
  const pairs = list => list.map(v => [v, v]);

  const tagBox = h('div', { class: 'chips' });
  const drawTags = () => tagBox.replaceChildren(...allTags.map(t =>
    h('button', { type: 'button', class: 'tag' + (ui.tags.includes(t) ? ' on' : ''), onclick: () => {
      ui.tags = ui.tags.includes(t) ? ui.tags.filter(x => x !== t) : [...ui.tags, t];
      drawTags(); drawMain();
    } }, t)));

  const filterPanel = h('section', { class: 'panel' },
    h('h2', {}, '🔎 Filters'),
    h('p', { class: 'muted small-text', style: 'margin:0 0 6px' }, 'Gelden voor "Suggesties van de chef" en "Alle recepten".'),
    h('input', { type: 'search', placeholder: 'Zoeken…', value: ui.q,
      oninput: e => { ui.q = e.target.value; drawMain(); } }),
    select('Gang', 'cat', pairs(cats)),
    select('Chef', 'chef', pairs(chefs)),
    select('Bron', 'source', pairs(sources)),
    allTags.length ? h('div', { class: 'f' }, 'Tags', tagBox) : null,
    h('label', { class: 'f' }, 'Bevat ingrediënt(en)',
      h('input', { placeholder: 'bv. kip, room', value: ui.ingr, oninput: e => { ui.ingr = e.target.value; drawMain(); } })),
    select('Totale tijd', 'maxTime', [['30', '≤ 30 min'], ['45', '≤ 45 min'], ['60', '≤ 1 uur'], ['90', '≤ 1,5 uur']]),
    select('Beoordeling', 'minStars', [['3', '★★★ of meer'], ['4', '★★★★ of meer'], ['5', '★★★★★']]),
    select('Gekookt', 'since', [['never', 'Nog nooit'], ['14', 'Langer dan 2 weken geleden'], ['30', 'Langer dan 1 maand geleden'],
      ['90', 'Langer dan 3 maanden geleden']]),
    h('label', { class: 'f check' },
      h('input', { type: 'checkbox', checked: ui.fav, onchange: e => { ui.fav = e.target.checked; drawMain(); } }), ' ★ Alleen favorieten'),
    h('label', { class: 'f' }, 'Sorteren',
      h('select', { onchange: e => { ui.sort = e.target.value; drawMain(); } },
        [['name', 'Naam'], ['rating', 'Beste beoordeling'], ['oldest', 'Langst niet gekookt'], ['recent', 'Recent gekookt']]
          .map(([v, t]) => h('option', { value: v, selected: v === ui.sort }, t)))),
    h('button', { class: 'btn small', type: 'button', onclick: () => {
      Object.assign(ui, { q: '', cat: '', chef: '', source: '', tags: [], ingr: '', maxTime: '', since: '', minStars: '', fav: false, sort: 'name' });
      reload();
    } }, 'Filters wissen')
  );

  // ---------- centre: ECO row, chef suggestions, all recipes ----------
  const grid = h('div', { class: 'grid' });
  const count = h('span', { class: 'muted' });
  const chefInfo = h('p', { class: 'muted' });
  const chefStrip = h('div', { class: 'strip' });

  const passes = r => {
    if (ui.cat && r.recipeCategory !== ui.cat) return false;
    if (ui.chef && r.author?.name !== ui.chef) return false;
    if (ui.source && r.isBasedOn !== ui.source) return false;
    if (ui.fav && !r['x-favourite']) return false;
    if (ui.minStars && (r['x-rating'] || 0) < +ui.minStars) return false;
    const tags = tagsOf(r);
    if (ui.tags.some(t => !tags.includes(t))) return false;
    if (ui.maxTime && !(totalMinutes(r) && totalMinutes(r) <= +ui.maxTime)) return false;
    if (ui.since) {
      const last = stats.last.get(r.identifier);
      if (ui.since === 'never' ? last : last && daysBetween(last, ymd(new Date())) < +ui.since) return false;
    }
    const terms = ui.ingr.split(/[,;]/).map(t => t.trim()).filter(Boolean);
    if (terms.some(t => !(r.recipeIngredient ?? []).some(line => lineMatches(t, line)))) return false;
    const q = ui.q.trim().toLowerCase();
    if (q) {
      const hay = [r.name, r.keywords, r.recipeCategory, r.author?.name, ...(r.recipeIngredient ?? [])].join(' ').toLowerCase();
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  };
  const filtersActive = () => !!(ui.q || ui.cat || ui.chef || ui.source || ui.tags.length || ui.ingr || ui.maxTime || ui.since || ui.minStars || ui.fav);

  const drawChef = () => {
    const pool = recipes.filter(passes);
    const picks = chefSuggestions(pool, id => stats.last.get(id), 8, new Date(), leftovers);
    const eco = leftovers.length ? ' Recepten die je overschotten gebruiken staan bovenaan (🌿 ECO Cooking).' : '';
    chefInfo.textContent = (filtersActive()
      ? `Uit ${pool.length} ${pool.length === 1 ? 'recept' : 'recepten'} die aan je filters voldoen — op basis van beoordeling, hoe lang geleden en seizoen (België).`
      : 'Op basis van je beoordeling, hoe lang geleden je het maakte en wat nu in seizoen is in België.') + eco;
    chefStrip.replaceChildren(...(picks.length
      ? picks.map(p => card(p.recipe, null, p.why, Math.round(p.score * 100)))
      : [h('p', { class: 'muted' }, 'Geen recepten die aan je filters voldoen.')]));
  };

  const drawMain = () => {
    const shown = recipes.filter(passes);
    const lastOf = r => stats.last.get(r.identifier) ?? '';
    if (ui.sort === 'oldest') shown.sort((a, b) => lastOf(a).localeCompare(lastOf(b)) || collator.compare(a.name, b.name));
    if (ui.sort === 'rating') shown.sort((a, b) => (b['x-rating'] || 0) - (a['x-rating'] || 0) || collator.compare(a.name, b.name));
    if (ui.sort === 'recent') shown.sort((a, b) => (lastOf(b) || '0').localeCompare(lastOf(a) || '0') || collator.compare(a.name, b.name));
    count.textContent = `${shown.length} van ${recipes.length}`;
    grid.replaceChildren(...shown.map(r => card(r)));
    drawChef();                                                  // the filters apply to the chef suggestions too
  };

  // ---------- menu: week + month ----------
  const today = () => ymd(new Date());

  const addItem = async (date, id) => {
    const r = byId.get(id);
    if (!r || (plan.get(date) ?? []).some(e => e.recipeId === id)) return;        // the same dish twice on one day makes no sense
    const entry = await db.addPlanItem(date, id, r.name);
    plan.set(date, [...(plan.get(date) ?? []), entry]);
    changed();
  };
  const removeItem = async entry => {
    if (entry.date < today() && !confirm('Deze dag ligt in het verleden. Verwijderen wist ook de "laatst gekookt"-geschiedenis van dit gerecht. Doorgaan?')) return;
    await db.removePlanItem(entry.id);
    plan.set(entry.date, (plan.get(entry.date) ?? []).filter(e => e.id !== entry.id));
    changed();
  };
  const moveItem = async (id, to) => {
    const entry = allEntries().find(e => e.id === id);
    if (!entry || entry.date === to || (plan.get(to) ?? []).some(e => e.recipeId === entry.recipeId)) return;
    const moved = await db.movePlanItem(id, to);
    plan.set(entry.date, plan.get(entry.date).filter(e => e.id !== id));
    plan.set(to, [...(plan.get(to) ?? []), moved]);
    changed();
  };
  dnd.onDrop = (date, p) => (p.type === 'recipe' ? addItem(date, p.id) : moveItem(p.id, date));

  const dayCell = (date, compact) => {
    const d = parseYmd(date), entries = plan.get(date) ?? [], t = today();
    const cell = h('div', { class: ['day', date === t && 'today', date < t && 'past', compact && 'compact'].filter(Boolean).join(' '),
      'data-date': date },
    h('div', { class: 'dlabel' }, compact ? String(d.getDate()) : fmtDay(d)));
    for (const entry of entries) {
      const known = byId.has(entry.recipeId);
      const dish = h('div', { class: 'dish', title: entry.name },
        h('a', { href: known ? `#/r/${entry.recipeId}` : null }, entry.name),
        h('button', { type: 'button', class: 'x', title: 'Van het menu halen', onclick: () => removeItem(entry) }, '×'));
      makeDraggable(dish, { type: 'plan', id: entry.id, date }, entry.name);
      cell.append(dish);
    }
    cell.append(h('button', { type: 'button', class: 'empty-day' + (entries.length ? ' more' : ''),
      title: entries.length ? 'Nog een gerecht aan deze dag toevoegen' : 'Gerecht kiezen (of sleep er een naartoe)', onclick: () => openPicker(date) }, '+'));
    return cell;
  };

  const weekTitle = h('span', { class: 'mb-week' });
  const weekBox = h('div', { class: 'week' });
  const drawWeek = () => {
    const days = [...Array(7)].map((_, i) => addDays(ui.weekStart, i));
    const f = d => d.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
    weekTitle.textContent = `${f(days[0])} – ${f(days[6])}`;
    weekBox.replaceChildren(...days.map(d => dayCell(ymd(d), false)));
  };
  const shiftWeek = n => { ui.weekStart = addDays(ui.weekStart, 7 * n); drawWeek(); };

  // One line: [fold] Menu  ‹ week ›  [today] [month]. Sticky under the header; folds away; opens by itself while dragging.
  const iconBtn = (name, title, onclick) =>
    h('button', { type: 'button', class: 'ico-btn', title, 'aria-label': title, onclick }, icon(name, 20));
  const fold = h('button', { type: 'button', class: 'ico-btn' });
  const menuBar = h('section', { class: 'menubar' },
    h('div', { class: 'mb-head' },
      fold,
      h('strong', { class: 'mb-title', title: 'Sleep een recept naar een dag (op touch: lang indrukken), of tik op een lege dag.' }, '📅 Menu'),
      h('span', { class: 'mb-nav' }, iconBtn('left', 'Vorige 7 dagen', () => shiftWeek(-1)), weekTitle, iconBtn('right', 'Volgende 7 dagen', () => shiftWeek(1))),
      iconBtn('today', 'Terug naar vandaag', () => { ui.weekStart = addDays(new Date(), 0); drawWeek(); }),
      iconBtn('month', 'Maandoverzicht', () => openMonth())),
    weekBox);
  const savedOpen = localStorage.getItem(MENU_KEY);                     // no choice made yet: open on wide screens, folded on a phone
  let menuOpen = savedOpen === null ? innerWidth >= 700 : savedOpen !== '0';
  const setMenuOpen = open => {
    menuOpen = open;
    menuBar.classList.toggle('collapsed', !open);
    fold.replaceChildren(icon(open ? 'collapse' : 'expand', 20));
    fold.title = fold.ariaLabel = open ? 'Menu inklappen' : 'Menu uitklappen';
    localStorage.setItem(MENU_KEY, open ? '1' : '0');
  };
  fold.addEventListener('click', () => setMenuOpen(!menuOpen));
  setMenuOpen(menuOpen);
  dnd.onStart = () => { if (!menuOpen) menuBar.classList.add('dragopen'); };     // overlay: no layout jump while dragging
  dnd.onEnd = () => menuBar.classList.remove('dragopen');

  const openOverlay = (title, body) => {
    closeModal();
    modal = h('div', { class: 'backdrop', onclick: e => { if (e.target === modal) closeModal(); } },
      h('div', { class: 'modal' },
        h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, title),
          h('button', { class: 'btn small', type: 'button', onclick: closeModal }, 'Sluiten')),
        body));
    document.body.append(modal);
  };

  const openMonth = () => {
    const now = new Date();
    ui.month ??= new Date(now.getFullYear(), now.getMonth(), 1);
    const title = h('strong', { class: 'monthname' });
    const grid = h('div', { class: 'month' });
    const draw = () => {
      title.textContent = ui.month.toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' });
      const end = new Date(ui.month.getFullYear(), ui.month.getMonth() + 1, 0);
      const cells = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'].map(n => h('div', { class: 'dow' }, n));
      let n = 0;
      for (let d = mondayOf(ui.month); d <= end || n % 7; d = addDays(d, 1), n++) {
        const c = dayCell(ymd(d), true);
        if (d.getMonth() !== ui.month.getMonth()) c.classList.add('other');
        cells.push(c);
      }
      grid.replaceChildren(...cells);
    };
    const go = k => { ui.month = new Date(ui.month.getFullYear(), ui.month.getMonth() + k, 1); draw(); };
    openOverlay('Maandoverzicht', [
      h('div', { class: 'row between', style: 'margin:8px 0' },
        h('button', { class: 'btn small', type: 'button', onclick: () => go(-1) }, '‹'), title,
        h('button', { class: 'btn small', type: 'button', onclick: () => go(1) }, '›')),
      grid]);
    redrawMonth = draw;
    draw();
  };

  const openPicker = date => {
    const list = h('div', { class: 'picklist' });
    const lastOf = r => stats.last.get(r.identifier) ?? '';
    const draw = q => {
      const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const rows = recipes
        .filter(r => words.every(w => [r.name, r.keywords, r.recipeCategory].join(' ').toLowerCase().includes(w)))
        .sort((a, b) => lastOf(a).localeCompare(lastOf(b)) || collator.compare(a.name, b.name));   // longest ago first
      list.replaceChildren(...rows.map(r => h('button', { type: 'button', class: 'pick', onclick: async () => {
        await addItem(date, r.identifier); closeModal();
      } }, h('span', {}, r.name), h('small', { class: 'muted' }, whenText(r.identifier, stats)))));
    };
    const search = h('input', { type: 'search', placeholder: 'Zoek een gerecht…', oninput: e => draw(e.target.value) });
    openOverlay(`Gerecht voor ${fmtDay(parseYmd(date))}`, [h('p', {}, 'Langst niet gekookt staat bovenaan.'), search, list]);
    draw('');
    search.focus();
  };

  const changed = () => {
    stats = planStats(allEntries());
    drawWeek();
    redrawMonth?.();
    drawMain();                       // also redraws the chef suggestions
    refreshShopViews();               // the shopping list follows the menu
  };

  // ---------- assemble ----------
  shopPanel?.view.destroy();
  shopPanel = createShopPanel();

  root.replaceChildren(h('div', { class: 'home-wrap' },
    menuBar,
    h('div', { class: 'home' },
      h('aside', { class: 'left' }, leftoverPanel, filterPanel),
      h('div', { class: 'center' },
        h('section', {}, h('h2', {}, '👨‍🍳 Suggesties van de chef'), chefInfo, chefStrip),
        h('section', {}, h('h2', {}, 'Alle recepten ', count), grid),
        h('details', { style: 'margin-top:32px' }, h('summary', {}, 'Importeren'), importControls(reload))),
      h('aside', { class: 'right' }, shopPanel.el))));

  // sticky offsets for the side columns: header + menu bar
  layoutObserver?.disconnect();
  const header = document.querySelector('header');
  const setVars = () => {
    document.documentElement.style.setProperty('--hdr-h', header.offsetHeight + 'px');
    document.documentElement.style.setProperty('--menu-h', menuBar.offsetHeight + 'px');
  };
  layoutObserver = new ResizeObserver(setVars);
  layoutObserver.observe(header);
  layoutObserver.observe(menuBar);
  setVars();

  drawLeftovers();
  drawTags();
  drawMain();
  drawWeek();
}
