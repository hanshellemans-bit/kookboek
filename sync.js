// Wires the pure sync logic (syncCore.js) to IndexedDB (local) and Google Drive (remote).
import * as db from './db.js';
import { syncCore } from './syncCore.js';
import { buildRecipeBundle, readRecipeBundle } from './backup.js';
import { createDriveRemote, getToken } from './drive.js';
import { GOOGLE_CLIENT_ID } from './config.js';

export const getClientId = async () => ((await db.getSetting('googleClientId', '')) || GOOGLE_CLIENT_ID || '').trim();

/** `local` adapter for syncCore, backed by IndexedDB. */
export const localStore = {
  async listRecipeMeta() {
    return (await db.listRecipes()).map(r => ({ id: r.identifier, dm: r.dateModified || '' }));
  },
  async getRecipeBundle(id) {
    const recipe = await db.getRecipe(id);
    return buildRecipeBundle(recipe, f => db.getImage(db.imageKey(id, f)));
  },
  async putRecipeBundle(id, bytes) {
    const { recipe, images } = await readRecipeBundle(bytes);
    recipe.identifier = id;
    delete recipe['x-favourite'];                       // old field from another device
    const old = await db.getRecipe(id);
    const add = {};
    for (const f of recipe.image ?? []) {
      const blob = images.get(`images/${f.split('/').pop()}`);
      if (blob) add[db.imageKey(id, f)] = blob;
    }
    const keep = new Set(Object.keys(add));
    const remove = (old?.image ?? []).map(f => db.imageKey(id, f)).filter(k => !keep.has(k));
    await db.saveRecipe(recipe, add, remove);
  },
  async deleteRecipe(id) {
    const r = await db.getRecipe(id);
    if (r) await db.deleteRecipe(r, { tombstone: false });
  },
  getTombstones: () => db.getSetting('deletedRecipes', {}),
  setTombstones: obj => db.setSetting('deletedRecipes', obj),
  getPlanRaw: () => db.listPlanRaw(),
  putPlanRaw: entries => db.putPlanRaw(entries),
  getSettings: () => db.getSyncSettings(),
  putSettings: s => db.putSyncSettings(s),
};

/** Run a sync against any remote (Drive in the app, a fake in tests). */
export async function runSyncWith(remote, onProgress) {
  const res = await syncCore({ local: localStore, remote, onProgress });
  await db.setSetting('lastSync', { at: new Date().toISOString(), ...res });
  return res;
}

export async function syncWithDrive(onProgress) {
  const clientId = await getClientId();
  if (!clientId) throw new Error('NO_CLIENT_ID');
  const remote = createDriveRemote({
    getAccessToken: force => getToken(clientId, { force }),
    folderId: await db.getSetting('driveFolderId', null),
  });
  const folderId = await remote.init();
  await db.setSetting('driveFolderId', folderId);
  return runSyncWith(remote, onProgress);
}

export const describe = r =>
  `↑${r.up} ↓${r.down} =${r.same}` + (r.removedLocal || r.removedRemote ? ` 🗑${r.removedLocal + r.removedRemote}` : '');
