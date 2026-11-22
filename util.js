// Shared helpers: DOM builder, object URLs, time and date formatting, menu statistics.

export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

/** Lower case without accents: 'Crème' -> 'creme'. */
export const foldText = s => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');

/** Everything a person could look for in a recipe, as one lower-case text: name, description, course, tags, chef, source,
 *  ingredients (incl. group titles), all steps, the chef's tip, YOUR notes and the probable leftovers. */
export function searchText(r) {
  const steps = (r.recipeInstructions ?? []).map(s => (typeof s === 'string' ? s : s?.text ?? ''));
  const groups = (r['x-ingredientGroups'] ?? []).map(g => g?.name ?? '');
  return foldText([
    r.name, r.description, r.recipeCategory, r.keywords, r.author?.name, r.isBasedOn, r.recipeYield,
    ...(r.recipeIngredient ?? []), ...groups, ...steps, r['x-tip'], r['x-notes'], ...(r['x-likelyLeftovers'] ?? []),
  ].filter(Boolean).join(' \n '));
}

/** Replace the content of `parent` with `kids`. Unlike parent.replaceChildren(), nested arrays are flattened and
 * empty values (null, undefined, false, 0, '') are skipped instead of being printed as text.
 */
export function fill(parent, ...kids) {
  parent.replaceChildren(...kids.flat(Infinity).filter(k => k?.nodeType || (typeof k === 'string' && k)));
  return parent;
}

// Blob -> object URL, revoked when the route changes.
let objectUrls = [];
export function urlFor(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.push(u);
  return u;
}
export function revokeUrls() {
  objectUrls.forEach(URL.revokeObjectURL);
  objectUrls = [];
}

// ---- durations (ISO 8601 PT#H#M) ----
export function minutes(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso ?? '');
  return m ? (+m[1] || 0) * 60 + (+m[2] || 0) : 0;
}
export function fmtMinutes(min) {
  if (!min) return '';
  const hh = Math.floor(min / 60), mm = min % 60;
  return (hh ? hh + ' u ' : '') + (mm ? mm + ' min' : '');
}

// ---- dates: 'YYYY-MM-DD' strings in local time ----
const pad = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
export const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
export const daysBetween = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
export const fmtDay = d => d.toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short' });

export function agoText(days) {
  if (days <= 0) return 'vandaag';
  if (days === 1) return 'gisteren';
  if (days < 14) return `${days} dagen geleden`;
  if (days < 60) return `${Math.round(days / 7)} weken geleden`;
  if (days < 365) return `${Math.round(days / 30)} maanden geleden`;
  const y = Math.round(days / 365 * 2) / 2;
  return `${String(y).replace('.', ',')} jaar geleden`;
}

// ---- menu statistics ----
/** last: recipeId -> latest date <= today ('has been on the menu'); next: recipeId -> earliest date > today. */
export function planStats(entries, today = ymd(new Date())) {
  const last = new Map(), next = new Map();
  for (const e of entries) {
    if (!e.recipeId) continue;
    if (e.date <= today) {
      if (!last.has(e.recipeId) || e.date > last.get(e.recipeId)) last.set(e.recipeId, e.date);
    } else if (!next.has(e.recipeId) || e.date < next.get(e.recipeId)) next.set(e.recipeId, e.date);
  }
  return { last, next };
}

export function whenText(recipeId, stats) {
  const today = ymd(new Date());
  const last = stats.last.get(recipeId), next = stats.next.get(recipeId);
  const parts = [last ? '🍽 ' + agoText(daysBetween(last, today)) : 'nog niet gekookt'];
  if (next) parts.push('📅 ' + fmtDay(parseYmd(next)));
  return parts.join(' · ');
}
