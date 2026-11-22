// Home view: left = leftovers + filters, centre = recipes, right = week menu (drag & drop) with month overview.
import * as db from './db.js';
import { suggest, lineMatches } from './leftovers.js';
import { dnd, makeDraggable } from './dnd.js';
import { importControls } from './importer.js';
import { chefSuggestions } from './chef.js';
import {
  h, urlFor, minutes, fmtMinutes, ymd, parseYmd, addDays, mondayOf, daysBetween, agoText, fmtDay, planStats, whenText,
} from './util.js';

// UI state that survives navigating to a recipe and back.
const ui = {
  q: '', cat: '', chef: '', source: '', tags: [], ingr: '', maxTime: '', since: '', minStars: '', fav: false, sort: 'name',
  weekStart: mondayOf(new Date()), month: null,
};

let modal = null;        // open overlay (month view / recipe picker)
let redrawMonth = null;
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
  let plan = new Map(planList.map(p => [p.date, p]));
  let stats = planStats(planList);

  const chefs = uniqueSorted(recipes.map(r => r.author?.name));
  const chefSet = new Set(chefs);
  const cats = uniqueSorted(recipes.map(r => r.recipeCategory));
  const sources = uniqueSorted(recipes.map(r => r.isBasedOn));
  const allTags = uniqueSorted(recipes.flatMap(tagsOf)).filter(t => !chefSet.has(t));  // chef has its own dropdown

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

  // ---------- leftovers (left, top) ----------
  const chips = h('div', { class: 'chips' });
  const saveLeftovers = async () => {
    await db.setSetting('leftovers', leftovers);
    await db.setSetting('leftoversUpdatedAt', new Date().toISOString());   // for sync
    drawLeftovers(); drawSuggest();
  };
  const drawLeftovers = () => chips.replaceChildren(...leftovers.map(l =>
    h('span', { class: 'chip' }, l,
      h('button', { type: 'button', title: `Verwijder ${l}`, onclick: () => {
        leftovers = leftovers.filter(x => x !== l); saveLeftovers();
      } }, '×'))));

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
  const select = (label, key, values, fmt = v => v) =>
    h('label', { class: 'f' }, label,
      h('select', { onchange: e => { ui[key] = e.target.value; drawMain(); } },
        h('option', { value: '' }, 'Alle'),
        values.map(([v, text]) => h('option', { value: v, selected: v === ui[key] }, text ?? fmt(v)))));
  const pairs = list => list.map(v => [v, v]);

  const tagBox = h('div', { class: 'chips' });
  const drawTags = () => tagBox.replaceChildren(...allTags.map(t =>
    h('button', { type: 'button', class: 'tag' + (ui.tags.includes(t) ? ' on' : ''), onclick: () => {
      ui.tags = ui.tags.includes(t) ? ui.tags.filter(x => x !== t) : [...ui.tags, t];
      drawTags(); drawMain();
    } }, t)));

  const filterPanel = h('section', { class: 'panel' },
    h('h2', {}, '🔎 Filters'),
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

  // ---------- centre: suggestions row + all recipes ----------
  const suggestInfo = h('p', { class: 'muted' });
  const strip = h('div', { class: 'strip' });
  const drawSuggest = () => {
    const found = suggest(recipes, leftovers);
    suggestInfo.textContent = !leftovers.length ? 'Noteer links wat je over hebt of net geoogst hebt; hier verschijnen dan passende recepten.'
      : found.length ? `${found.length} ${found.length === 1 ? 'recept gebruikt' : 'recepten gebruiken'} (een deel van) je overschotten`
      : 'Geen recepten gevonden met deze ingrediënten.';
    strip.replaceChildren(...found.map(x => card(x.recipe, x.matched)));
  };

  const chefStrip = h('div', { class: 'strip' });
  const drawChef = () => chefStrip.replaceChildren(
    ...chefSuggestions(recipes, id => stats.last.get(id), 8).map(p => card(p.recipe, null, p.why, Math.round(p.score * 100))));

  const grid = h('div', { class: 'grid' });
  const count = h('span', { class: 'muted' });
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
  const drawMain = () => {
    const shown = recipes.filter(passes);
    const lastOf = r => stats.last.get(r.identifier) ?? '';
    if (ui.sort === 'oldest') shown.sort((a, b) => lastOf(a).localeCompare(lastOf(b)) || collator.compare(a.name, b.name));
    if (ui.sort === 'rating') shown.sort((a, b) => (b['x-rating'] || 0) - (a['x-rating'] || 0) || collator.compare(a.name, b.name));
    if (ui.sort === 'recent') shown.sort((a, b) => (lastOf(b) || '0').localeCompare(lastOf(a) || '0') || collator.compare(a.name, b.name));
    count.textContent = `${shown.length} van ${recipes.length}`;
    grid.replaceChildren(...shown.map(r => card(r)));
  };

  // ---------- menu: week + month ----------
  const today = () => ymd(new Date());

  const setDay = async (date, id) => {
    const r = byId.get(id);
    if (!r) return;
    await db.setPlanDay(date, id, r.name);
    plan.set(date, { date, recipeId: id, name: r.name });
    changed();
  };
  const clearDay = async date => {
    if (date < today() && !confirm('Deze dag ligt in het verleden. Verwijderen wist ook de "laatst gekookt"-geschiedenis van dit gerecht. Doorgaan?')) return;
    await db.clearPlanDay(date);
    plan.delete(date);
    changed();
  };
  const moveDay = async (from, to) => {
    await db.movePlan(from, to);
    const a = plan.get(from), b = plan.get(to);
    plan.delete(from); plan.delete(to);
    if (a) plan.set(to, { ...a, date: to });
    if (b) plan.set(from, { ...b, date: from });
    changed();
  };
  dnd.onDrop = (date, p) => (p.type === 'recipe' ? setDay(date, p.id) : p.date !== date ? moveDay(p.date, date) : null);

  const dayCell = (date, compact) => {
    const d = parseYmd(date), entry = plan.get(date), t = today();
    const cell = h('div', { class: ['day', date === t && 'today', date < t && 'past', compact && 'compact'].filter(Boolean).join(' '),
      'data-date': date },
    h('div', { class: 'dlabel' }, compact ? String(d.getDate()) : fmtDay(d)));
    if (entry) {
      const known = byId.has(entry.recipeId);
      const dish = h('div', { class: 'dish', title: entry.name },
        h('a', { href: known ? `#/r/${entry.recipeId}` : null }, entry.name),
        h('button', { type: 'button', class: 'x', title: 'Van het menu halen', onclick: () => clearDay(date) }, '×'));
      makeDraggable(dish, { type: 'plan', date }, entry.name);
      cell.append(dish);
    } else {
      cell.append(h('button', { type: 'button', class: 'empty-day', title: 'Gerecht kiezen', onclick: () => openPicker(date) },
        compact ? '+' : '+ sleep of kies een gerecht'));
    }
    return cell;
  };

  const weekTitle = h('strong', {});
  const weekBox = h('div', { class: 'week' });
  const drawWeek = () => {
    const days = [...Array(7)].map((_, i) => addDays(ui.weekStart, i));
    const f = d => d.toLocaleDateString('nl-BE', { day: 'numeric', month: 'short' });
    weekTitle.textContent = `${f(days[0])} – ${f(days[6])}`;
    weekBox.replaceChildren(...days.map(d => dayCell(ymd(d), false)));
  };
  const shiftWeek = n => { ui.weekStart = addDays(ui.weekStart, 7 * n); drawWeek(); };

  const weekPanel = h('section', { class: 'panel' },
    h('div', { class: 'row between' }, h('h2', {}, '📅 Menu'),
      h('button', { class: 'btn small', type: 'button', onclick: () => openMonth() }, 'Maand')),
    h('div', { class: 'row between' },
      h('button', { class: 'btn small', type: 'button', title: 'Vorige week', onclick: () => shiftWeek(-1) }, '‹'),
      weekTitle,
      h('button', { class: 'btn small', type: 'button', title: 'Volgende week', onclick: () => shiftWeek(1) }, '›')),
    h('button', { class: 'btn small', type: 'button', onclick: () => { ui.weekStart = mondayOf(new Date()); drawWeek(); } }, 'Vandaag'),
    weekBox,
    h('p', { class: 'muted small-text' }, 'Sleep een recept naar een dag (op touch: lang indrukken), of tik op een lege dag.')
  );

  const openOverlay = (title, body, onClose) => {
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
        await setDay(date, r.identifier); closeModal();
      } }, h('span', {}, r.name), h('small', { class: 'muted' }, whenText(r.identifier, stats)))));
    };
    const search = h('input', { type: 'search', placeholder: 'Zoek een gerecht…', oninput: e => draw(e.target.value) });
    openOverlay(`Gerecht voor ${fmtDay(parseYmd(date))}`, [h('p', {}, 'Langst niet gekookt staat bovenaan.'), search, list]);
    draw('');
    search.focus();
  };

  const changed = () => {
    stats = planStats([...plan.values()]);
    drawWeek();
    redrawMonth?.();
    drawMain();
    drawSuggest();
    drawChef();
  };

  // ---------- assemble ----------
  root.replaceChildren(h('div', { class: 'home' },
    h('aside', { class: 'left' }, leftoverPanel, filterPanel),
    h('div', { class: 'center' },
      h('section', {}, h('h2', {}, '🌿 ECO Cooking'), suggestInfo, strip),
      h('section', {}, h('h2', {}, '👨‍🍳 Suggesties van de chef'),
        h('p', { class: 'muted' }, 'Op basis van je beoordeling, hoe lang geleden je het maakte en wat nu in seizoen is in België.'), chefStrip),
      h('section', {}, h('h2', {}, 'Alle recepten ', count), grid),
      h('details', { style: 'margin-top:32px' }, h('summary', {}, 'Importeren'), importControls(reload))),
    h('aside', { class: 'right' }, weekPanel)));

  drawLeftovers();
  drawTags();
  drawSuggest();
  drawChef();
  drawMain();
  drawWeek();
}
