// To-do list logic (pure, no browser APIs).
//
// todos = { [id]: entry }, synced per id (newest `t` wins, see syncCore.mergeSettings):
//   your own items   id = uuid          { text, done, t, del? }
//   ECO items        id = 'eco:<item>'  { done?, del?, reset?, t }   only the STATE of an automatic item is stored
//
// ECO items are derived, not stored: every leftover (ECO Cooking) without any recipe gets "Recept zoeken met <item>".
// They disappear by themselves when the leftover is removed or when a recipe for it exists.

export const ecoId = item => 'eco:' + String(item).trim().toLowerCase();

/** -> [{ id, text, done, auto }]: open items first (your own, then ECO), done items last. */
export function buildTodos(todos = {}, leftovers = [], hasRecipe = () => true) {
  const own = [], eco = [];
  for (const [id, e] of Object.entries(todos)) {
    if (id.startsWith('eco:') || e.del || !e.text) continue;
    own.push({ id, text: e.text, done: !!e.done, auto: false, t: e.t ?? '' });
  }
  own.sort((a, b) => a.t.localeCompare(b.t));
  for (const item of leftovers) {
    if (hasRecipe(item)) continue;
    const id = ecoId(item);
    if (eco.some(x => x.id === id)) continue;
    const st = todos[id]?.reset ? undefined : todos[id];
    if (st?.del) continue;                                         // dismissed
    eco.push({ id, text: `Recept zoeken met ${item}`, done: !!st?.done, auto: true, t: st?.t ?? '' });
  }
  const all = [...own, ...eco];
  return [...all.filter(x => !x.done), ...all.filter(x => x.done)];
}

export function withTodoAdded(todos, text, t = new Date().toISOString(), newId = () => crypto.randomUUID()) {
  const out = { ...todos };
  for (const part of String(text).split(/[;\n]/).map(x => x.trim()).filter(Boolean)) out[newId()] = { text: part, done: false, t };
  return out;
}

// (ticking also ends an earlier 'reset' / 'del' of an automatic item: the new state is what counts)
export function withTodoDone(todos, id, done, t = new Date().toISOString()) {
  const { reset, del, ...rest } = todos[id] ?? {};
  return { ...todos, [id]: { ...rest, done, t } };
}

export const withTodoRemoved = (todos, id, t = new Date().toISOString()) => ({ ...todos, [id]: { ...(todos[id] ?? {}), del: true, t } });

/** A leftover was removed: forget what you did with its ECO item, so that it shows up fresh if you add the leftover again. */
export const withEcoReset = (todos, item, t = new Date().toISOString()) => ({ ...todos, [ecoId(item)]: { reset: true, t } });
