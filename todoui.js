// To-do panel (third column, under the shopping list).
import * as db from './db.js';
import { h, fill } from './util.js';
import { icon } from './icons.js';
import { lineMatches } from './leftovers.js';
import { buildTodos, withTodoAdded, withTodoDone, withTodoRemoved } from './todo.js';

const views = new Set();
export const refreshTodoViews = () => views.forEach(v => v.refresh());

export function createTodoPanel() {
  const list = h('ul', { class: 'shopul todolist' });
  let alive = true;

  const persist = async todos => { await db.setSetting('todos', todos); refreshTodoViews(); };

  const form = h('form', { class: 'add shopadd', onsubmit: async e => {
    e.preventDefault();
    const input = e.target.elements.newtodo;                     // not 'item'/'length'/...: those are built-in form members
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    await persist(withTodoAdded(await db.getSetting('todos', {}), text));
  } },
    h('input', { name: 'newtodo', placeholder: 'To do toevoegen (bv. recept zoeken voor knolselder)…', autocomplete: 'off' }),
    h('button', { class: 'btn primary', type: 'submit', title: 'Toevoegen aan de to-do-lijst' }, '+'));

  async function refresh() {
    if (!alive) return;
    const [todos, leftovers, recipes] = await Promise.all([db.getSetting('todos', {}), db.getSetting('leftovers', []), db.listRecipes()]);
    const hasRecipe = item => recipes.some(r => (r.recipeIngredient ?? []).some(line => lineMatches(item, line)));
    const items = buildTodos(todos, leftovers, hasRecipe);
    fill(list, items.map(it => h('li', { class: 'shoprow todorow' + (it.done ? ' done' : '') + (it.auto ? ' auto' : ''),
      title: it.auto ? 'Automatisch: dit overschot (ECO Cooking) heeft nog geen recept' : '' },
      h('label', { class: 'shopmain' },
        h('input', { type: 'checkbox', checked: it.done, onchange: async e => persist(withTodoDone(await db.getSetting('todos', {}), it.id, e.target.checked)) }),
        h('span', { class: 'sname' }, (it.auto ? '🌿 ' : '') + it.text)),
      h('button', { type: 'button', class: 'ico-btn del', title: it.auto ? 'Verberg dit voorstel' : 'Verwijderen',
        onclick: async () => persist(withTodoRemoved(await db.getSetting('todos', {}), it.id)) }, icon('close', 16)))));
    if (!items.length) fill(list, h('li', { class: 'muted small-text' }, 'Niets te doen. Overschotten zonder recept komen hier automatisch.'));
  }

  const view = { refresh, destroy() { alive = false; views.delete(view); } };
  views.add(view);
  refresh();
  return { el: h('section', { class: 'panel todopanel' }, h('h2', { style: 'margin-top:0' }, '✅ To do'), form, list), view };
}
