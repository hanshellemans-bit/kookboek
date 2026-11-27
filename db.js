// IndexedDB storage: recipes (JSON, schema.org/Recipe) and images (Blobs).
// Image key = `${recipe.identifier}/${filename}`; recipe.image holds `images/${filename}`.
const DB_NAME = 'kookboek';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 4);
    r.onupgradeneeded = e => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('recipes', { keyPath: 'identifier' });
        d.createObjectStore('images');
      }
      if (e.oldVersion < 2) d.createObjectStore('settings'); // key-value: leftovers, ...
      if (e.oldVersion < 3) d.createObjectStore('plan', { keyPath: 'id' });   // menu: one entry per dish {id, date, recipeId, name, updatedAt, del?}
      else if (e.oldVersion < 4) {
        // v3 kept ONE dish per day, keyed by date. Move to one entry per dish; the id is derived from the date so that two
        // devices migrating the same old entry produce the same id (and merge instead of duplicating).
        const old = r.transaction.objectStore('plan');
        old.getAll().onsuccess = ev => {
          const items = ev.target.result.map(x => ({
            id: 'legacy-' + x.date, date: x.date, recipeId: x.recipeId ?? null, name: x.name ?? '', updatedAt: x.updatedAt ?? '',
            ...(x.recipeId ? {} : { del: true }),
          }));
          d.deleteObjectStore('plan');
          const fresh = d.createObjectStore('plan', { keyPath: 'id' });
          items.forEach(i => fresh.put(i));
        };
      }
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

const wrap = req =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

let changeListener = null;
/** Called after every completed write (recipes, plan, settings...); used for auto-sync. */
export const onChange = fn => { changeListener = fn; };

async function run(stores, mode, fn) {
  const db = await open();
  const tx = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  const result = await fn(tx);
  await done;
  if (mode === 'readwrite') { try { changeListener?.(); } catch (e) { console.warn(e); } }
  return result;
}

export const imageKey = (id, file) => `${id}/${file.split('/').pop()}`;

export const listRecipes = () => run('recipes', 'readonly', tx => wrap(tx.objectStore('recipes').getAll()));
export const getRecipe = id => run('recipes', 'readonly', tx => wrap(tx.objectStore('recipes').get(id)));
export const getImage = key => run('images', 'readonly', tx => wrap(tx.objectStore('images').get(key)));

/** Save a recipe; `add` = {key: Blob} to store, `remove` = [key] to delete. */
export function saveRecipe(recipe, add = {}, remove = []) {
  return run(['recipes', 'images'], 'readwrite', tx => {
    tx.objectStore('recipes').put(recipe);
    for (const [k, blob] of Object.entries(add)) tx.objectStore('images').put(blob, k);
    for (const k of remove) tx.objectStore('images').delete(k);
  });
}

/** Delete a recipe. A tombstone ({id: ISO time}) is kept so the deletion can be synced to other devices. */
/** One-time cleanup: the 'favourite' field no longer exists. Does not touch dateModified (nothing to sync). */
export async function dropLegacyFields() {
  const dirty = (await listRecipes()).filter(r => 'x-favourite' in r);
  if (!dirty.length) return 0;
  await run('recipes', 'readwrite', tx => {
    for (const r of dirty) { const { 'x-favourite': _gone, ...rest } = r; tx.objectStore('recipes').put(rest); }
  });
  return dirty.length;
}

export function deleteRecipe(recipe, { tombstone = true } = {}) {
  return run(['recipes', 'images', 'settings'], 'readwrite', async tx => {
    tx.objectStore('recipes').delete(recipe.identifier);
    for (const f of recipe.image ?? []) tx.objectStore('images').delete(imageKey(recipe.identifier, f));
    if (tombstone) {
      const st = tx.objectStore('settings');
      const dead = (await wrap(st.get('deletedRecipes'))) ?? {};
      dead[recipe.identifier] = new Date().toISOString();
      st.put(dead, 'deletedRecipes');
    }
  });
}

export const getSetting = (key, fallback) =>
  run('settings', 'readonly', tx => wrap(tx.objectStore('settings').get(key))).then(v => v ?? fallback);
export const setSetting = (key, value) =>
  run('settings', 'readwrite', tx => { tx.objectStore('settings').put(value, key); });

/** Add items to the ECO Cooking list (case-insensitive, no duplicates). Returns the items that were really added. */
export async function addLeftovers(items) {
  const cur = await getSetting('leftovers', []);
  const have = new Set(cur.map(x => x.toLowerCase()));
  const added = [];
  for (const raw of items ?? []) {
    const it = String(raw).trim();
    if (it && !have.has(it.toLowerCase())) { have.add(it.toLowerCase()); added.push(it); }
  }
  if (added.length) {
    await setSetting('leftovers', [...cur, ...added]);
    await setSetting('leftoversUpdatedAt', new Date().toISOString());          // for sync
  }
  return added;
}

// Settings that sync between devices (see syncCore.mergeSettings)
export async function getSyncSettings() {
  return {
    leftovers: await getSetting('leftovers', []),
    leftoversUpdatedAt: await getSetting('leftoversUpdatedAt', ''),
    shopPrefs: await getSetting('shopPrefs', {}),
    shopChecks: await getSetting('shopChecks', {}),
    shopExtra: await getSetting('shopExtra', {}),
    todos: await getSetting('todos', {}),
    algo: await getSetting('algoWeights', null),
  };
}
export async function putSyncSettings(s) {
  await setSetting('leftovers', s.leftovers ?? []);
  await setSetting('leftoversUpdatedAt', s.leftoversUpdatedAt ?? '');
  await setSetting('shopPrefs', s.shopPrefs ?? {});
  await setSetting('shopChecks', s.shopChecks ?? {});
  await setSetting('shopExtra', s.shopExtra ?? {});
  await setSetting('todos', s.todos ?? {});
  if (s.algo) await setSetting('algoWeights', s.algo);
}

// ---- menu planning: any number of dishes per day; entries are kept forever (history = 'last cooked') ----
// Entry = { id, date: 'YYYY-MM-DD', recipeId, name, updatedAt, del? }. Removing a dish keeps the entry with del:true so the
// removal can be synced; `updatedAt` decides which device wins.
const stamp = () => new Date().toISOString();
export const listPlanRaw = () => run('plan', 'readonly', tx => wrap(tx.objectStore('plan').getAll()));
export const listPlan = () => listPlanRaw().then(list => list.filter(e => e.recipeId && !e.del));
export const putPlanRaw = entries =>
  run('plan', 'readwrite', tx => { for (const e of entries) tx.objectStore('plan').put(e); });

/** Add a dish to a day (the same dish twice on one day returns the existing entry). */
export const addPlanItem = (date, recipeId, name) =>
  run('plan', 'readwrite', async tx => {
    const st = tx.objectStore('plan');
    const same = (await wrap(st.getAll())).find(e => !e.del && e.date === date && e.recipeId === recipeId);
    if (same) return same;
    const entry = { id: crypto.randomUUID(), date, recipeId, name, updatedAt: stamp() };
    st.put(entry);
    return entry;
  });

export const removePlanItem = id =>
  run('plan', 'readwrite', async tx => {
    const st = tx.objectStore('plan');
    const e = await wrap(st.get(id));
    if (e) st.put({ ...e, del: true, updatedAt: stamp() });
  });

/** Move one dish to another day; returns the updated entry. */
export const movePlanItem = (id, toDate) =>
  run('plan', 'readwrite', async tx => {
    const st = tx.objectStore('plan');
    const e = await wrap(st.get(id));
    if (!e) return null;
    const moved = { ...e, date: toDate, updatedAt: stamp() };
    st.put(moved);
    return moved;
  });
