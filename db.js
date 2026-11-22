// IndexedDB storage: recipes (JSON, schema.org/Recipe) and images (Blobs).
// Image key = `${recipe.identifier}/${filename}`; recipe.image holds `images/${filename}`.
const DB_NAME = 'kookboek';
let dbPromise;

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 3);
    r.onupgradeneeded = e => {
      const d = r.result;
      if (e.oldVersion < 1) {
        d.createObjectStore('recipes', { keyPath: 'identifier' });
        d.createObjectStore('images');
      }
      if (e.oldVersion < 2) d.createObjectStore('settings'); // key-value: leftovers, ...
      if (e.oldVersion < 3) d.createObjectStore('plan', { keyPath: 'date' }); // menu: {date:'YYYY-MM-DD', recipeId, name}
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

async function run(stores, mode, fn) {
  const db = await open();
  const tx = db.transaction(stores, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  const result = await fn(tx);
  await done;
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

// ---- menu planning: one dish per day; entries are kept forever (history = 'last cooked') ----
// Every entry has `updatedAt` (for sync). A cleared day stays as {recipeId: null} so the removal can be synced.
const stamp = () => new Date().toISOString();
export const listPlanRaw = () => run('plan', 'readonly', tx => wrap(tx.objectStore('plan').getAll()));
export const listPlan = () => listPlanRaw().then(list => list.filter(e => e.recipeId));
export const putPlanRaw = entries =>
  run('plan', 'readwrite', tx => { for (const e of entries) tx.objectStore('plan').put(e); });
export const setPlanDay = (date, recipeId, name) =>
  run('plan', 'readwrite', tx => { tx.objectStore('plan').put({ date, recipeId, name, updatedAt: stamp() }); });
export const clearPlanDay = date =>
  run('plan', 'readwrite', tx => { tx.objectStore('plan').put({ date, recipeId: null, name: '', updatedAt: stamp() }); });
/** Move the dish of `from` to `to`; if `to` is occupied, the two days swap. */
export const movePlan = (from, to) =>
  run('plan', 'readwrite', async tx => {
    const st = tx.objectStore('plan');
    const a = await wrap(st.get(from)), b = await wrap(st.get(to));
    if (!a?.recipeId) return;
    const updatedAt = stamp();
    st.put({ ...a, date: to, updatedAt });
    st.put(b?.recipeId ? { ...b, date: from, updatedAt } : { date: from, recipeId: null, name: '', updatedAt });
  });
