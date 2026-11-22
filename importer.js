// Import recipes (recipe.json + images) from the sample folder on the server or from a chosen local folder.
import * as db from './db.js';
import { h } from './util.js';

/** Returns 'added' | 'updated' | 'skipped'. Updates only when the file is newer (dateModified). */
export async function importOne(recipe, getBlob) {
  recipe.identifier ||= crypto.randomUUID();
  const existing = await db.getRecipe(recipe.identifier);
  if (existing && !((recipe.dateModified ?? '') > (existing.dateModified ?? ''))) return 'skipped';
  if (existing) {                       // keep personal data
    recipe['x-favourite'] = existing['x-favourite'] ?? recipe['x-favourite'];
    recipe['x-rating'] = existing['x-rating'] ?? recipe['x-rating'];
  }
  const add = {};
  for (const img of recipe.image ?? []) {
    const blob = await getBlob(img);
    if (blob) add[db.imageKey(recipe.identifier, img)] = blob;
  }
  await db.saveRecipe(recipe, add);
  return existing ? 'updated' : 'added';
}

async function importFromFolder(fileList) {
  const byPath = new Map([...fileList].map(f => [f.webkitRelativePath, f]));
  const counts = { added: 0, updated: 0, skipped: 0 };
  for (const [path, file] of byPath) {
    if (!path.endsWith('/recipe.json')) continue;
    const dir = path.slice(0, -'recipe.json'.length);
    const recipe = JSON.parse(await file.text());
    counts[await importOne(recipe, async img => byPath.get(dir + img) ?? null)]++;
  }
  return counts;
}

async function importSamples() {
  const base = new URL('../recipes/', location.href);
  const slugs = await (await fetch(new URL('index.json', base))).json();
  const counts = { added: 0, updated: 0, skipped: 0 };
  for (const slug of slugs) {
    const dir = new URL(slug + '/', base);
    const recipe = await (await fetch(new URL('recipe.json', dir))).json();
    counts[await importOne(recipe, async img => {
      const r = await fetch(new URL(img, dir));
      return r.ok ? r.blob() : null;
    })]++;
  }
  return counts;
}

/** UI block; `onChange` is called (after a short delay) when recipes were added or updated. */
export function importControls(onChange) {
  const status = h('p', { class: 'muted' });
  const done = ({ added, updated, skipped }) => {
    status.textContent = `${added} toegevoegd, ${updated} bijgewerkt, ${skipped} ongewijzigd.`;
    if (added || updated) setTimeout(onChange, 800);
  };
  const guard = fn => async (...a) => {
    try { status.textContent = 'Bezig…'; done(await fn(...a)); }
    catch (err) { status.textContent = 'Mislukt: ' + err.message; }
  };
  // the sample recipes only exist next to the app on the development server, not on the hosted site
  const isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
  return h('div', {},
    isDev && h('p', {}, h('button', { class: 'btn', onclick: guard(importSamples) }, 'Laad voorbeeldrecepten (../recipes)')),
    h('p', {},
      h('label', { class: 'muted' }, 'Of kies een map met recepten (mappen met recipe.json):'),
      h('input', { type: 'file', webkitdirectory: true, onchange: e => guard(importFromFolder)(e.target.files) })
    ),
    status
  );
}

// ---------- dialog opened by the "Importeren" button in the header ----------
let dialog = null;
export function closeImportDialog() {
  dialog?.remove();
  dialog = null;
}

export function openImportDialog(onChange) {
  closeImportDialog();
  dialog = h('div', { class: 'backdrop', onclick: e => { if (e.target === dialog) closeImportDialog(); } },
    h('div', { class: 'modal narrow' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, '📥 Recepten importeren'),
        h('button', { class: 'btn small', type: 'button', onclick: closeImportDialog }, 'Sluiten')),
      h('p', { class: 'muted small-text' }, 'Kies een map met recepten (mappen met een recipe.json en een map images). Bestaande recepten worden alleen bijgewerkt als het bestand nieuwer is.'),
      importControls(() => { closeImportDialog(); onChange(); })));
  document.body.append(dialog);
}
