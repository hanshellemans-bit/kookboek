import * as db from './db.js';
import { renderHome, closeModal } from './home.js';
import { syncWithDrive, describe } from './sync.js';
import { openSettings, closeSettings } from './settings.js';
import { openShopFullscreen, closeShopFullscreen } from './shopui.js';
import { openImportDialog, closeImportDialog } from './importer.js';
import { guessLikelyLeftovers } from './shop.js';
import { h, fill, urlFor, revokeUrls, minutes, fmtMinutes, ymd, parseYmd, fmtDay, daysBetween, agoText, planStats } from './util.js';

const root = document.getElementById('app');
let wakeLock = null;

// ---------- helpers ----------

function cleanupRoute() {
  revokeUrls();
  closeModal();
  closeSettings();
  closeShopFullscreen();
  closeImportDialog();
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function isoFromMinutes(min) {
  min = Math.max(0, Math.round(+min || 0));
  if (!min) return '';
  const hh = Math.floor(min / 60), mm = min % 60;
  return 'PT' + (hh ? hh + 'H' : '') + (mm ? mm + 'M' : '');
}
function groupsOf(recipe) {
  if (recipe['x-ingredientGroups']?.length) return recipe['x-ingredientGroups'];
  return recipe.recipeIngredient?.length ? [{ name: null, items: recipe.recipeIngredient }] : [];
}

/** Textarea text -> groups. A line ending in ':' starts a new group. */
function parseIngredients(text) {
  const groups = [];
  let cur = { name: null, items: [] };
  const flush = () => cur.items.length && groups.push(cur);
  for (let line of text.split('\n')) {
    line = line.trim().replace(/^[-•*]\s*/, '');
    if (!line) continue;
    if (line.endsWith(':') && line.length < 60) {
      flush();
      cur = { name: line.slice(0, -1), items: [] };
    } else cur.items.push(line);
  }
  flush();
  return groups;
}
function ingredientsToText(groups) {
  return groups.map(g => (g.name ? g.name + ':\n' : '') + g.items.join('\n')).join('\n\n');
}

const stepText = s => (typeof s === 'string' ? s : s.text ?? '');

async function shrinkImage(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
}

// ---------- detail view ----------

async function renderDetail(id) {
  const r = await db.getRecipe(id);
  if (!r) return notFound();

  const photos = h('div', { class: 'photos' });
  for (const f of r.image ?? []) {
    const img = h('img', { alt: r.name });
    db.getImage(db.imageKey(id, f)).then(b => b && (img.src = urlFor(b)));
    photos.append(img);
  }

  const stars = h('span', { class: 'stars' });
  const drawStars = () => stars.replaceChildren(...[1, 2, 3, 4, 5].map(n =>
    h('button', { type: 'button', class: 'star' + (n <= (r['x-rating'] || 0) ? ' on' : ''), title: `${n} ${n === 1 ? 'ster' : 'sterren'}`,
      onclick: async () => {
        r['x-rating'] = r['x-rating'] === n ? 0 : n;      // click the current rating again to clear it
        r.dateModified = new Date().toISOString();
        await db.saveRecipe(r);
        drawStars();
      } }, '★')));
  drawStars();

  const wake = h('button', { class: 'btn', onclick: async () => {
    if (wakeLock) { await wakeLock.release(); return; }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wake.classList.add('on');
      wakeLock.addEventListener('release', () => { wakeLock = null; wake.classList.remove('on'); });
    } catch { alert('Scherm aanhouden wordt niet ondersteund.'); }
  } }, '💡 Scherm aan');

  const planEntries = await db.listPlan();
  const stats = planStats(planEntries);
  const lastDate = stats.last.get(id), nextDate = stats.next.get(id);
  const menuLine = [
    lastDate ? `Laatst op het menu: ${fmtDay(parseYmd(lastDate))} (${agoText(daysBetween(lastDate, ymd(new Date())))})` : 'Nog nooit op het menu gestaan.',
    nextDate && `Gepland: ${fmtDay(parseYmd(nextDate))}`,
  ].filter(Boolean).join(' · ');
  const planDate = h('input', { type: 'date', value: ymd(new Date()), style: 'width:auto' });
  const planStatus = h('span', { class: 'muted' });
  const planBtn = h('button', { class: 'btn', type: 'button', onclick: async () => {
    if (!planDate.value) return;
    await db.addPlanItem(planDate.value, id, r.name);
    const added = await db.addLeftovers(r['x-likelyLeftovers'] ?? []);
    planStatus.textContent = `✓ Op het menu gezet voor ${fmtDay(parseYmd(planDate.value))}` + (added.length ? ` · bij overschotten: ${added.join(', ')}` : '');
  } }, '📅 Op het menu');

  const meta = [
    r.recipeYield && `Porties: ${r.recipeYield}`,
    minutes(r.prepTime) && `Voorbereiding: ${fmtMinutes(minutes(r.prepTime))}`,
    minutes(r.cookTime) && `Bereiding: ${fmtMinutes(minutes(r.cookTime))}`,
    r.recipeCategory && `Gang: ${r.recipeCategory}`,
    r.keywords && `Categorie: ${r.keywords}`,
    r.author?.name && `Chef: ${r.author.name}`,
    r['x-likelyLeftovers']?.length && `Waarschijnlijke overschotten: ${r['x-likelyLeftovers'].join(', ')}`,
    r.isBasedOn && ['Bron: ', /^https?:/.test(r['x-sourceUrl'] ?? '')
      ? h('a', { href: r['x-sourceUrl'], target: '_blank', rel: 'noopener noreferrer' }, r.isBasedOn + ' ↗') : r.isBasedOn],
  ].filter(Boolean);

  const nut = r.nutrition ? Object.entries(r.nutrition).filter(([k]) => !k.startsWith('@')) : [];
  const nutLabels = { servingSize: 'Portie', calories: 'Calorieën', fatContent: 'Vet', saturatedFatContent: 'Verzadigd vet',
    cholesterolContent: 'Cholesterol', sodiumContent: 'Natrium', carbohydrateContent: 'Koolhydraten',
    sugarContent: 'Suikers', fiberContent: 'Vezels', proteinContent: 'Eiwit' };

  fill(root,
    h('p', {}, h('a', { href: '#/' }, '← Alle recepten')),
    h('h1', {}, r.name),
    r.description && h('p', { class: 'muted' }, r.description),
    h('div', { class: 'row' }, stars, wake,
      h('a', { class: 'btn', href: `#/edit/${id}` }, '✎ Bewerken')),
    photos.children.length ? photos : null,
    h('div', { class: 'meta' }, meta.map(m => h('span', {}, m))),
    h('p', { class: 'menuline' }, '🍽 ', menuLine),
    h('div', { class: 'row' }, planDate, planBtn, planStatus),
    h('div', { class: 'cols' },
      h('section', {},
        h('h2', {}, 'Ingrediënten'),
        groupsOf(r).map(g => [
          g.name && h('h3', {}, g.name),
          h('ul', { class: 'ingr' }, g.items.map(i => h('li', {}, i))),
        ]),
        !groupsOf(r).length && h('p', { class: 'muted' }, 'Geen ingrediënten.')
      ),
      h('section', {},
        h('h2', {}, 'Bereiding'),
        r.recipeInstructions?.length
          ? h('ol', { class: 'steps' }, r.recipeInstructions.map(s => h('li', {}, stepText(s))))
          : h('p', { class: 'muted' }, 'Geen stappen.')
      )
    ),
    r['x-tip'] && h('div', { class: 'tip' }, h('strong', {}, '💡 Tip van de chef'), h('div', { class: 'notes' }, r['x-tip'])),
    r['x-notes'] && [h('h2', {}, 'Notities'), h('div', { class: 'notes' }, r['x-notes'])],
    nut.length && [h('h2', {}, 'Voeding'),
      h('table', { class: 'nut' }, nut.map(([k, v]) => h('tr', {}, h('td', {}, nutLabels[k] ?? k), h('td', {}, v))))]
  );
}

function notFound() {
  root.replaceChildren(h('p', {}, 'Recept niet gevonden. ', h('a', { href: '#/' }, 'Terug')));
}

// ---------- edit view ----------

async function renderEdit(id) {
  const isNew = id === 'new';
  const r = isNew
    ? { '@context': 'https://schema.org', '@type': 'Recipe', identifier: crypto.randomUUID(), name: '' }
    : await db.getRecipe(id);
  if (!r) return notFound();

  let images = [...(r.image ?? [])];           // filenames 'images/x.jpg'
  const added = {};                             // key -> Blob (new, unsaved)
  const removed = [];                           // keys to delete on save
  const thumbs = h('div', { class: 'thumbs' });

  const drawThumbs = async () => {
    thumbs.replaceChildren();
    for (const f of images) {
      const key = db.imageKey(r.identifier, f);
      const img = h('img', { alt: '' });
      const blob = added[key] ?? await db.getImage(key);
      if (blob) img.src = urlFor(blob);
      thumbs.append(h('figure', {}, img, h('button', { type: 'button', title: 'Verwijder foto', onclick: () => {
        images = images.filter(x => x !== f);
        if (added[key]) delete added[key]; else removed.push(key);
        drawThumbs();
      } }, '×')));
    }
  };

  const f = {
    name: h('input', { required: true, value: r.name }),
    cat: h('input', { value: r.recipeCategory ?? '', placeholder: 'Hoofdgerecht, Nagerecht…', list: 'cats' }),
    kw: h('input', { value: r.keywords ?? '', placeholder: 'Pasta, Vis… (komma-gescheiden)' }),
    yield: h('input', { value: r.recipeYield ?? '', placeholder: '4 pers' }),
    prep: h('input', { type: 'number', min: 0, inputmode: 'numeric', value: minutes(r.prepTime) || '' }),
    cook: h('input', { type: 'number', min: 0, inputmode: 'numeric', value: minutes(r.cookTime) || '' }),
    source: h('input', { value: r.isBasedOn ?? '' }),
    chef: h('input', { value: r.author?.name ?? '', placeholder: 'Naam van de chef' }),
    likely: h('input', { value: (r['x-likelyLeftovers'] ?? []).join(', '), placeholder: 'bv. lente-ui, koriander', autocomplete: 'off' }),
    tip: h('textarea', { rows: 3 }, r['x-tip'] ?? ''),
    ingr: h('textarea', { rows: 10 }, ingredientsToText(groupsOf(r))),
    steps: h('textarea', { rows: 10 }, (r.recipeInstructions ?? []).map(stepText).join('\n')),
    notes: h('textarea', { rows: 4 }, r['x-notes'] ?? ''),
  };

  const cats = [...new Set((await db.listRecipes()).map(x => x.recipeCategory).filter(Boolean))];

  // suggestions for the field, from the ingredient list (bunches, fresh herbs, ginger); click to add
  const guessBox = h('div', { class: 'chips' });
  const drawGuess = () => {
    const have = new Set(f.likely.value.split(/[,;]/).map(x => x.trim().toLowerCase()));
    const guesses = guessLikelyLeftovers(parseIngredients(f.ingr.value).flatMap(g => g.items)).filter(g => !have.has(g));
    guessBox.replaceChildren(...(guesses.length ? [h('span', { class: 'muted small-text' }, 'Voorstel:')] : []),
      ...guesses.map(g => h('button', { type: 'button', class: 'tag', title: 'Toevoegen aan de waarschijnlijke overschotten', onclick: () => {
        f.likely.value = [f.likely.value.trim().replace(/,$/, ''), g].filter(Boolean).join(', ');
        drawGuess();
      } }, '+ ' + g)));
  };
  f.ingr.addEventListener('input', drawGuess);
  f.likely.addEventListener('input', drawGuess);

  const form = h('form', { onsubmit: async e => {
    e.preventDefault();
    const groups = parseIngredients(f.ingr.value);
    const out = {
      ...r,
      name: f.name.value.trim(),
      recipeCategory: f.cat.value.trim(),
      keywords: f.kw.value.trim(),
      recipeYield: f.yield.value.trim(),
      prepTime: isoFromMinutes(f.prep.value),
      cookTime: isoFromMinutes(f.cook.value),
      isBasedOn: f.source.value.trim(),
      author: f.chef.value.trim() ? { '@type': 'Person', name: f.chef.value.trim() } : '',
      'x-tip': f.tip.value.trim(),
      'x-likelyLeftovers': [...new Set(f.likely.value.split(/[,;]/).map(x => x.trim()).filter(Boolean))],
      recipeIngredient: groups.flatMap(g => g.items),
      'x-ingredientGroups': groups,
      recipeInstructions: f.steps.value.split('\n').map(s => s.trim()).filter(Boolean)
        .map(text => ({ '@type': 'HowToStep', text })),
      'x-notes': f.notes.value.trim(),
      image: images,
      dateModified: new Date().toISOString(),
    };
    for (const k of Object.keys(out)) if (out[k] === '' || (Array.isArray(out[k]) && !out[k].length)) delete out[k];
    await db.saveRecipe(out, added, removed);
    location.hash = `#/r/${out.identifier}`;
  } },
    h('p', {}, h('a', { href: isNew ? '#/' : `#/r/${r.identifier}` }, '← Annuleren')),
    h('h1', {}, isNew ? 'Nieuw recept' : 'Recept bewerken'),
    h('label', {}, 'Naam'), f.name,
    h('div', { class: 'two' },
      h('div', {}, h('label', {}, 'Gang'), f.cat),
      h('div', {}, h('label', {}, 'Categorie'), f.kw)),
    h('datalist', { id: 'cats' }, cats.map(c => h('option', { value: c }))),
    h('div', { class: 'two' },
      h('div', {}, h('label', {}, 'Porties'), f.yield),
      h('div', {}, h('label', {}, 'Bron'), f.source)),
    h('label', {}, 'Chef ', h('span', { class: 'hint' }, '— zet de naam ook bij Categorie als je erop wilt zoeken/filteren')),
    f.chef,
    h('div', { class: 'two' },
      h('div', {}, h('label', {}, 'Voorbereiding (min)'), f.prep),
      h('div', {}, h('label', {}, 'Bereiding (min)'), f.cook)),
    h('label', {}, 'Ingrediënten ', h('span', { class: 'hint' }, '— één per regel; een regel met ":" op het einde is een kopje (bv. "Voor de saus:")')),
    f.ingr,
    h('label', {}, 'Bereiding ', h('span', { class: 'hint' }, '— één stap per regel')),
    f.steps,
    h('label', {}, 'Waarschijnlijke overschotten ', h('span', { class: 'hint' },
      '— wat blijft er meestal van over (bv. een bosje lente-ui)? Het komt bij je overschotten zodra je dit gerecht op het menu zet; '
      + 'andere recepten die precies dat gebruiken krijgen een 🔗 in de suggesties.')),
    f.likely, guessBox,
    h('label', {}, 'Tip van de chef'), f.tip,
    h('label', {}, 'Notities'), f.notes,
    h('label', {}, 'Foto\'s'),
    thumbs,
    h('p', {}, h('input', { type: 'file', accept: 'image/*', multiple: true, onchange: async e => {
      for (const file of e.target.files) {
        const blob = await shrinkImage(file);
        const name = `images/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.jpg`;
        added[db.imageKey(r.identifier, name)] = blob;
        images.push(name);
      }
      e.target.value = '';
      drawThumbs();
    } })),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', type: 'submit' }, 'Opslaan'),
      !isNew && h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!confirm(`"${r.name}" definitief verwijderen?`)) return;
        await db.deleteRecipe(r);
        location.hash = '#/';
      } }, 'Verwijderen'))
  );

  root.replaceChildren(form);
  drawThumbs();
  drawGuess();
}

// ---------- router ----------

async function route() {
  cleanupRoute();
  const [, view, id] = location.hash.split('/');
  root.className = view === 'r' || view === 'edit' ? 'page' : 'wide';
  try {
    if (view === 'r' && id) await renderDetail(id);
    else if (view === 'edit' && id) await renderEdit(id);
    else await renderHome(root, route);
  } catch (err) {
    console.error(err);
    root.replaceChildren(h('p', {}, 'Er ging iets mis: ' + err.message));
  }
  window.scrollTo(0, 0);
}

// ---------- header: sync + settings ----------

const syncBtn = document.getElementById('syncBtn');
const syncStatus = document.getElementById('syncStatus');
let syncing = false;
let statusTimer;

function showStatus(text, bad = false, clearAfter = 0) {
  clearTimeout(statusTimer);
  syncStatus.textContent = text;
  syncStatus.style.color = bad ? '#b00020' : '';
  if (clearAfter) statusTimer = setTimeout(() => { syncStatus.textContent = ''; }, clearAfter);
}

async function doSync() {
  if (syncing) return;
  if (!navigator.onLine) return showStatus('⚠ Geen internetverbinding', true, 8000);
  syncing = true;
  syncBtn.disabled = true;
  showStatus('Synchroniseren…');
  try {
    const res = await syncWithDrive(p => p.step === 'recipes' && showStatus(`Synchroniseren… ${p.done}/${p.total}`));
    showStatus('✓ ' + describe(res), false, 10000);
    if (res.localChanged) await route();
  } catch (err) {
    if (err.message === 'NO_CLIENT_ID') {
      showStatus('');
      openSettings({ onSync: doSync, reload: route, focusClientId: true });
    } else showStatus('⚠ ' + err.message, true);
  } finally {
    syncing = false;
    syncBtn.disabled = false;
  }
}

syncBtn.addEventListener('click', doSync);
document.getElementById('shopBtn').addEventListener('click', openShopFullscreen);
document.getElementById('importBtn').addEventListener('click', () => openImportDialog(route));
document.getElementById('settingsBtn').addEventListener('click', () => openSettings({ onSync: doSync, reload: route }));

addEventListener('hashchange', route);
// the favourite concept is gone (the stars say it): drop the old field from locally stored recipes, then show the page
db.dropLegacyFields().catch(console.warn).finally(route);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.warn);
