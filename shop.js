// Shopping list logic (pure, no browser APIs): parse ingredient lines, merge them across recipes, resolve item state.
//
// State per ingredient key (both maps sync across devices, newest per key wins):
//   prefs[key]  = { k: 'pin' | 'watch' | '', t }   pin = "always at home", watch = "check my stock first"
//   checks[key] = { c: true | false, t }           ticked off; only valid for CHECK_TTL_DAYS
// A pinned item is ticked (grey, at the bottom) by default; un-tick it and it is on the list again.

export const CHECK_TTL_DAYS = 7;

// Pre-pinned the first time, until the user pins/unpins something themselves.
export const DEFAULT_PANTRY = new Set([
  'zout', 'peper', 'zwarte peper', 'zout en peper', 'zout en zwarte peper', 'olie', 'olijfolie', 'bakpapier', 'water',
]);

// ---------- parsing ----------

const UNITS = {
  g: 'g', gr: 'g', gram: 'g', kg: 'kg', ml: 'ml', cl: 'cl', dl: 'dl', l: 'l', liter: 'l',
  el: 'el', eetl: 'el', eetlepel: 'el', eetlepels: 'el', tl: 'tl', theelepel: 'tl', theelepels: 'tl', kl: 'kl', koffielepel: 'kl',
  teentje: 'teentje', teentjes: 'teentje', stengel: 'stengel', stengels: 'stengel', bosje: 'bosje', bosjes: 'bosje',
  zakje: 'zakje', zakjes: 'zakje', pakje: 'pakje', pakjes: 'pakje', potje: 'potje', potjes: 'potje', plantje: 'plantje',
  blik: 'blik', blikje: 'blik', blikken: 'blik', stuk: 'stuk', stuks: 'stuk', stukje: 'stuk', blokje: 'blokje', brikje: 'brikje',
  kop: 'kop', kopje: 'kop', kopjes: 'kop', oz: 'oz', plak: 'plak', plakken: 'plak', plakje: 'plak', plakjes: 'plak',
  snuifje: 'snuifje', snufje: 'snuifje', scheutje: 'scheutje', scheutjes: 'scheutje', scheut: 'scheutje', beetje: 'beetje',
  handvol: 'handvol', takje: 'takje', takjes: 'takje', tak: 'takje',
};
const PLURAL = { teentje: 'teentjes', stengel: 'stengels', bosje: 'bosjes', zakje: 'zakjes', pakje: 'pakjes', potje: 'potjes',
  plantje: 'plantjes', blik: 'blikken', stuk: 'stuks', blokje: 'blokjes', brikje: 'brikjes', kop: 'kopjes', plak: 'plakken',
  snuifje: 'snuifjes', scheutje: 'scheutjes', takje: 'takjes' };
const UNIT_ONLY = new Set(['snuifje', 'scheutje', 'beetje', 'handvol', 'takje', 'teentje']);   // units that may appear without a number

const OVERRIDES = {   // plural/diminutive -> singular for words the generic rules get wrong
  uien: 'ui', uitjes: 'ui', eieren: 'ei', eitjes: 'ei', tomaten: 'tomaat', tomaatjes: 'tomaat', bonen: 'boon', boontjes: 'boon',
  aardappelen: 'aardappel', aardappels: 'aardappel', wortelen: 'wortel', wortels: 'wortel', radijsjes: 'radijs', asperges: 'asperge',
  kruiden: 'kruid', olijven: 'olijf', noten: 'noot', erwten: 'erwt', rozijnen: 'rozijn', champignons: 'champignon',
  varken: 'varken', varkens: 'varken',
};
// Flemish names and variants that mean the same thing
const SYNONYMS = { look: 'knoflook', ajuin: 'ui', ajuinen: 'ui', knoflooktenen: 'knoflook' };
const NO_STRIP = /(oen|een|ous|ss|js|ijs|is|us|ais)$/;     // citroen, groen, couscous, radijs, mais, ...

function singularWord(w) {
  if (OVERRIDES[w]) return OVERRIDES[w];
  if (w.length > 4 && w.endsWith('en') && !NO_STRIP.test(w)) {
    let stem = w.slice(0, -2);
    if (/[^aeiou][aeiou][^aeiou]$/.test(stem) && !/(el|er|em|en|aar)$/.test(stem)) stem = stem.slice(0, -2) + stem.slice(-2, -1) + stem.slice(-2);   // tomat -> tomaat
    return stem;
  }
  if (w.length > 4 && w.endsWith('s') && !NO_STRIP.test(w) && (!/[aeiou]s$/.test(w) || (w.length > 6 && w.endsWith('es')))) return w.slice(0, -1);   // champignons -> champignon, courgettes -> courgette
  return w;
}

export const normalizeText = s =>
  s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’`]s\b/g, '').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Key used to merge the same ingredient across recipes: normalised name, head noun singular. */
export function ingredientKey(name) {
  const words = normalizeText(name).split(' ').filter(Boolean);
  if (words.length) { const w = singularWord(words[words.length - 1]); words[words.length - 1] = SYNONYMS[w] ?? w; }
  return words.join(' ');
}

const NUM = /^\d+(?:[.,]\d+)?$/;
const FRAC = /^(\d+)\/(\d+)$/;
const toNum = s => parseFloat(s.replace(',', '.'));

/** "600 g chipolata's (beenhouwerij)" -> { qty: 600, unit: 'g', name: "chipolata's", key: 'chipolata' } */
export function parseIngredient(line) {
  let text = String(line).replace(/\([^)]*\)/g, ' ').split(/,(?=\s)/)[0].replace(/\s+/g, ' ').trim();   // cut prep notes (', fijngesneden') but keep '1,5 tl'
  const tokens = text.split(' ').filter(Boolean);
  let qty = null, unit = '';

  const first = tokens[0] ?? '';
  const attached = /^(\d+(?:[.,]\d+)?)([a-zA-Z]+)$/.exec(first);          // "500gr"
  if (attached && UNITS[attached[2].toLowerCase()]) {
    qty = toNum(attached[1]); unit = UNITS[attached[2].toLowerCase()]; tokens.shift();
  } else if (NUM.test(first) || FRAC.test(first) || /^\d+-\d+$/.test(first)) {
    tokens.shift();
    if (/^\d+-\d+$/.test(first)) qty = toNum(first.split('-')[0]);
    else if (FRAC.test(first)) qty = +FRAC.exec(first)[1] / +FRAC.exec(first)[2];
    else {
      qty = toNum(first);
      if (FRAC.test(tokens[0] ?? '')) { const f = FRAC.exec(tokens.shift()); qty += +f[1] / +f[2]; }   // "1 1/4"
    }
    const u = (tokens[0] ?? '').toLowerCase().replace(/\.$/, '');
    if (UNITS[u]) { unit = UNITS[u]; tokens.shift(); }
  } else {
    const u = first.toLowerCase();
    if (UNIT_ONLY.has(UNITS[u])) { unit = UNITS[u]; tokens.shift(); }
  }
  while (tokens[0] && ['van', 'de', 'het', 'een'].includes(tokens[0].toLowerCase())) tokens.shift();
  const name = tokens.join(' ').trim() || text;
  return { qty, unit, name, key: ingredientKey(name) };
}

// ---------- merging ----------

function fmtNum(n) {
  const whole = Math.floor(n + 1e-9), frac = n - whole;
  const f = [[0.25, '1/4'], [1 / 3, '1/3'], [0.5, '1/2'], [2 / 3, '2/3'], [0.75, '3/4']].find(([v]) => Math.abs(frac - v) < 0.02);
  if (frac < 0.02) return String(whole);
  if (f) return (whole ? whole + ' ' : '') + f[1];
  return (Math.round(n * 10) / 10).toString().replace('.', ',');
}
const unitLabel = (unit, qty) => (qty !== 1 && PLURAL[unit] ? PLURAL[unit] : unit);

/** parts: Map(unit -> { qty: number|null (summed), n }) -> "3 teentjes + 2 el" */
export function amountText(parts) {
  const out = [];
  for (const [unit, p] of parts) {
    if (p.qty != null) out.push(unit ? `${fmtNum(p.qty)} ${unitLabel(unit, p.qty)}` : `${fmtNum(p.qty)}×`);
    else if (unit) out.push(unit);
  }
  return out.join(' + ');
}

/** entries: [{ recipe: 'Naam', lines: ['600 g ...'] }] -> [{ key, name, text, recipes:[...] }] sorted by name */
export function buildShopping(entries) {
  const items = new Map();
  for (const { recipe, lines } of entries) {
    for (const line of lines ?? []) {
      const p = parseIngredient(line);
      if (!p.key) continue;
      let it = items.get(p.key);
      if (!it) items.set(p.key, it = { key: p.key, name: p.name.toLowerCase(), parts: new Map(), recipes: new Set() });
      const cur = it.parts.get(p.unit) ?? { qty: null, n: 0 };
      if (p.qty != null) cur.qty = (cur.qty ?? 0) + p.qty;
      cur.n++;
      it.parts.set(p.unit, cur);
      it.recipes.add(recipe);
    }
  }
  return [...items.values()]
    .map(it => {
      const text = amountText(it.parts), recipes = [...it.recipes];
      return { key: it.key, name: it.name, text, recipes, sig: recipes.join('|') + '#' + text };   // sig changes when the need changes
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
}

// ---------- state ----------

/** -> { mode: 'pin' | 'watch' | '', checked: boolean } */
export function resolveState(key, prefs = {}, checks = {}, now = Date.now(), sig = null) {
  const mode = key in prefs ? (prefs[key].k || '') : (DEFAULT_PANTRY.has(key) ? 'pin' : '');
  const c = checks[key];
  const sameNeed = !c || c.x == null || sig == null || c.x === sig;                // cleaned up for a different need: forget the tick
  const fresh = c && sameNeed && now - Date.parse(c.t) < CHECK_TTL_DAYS * 86_400_000;
  return { mode, checked: fresh ? !!c.c : mode === 'pin' };
}

/** Next prefs/checks after the user sets the mode of an item ('pin', 'watch' or '' = neither). */
export function withMode(prefs, checks, key, mode, t = new Date().toISOString()) {
  return {
    prefs: { ...prefs, [key]: { k: mode, t } },
    checks: { ...checks, [key]: { c: mode === 'pin', t } },     // pinned = in stock (ticked); otherwise back to "to do"
  };
}

export function withChecked(checks, key, c, t = new Date().toISOString()) {
  return { ...checks, [key]: { c, t } };
}

/**
 * Section of an item, in display order: 'watch' (check stock first), 'buy', 'done' (ticked), 'pin' (always at home).
 * Pinned items ALWAYS sit in the last section, ticked or not (unticked ones are listed first inside it).
 */
export function sectionOf(state) {
  if (state.mode === 'pin') return 'pin';
  return state.checked ? 'done' : state.mode === 'watch' ? 'watch' : 'buy';
}

/** The next 7 days: today .. today+6 as 'YYYY-MM-DD'. */
export function shopRange(todayStr) {
  const [y, m, d] = todayStr.split('-').map(Number);
  const end = new Date(y, m - 1, d + 6);
  const pad = n => String(n).padStart(2, '0');
  return { from: todayStr, to: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}` };
}

// ---------- own items ("Zelf toegevoegd") ----------
// extra[id] = { line: '2 l melk', t, del? }  (one entry per added line, so devices never overwrite each other)

export const MANUAL_LABEL = 'Zelf toegevoegd';

/** Lines added by hand that are still on the list. A line that was ticked off after it was added disappears once the tick has expired. */
export function activeManualLines(extra = {}, checks = {}, now = Date.now()) {
  const out = [];
  for (const e of Object.values(extra)) {
    if (e.del || !e.line) continue;
    const c = checks[parseIngredient(e.line).key];
    const tickedAfterAdd = c && c.c && Date.parse(c.t) > Date.parse(e.t);
    const expired = c && now - Date.parse(c.t) >= CHECK_TTL_DAYS * 86_400_000;
    if (tickedAfterAdd && expired) continue;
    out.push(e.line);
  }
  return out;
}

/** Add one or more typed items; the ingredient becomes "to do" again (also if it was ticked or cleaned up before). */
export function withExtraAdded(extra, checks, texts, t = new Date().toISOString(), newId = () => crypto.randomUUID()) {
  const ex = { ...extra }, ch = { ...checks };
  for (const text of texts.map(x => x.trim()).filter(Boolean)) {
    ex[newId()] = { line: text, t };
    const key = parseIngredient(text).key;
    if (key) ch[key] = { c: false, t };
  }
  return { extra: ex, checks: ch };
}

/** Remove the hand-added part of an ingredient (what comes from dishes stays). */
export function withExtraRemoved(extra, key, t = new Date().toISOString()) {
  const out = { ...extra };
  for (const [id, e] of Object.entries(out)) if (!e.del && parseIngredient(e.line).key === key) out[id] = { ...e, del: true, t };
  return out;
}

// ---------- clean up ----------

/** Hidden by "Opruimen": ticked, a plain item (no pin / magnifier), cleaned up for exactly this need, and still fresh. */
export function isCleared(item, state, checks = {}, now = Date.now()) {
  const c = checks[item.key];
  return state.mode === '' && !!c && c.c === true && c.x != null && c.x === item.sig && now - Date.parse(c.t) < CHECK_TTL_DAYS * 86_400_000;
}

/** Items "Opruimen" would remove: plain (no pin, no magnifier) and ticked, not hidden yet. */
export function clearCandidates(items, prefs = {}, checks = {}, now = Date.now()) {
  return items.filter(i => {
    const st = resolveState(i.key, prefs, checks, now, i.sig);
    return st.mode === '' && st.checked && !isCleared(i, st, checks, now);
  });
}

export function withCleared(checks, items, t = new Date().toISOString()) {
  const out = { ...checks };
  for (const i of items) out[i.key] = { c: true, t, x: i.sig };
  return out;
}

// ---------- probable leftovers of a dish ----------

const BUNDLE_UNITS = new Set(['bosje', 'plantje', 'pakje', 'takje']);
const FRESH_HERBS = /\b(lente ui|lenteui|bosui|koriander|peterselie|munt|basilicum|bieslook|dille|kervel|dragon|salie|gember)\b/;

/**
 * Ingredients you rarely finish when you buy them for ONE dish (a bunch of spring onions, a pot of coriander, a piece of ginger).
 * Only a suggestion for the "probable leftovers" field; the main ingredients (chicken, pasta, ...) are never suggested.
 */
export function guessLikelyLeftovers(lines = []) {
  const out = [];
  for (const line of lines) {
    const p = parseIngredient(line);
    const name = normalizeText(p.name);
    if (!(BUNDLE_UNITS.has(p.unit) || FRESH_HERBS.test(name))) continue;
    if (p.unit === 'g' || p.unit === 'ml' || p.unit === 'el' || p.unit === 'tl' || p.unit === 'kl') continue;      // measured out: not a bunch
    for (const part of p.name.toLowerCase().split(/\s*(?:&|\/|\ben\b)\s*/)) {
      const item = part.trim();
      if (item && !out.includes(item)) out.push(item);
    }
  }
  return out;
}
