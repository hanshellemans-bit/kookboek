// Home view.
//   top (sticky, collapsible): the week menu (drag & drop) with month overview
//   left: ECO cooking (leftovers) + filters   centre: recipes   right: shopping list for the next 7 days
import * as db from './db.js';
import { lineMatches } from './leftovers.js';
import { dnd, makeDraggable } from './dnd.js';
import { importControls } from './importer.js';
import { getWeights, setWeights } from './chef.js';
import { buildRanking, browse, SKIP_PLANNED_DAYS } from './ranking.js';
import { icon } from './icons.js';
import { createShopPanel, refreshShopViews } from './shopui.js';
import { createTodoPanel, refreshTodoViews } from './todoui.js';
import { withEcoReset } from './todo.js';
import {
  h, foldText, searchText, urlFor, minutes, fmtMinutes, ymd, parseYmd, addDays, mondayOf, daysBetween, fmtDay, planStats, whenText,
} from './util.js';

// UI state that survives navigating to a recipe and back. The "Gang" filter starts on Hoofdgerecht.
const ui = {
  q: '', cat: 'Hoofdgerecht', chef: '', source: '', tags: [], ingr: '', maxTime: '', since: '', minStars: '',
  weekStart: addDays(new Date(), 0), month: null,          // the week strip starts TODAY (rolling 7 days), not on Monday
};
const MENU_KEY = 'kookboek.menuOpen';

let modal = null;        // open overlay (month view / recipe picker)
let redrawMonth = null;
let layoutObserver = null;
let shopPanel = null;
let todoPanel = null;
let algoHandler = null;
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
  setWeights(await db.getSetting('algoWeights', null));          // the weights you set under ⚙ > Algoritme

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

  // ⓘ buttons behind a heading; the explanation lives in a popup, not on the page
  const infoBtn = (cls, title, onclick) =>
    h('button', { type: 'button', class: `ico-btn info-btn ${cls}`, title, 'aria-label': title, onclick }, icon('info', 20));

  // ---------- recipe cards: every card carries the chef's score and the reasons behind it ----------
  const card = (r, { why, score, planned } = {}) => {
    const img = h('img', { class: 'thumb', alt: '', draggable: 'false' });
    if (r.image?.[0]) db.getImage(db.imageKey(r.identifier, r.image[0])).then(b => b && (img.src = urlFor(b)));
    const el = h('a', { class: 'card' + (planned ? ' planned' : ''), href: `#/r/${r.identifier}`, title: score != null ? `Score ${score}/100` : null },
      h('div', { class: 'thumbbox' }, img, score != null && h('span', { class: 'score', title: 'Score van de chef (0–100)' }, String(score))),
      h('div', { class: 'info' },
        h('div', { class: 'name' }, r.name),
        h('div', { class: 'sub' }, [r['x-rating'] ? '★'.repeat(r['x-rating']) : '', r.recipeCategory, fmtMinutes(totalMinutes(r))].filter(Boolean).join(' · ')),
        h('div', { class: 'why' }, (why ?? [whenText(r.identifier, stats)]).map(w => h('div', {}, w)))
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
    drawLeftovers(); drawMain();                       // leftovers raise the score of recipes that use them
    refreshTodoViews();                                // leftovers without a recipe become to-do items
  };
  const drawLeftovers = () => chips.replaceChildren(...leftovers.map(l => {
    const n = recipeCount(l);
    return h('span', { class: 'chip ' + (n ? 'ok' : 'none'), title: n ? `${n} ${n === 1 ? 'recept' : 'recepten'}` : 'Geen recepten met dit ingrediënt' },
      l, h('button', { type: 'button', title: `Verwijder ${l}`, onclick: async () => {
        leftovers = leftovers.filter(x => x !== l);
        await db.setSetting('todos', withEcoReset(await db.getSetting('todos', {}), l));      // forget its automatic to-do item
        saveLeftovers();
      } }, '×'));
  }));

  const leftoverPanel = h('section', { class: 'panel' },
    h('h2', {}, '🌿 ECO Cooking ', infoBtn('eco-info', 'Wat is ECO Cooking?', () => openEcoInfo())),
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
    h('button', { class: 'btn small', type: 'button', onclick: async () => {
      let todos = await db.getSetting('todos', {});
      for (const l of leftovers) todos = withEcoReset(todos, l);
      await db.setSetting('todos', todos);
      leftovers = []; saveLeftovers();
    } }, 'Lijst wissen')
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
    h('h2', {}, '🔎 Filters ', infoBtn('filter-info', 'Hoe werken de filters?', () => openFilterInfo())),
    h('input', { type: 'search', placeholder: 'Zoeken in alles…', title: 'Zoekt in naam, ingrediënten, bereiding, tip, notities, tags, chef en bron', value: ui.q,
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
    h('button', { class: 'btn small', type: 'button', onclick: () => {
      Object.assign(ui, { q: '', cat: '', chef: '', source: '', tags: [], ingr: '', maxTime: '', since: '', minStars: '' });
      reload();
    } }, 'Filters wissen')
  );

  // ---------- centre: all recipes in ONE list, ordered by the chef's score ----------
  const grid = h('div', { class: 'grid' });
  const count = h('span', { class: 'muted' });
  let chefState = { shown: 0, planned: 0, filters: false };                   // facts for the info popup

  const haystack = new Map();
  const passes = r => {
    if (ui.cat && r.recipeCategory !== ui.cat) return false;
    if (ui.chef && r.author?.name !== ui.chef) return false;
    if (ui.source && r.isBasedOn !== ui.source) return false;
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
    const q = foldText(ui.q.trim());
    if (q) {
      let hay = haystack.get(r.identifier);
      if (!hay) haystack.set(r.identifier, hay = searchText(r));          // name, steps, tip, notes, ... (computed once per page)
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  };
  const filtersActive = () => !!(ui.q || ui.cat || ui.chef || ui.source || ui.tags.length || ui.ingr || ui.maxTime || ui.since || ui.minStars);

  const drawMain = () => {
    const rk = buildRanking({ recipes, entries: allEntries(), leftovers, filter: passes });
    browse.ids = rk.items.map(i => i.recipe.identifier);                // the detail page walks through this order with ‹ ›
    count.textContent = `${rk.pool} van ${recipes.length}`;
    chefState = { shown: rk.pool, planned: rk.plannedInPool, filters: filtersActive() };
    grid.replaceChildren(...(rk.items.length
      ? rk.items.map(i => card(i.recipe, { why: i.why, score: i.score, planned: i.planned }))
      : [h('p', { class: 'muted' }, 'Geen recepten die aan je filters voldoen.')]));
  };

  // ---------- menu: week + month ----------
  const today = () => ymd(new Date());

  const addItem = async (date, id) => {
    const r = byId.get(id);
    if (!r || (plan.get(date) ?? []).some(e => e.recipeId === id)) return;        // the same dish twice on one day makes no sense
    const entry = await db.addPlanItem(date, id, r.name);
    plan.set(date, [...(plan.get(date) ?? []), entry]);
    const added = await db.addLeftovers(r['x-likelyLeftovers'] ?? []);           // its probable leftovers go to ECO Cooking right away
    if (added.length) { leftovers = await db.getSetting('leftovers', []); drawLeftovers(); refreshTodoViews(); }
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

  const openOverlay = (title, body, cls = '') => {
    closeModal();
    modal = h('div', { class: 'backdrop', onclick: e => { if (e.target === modal) closeModal(); } },
      h('div', { class: 'modal ' + cls },
        h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, title),
          h('button', { class: 'btn small', type: 'button', onclick: closeModal }, 'Sluiten')),
        body));
    document.body.append(modal);
  };

  const openEcoInfo = () => openOverlay('🌿 ECO Cooking', h('div', { class: 'chefinfo' },
    h('p', {}, h('strong', {}, 'Overschotten of recht van het veld.'), ' Noteer wat je over hebt of net geoogst hebt (bv. kip, prei, room).'),
    h('ul', {},
      h('li', {}, h('strong', {}, '✓ groen'), ' — er zijn recepten die dit gebruiken.'),
      h('li', {}, h('strong', {}, '✕ rood'), ' — er is (nog) geen recept met dit ingrediënt.'),
      h('li', {}, 'Recepten die je overschotten gebruiken staan bovenaan bij de suggesties van de chef (🌿).'),
      h('li', {}, 'Zet je een gerecht met "waarschijnlijke overschotten" op het menu, dan komen die hier automatisch bij.'),
      h('li', {}, 'Met × haal je één overschot weg, met "Lijst wissen" allemaal. Je lijst wordt gesynchroniseerd.'))), 'narrow');

  const openFilterInfo = () => openOverlay('🔎 Filters', h('div', { class: 'chefinfo' },
    h('p', {}, h('strong', {}, 'Gelden voor'), ' de lijst "Suggesties van de chef": alleen recepten die aan de filters voldoen worden getoond en gescoord.'),
    h('ul', {},
      h('li', {}, 'Je kunt filters combineren; een recept moet aan alle gekozen filters voldoen.'),
      h('li', {}, '"Zoeken" kijkt overal: naam, beschrijving, ingrediënten, bereiding, tip van de chef, je eigen notities, tags, chef en bron (accenten en hoofdletters maken niet uit). Meerdere woorden moeten allemaal voorkomen.'),
      h('li', {}, 'De gang staat standaard op Hoofdgerecht. Kies "Alle" om alles te zien.'),
      h('li', {}, '"Bevat ingrediënt(en)": meerdere ingrediënten scheid je met een komma (bv. kip, room).'),
      h('li', {}, '"Gekookt" kijkt naar je menu: wanneer stond het recept voor het laatst op het menu?'),
      h('li', {}, '"Filters wissen" zet alle filters terug op "Alle" (ook de gang).'),
      h('li', {}, 'Je filters blijven staan als je een recept opent en terugkomt.'))), 'narrow');

  // all explanation about the chef suggestions lives in this popup (ⓘ behind the heading)
  const openChefInfo = () => {
    const pct = x => Math.round(x * 100) + '%';
    const { plain: w, eco: we } = getWeights();
    const n = chefState.planned;
    openOverlay('👨‍🍳 Suggesties van de chef', h('div', { class: 'chefinfo' },
      h('p', {}, 'Elk recept krijgt van de chef een score (0–100) en de lijst staat van hoog naar laag. De score komt uit:'),
      h('ul', {},
        h('li', {}, h('strong', {}, '★ Beoordeling'), ' — hoe meer sterren, hoe beter (zonder sterren telt neutraal).'),
        h('li', {}, h('strong', {}, '🍽 Hoe lang geleden'), ' — gerechten die je lang niet of nog nooit maakte, scoren hoger.'),
        h('li', {}, h('strong', {}, '🌱 Seizoen'), ' — groenten en fruit die nu in België in seizoen zijn (⚠ = buiten seizoen).'),
        h('li', {}, h('strong', {}, '🌿 Overschotten'), ' — recepten die je overschotten (ECO Cooking) gebruiken, staan bovenaan.'),
        h('li', {}, h('strong', {}, '🔗 Link'), ' — recepten die het waarschijnlijke overschot van een gerecht op je menu gebruiken. '
          + 'Alleen dat veld telt, nooit een hoofdingrediënt zoals kip.')),
      h('p', { class: 'muted' }, `Gewicht zonder overschotten: beoordeling ${pct(w.stars)}, hoe lang geleden ${pct(w.recency)}, seizoen ${pct(w.season)}. `
        + `Met overschotten: beoordeling ${pct(we.stars)}, hoe lang geleden ${pct(we.recency)}, seizoen ${pct(we.season)}, overschotten ${pct(we.eco)}.`),
      h('h3', {}, 'Nu'),
      h('ul', {},
        h('li', {}, chefState.filters
          ? `Uit ${chefState.shown} ${chefState.shown === 1 ? 'recept' : 'recepten'} die aan je filters voldoen. De filters links bepalen welke recepten in de lijst staan.`
          : 'Alle recepten staan in de lijst. Met de filters links verklein je hem.'),
        h('li', {}, `Gerechten die de komende ${SKIP_PLANNED_DAYS} dagen al op je menu staan, zakken onderaan de lijst (grijs, met 📅)`
          + (n ? ` — nu ${n}.` : '.')),
        leftovers.length ? h('li', {}, 'Je overschotten: ' + leftovers.join(', ') + '.') : null),
      h('p', { class: 'muted small-text' }, 'Op elke kaart staat het cijfer en waarom.')), 'narrow');
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
  todoPanel?.view.destroy();
  todoPanel = createTodoPanel();

  root.replaceChildren(h('div', { class: 'home-wrap' },
    menuBar,
    h('div', { class: 'home' },
      h('aside', { class: 'left' }, leftoverPanel, filterPanel),
      h('div', { class: 'center' },
        h('section', {},
          h('div', { class: 'sechead' },
            h('h2', {}, '👨‍🍳 Suggesties van de chef ', infoBtn('chef-info', 'Hoe werken de suggesties?', () => openChefInfo())),
            count),
          grid)),
      h('aside', { class: 'right' }, shopPanel.el, todoPanel.el))));

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

  // ⚙ > Algoritme > Herbereken: recompute the list behind the dialog
  if (algoHandler) removeEventListener('kookboek:algo', algoHandler);
  algoHandler = () => drawMain();
  addEventListener('kookboek:algo', algoHandler);

  drawLeftovers();
  drawTags();
  drawMain();
  drawWeek();
}
