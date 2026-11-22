// Pure sync logic (no browser APIs): reconciles a `local` store with a `remote` store.
// Unit-tested with in-memory fakes (tools/test_sync.mjs); in the app `remote` is Google Drive.
//
// Remote layout (one folder):
//   recipe-<id>.zip   recipe.json + images/*   (appProperties.dm = recipe.dateModified)
//   plan.json         menu entries [{date, recipeId|null, name, updatedAt}]  (per-day, newest wins)
//   settings.json     {leftovers, leftoversUpdatedAt}                          (newest wins)
//   deleted.json      tombstones {recipeId: ISO time of deletion}
//
// Rules: per recipe the newest dateModified wins; a deletion wins unless the recipe was edited after it.
//
// local interface:  listRecipeMeta() -> [{id, dm}], getRecipeBundle(id) -> Uint8Array, putRecipeBundle(id, bytes),
//   deleteRecipe(id), getTombstones(), setTombstones(obj), getPlanRaw(), putPlanRaw(entries),
//   getSettings() -> {leftovers, leftoversUpdatedAt}, putSettings(obj)
// remote interface: list() -> [{id, name, appProperties}], download(id) -> Uint8Array,
//   upload({name, data, existingId, appProperties, mime}) -> {id, name, appProperties}, remove(id)

const ms = s => (!s || s === '0' ? 0 : Date.parse(s) || 0);
const json = o => JSON.stringify(o);

/** Per date the entry with the newest updatedAt wins; ties keep the first argument. */
export function mergePlan(a, b) {
  const byDate = new Map();
  for (const e of [...a, ...b]) {
    const cur = byDate.get(e.date);
    if (!cur || ms(e.updatedAt) > ms(cur.updatedAt)) byDate.set(e.date, e);
  }
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date));
}

export async function syncCore({ local, remote, onProgress = () => {} }) {
  const res = { up: 0, down: 0, same: 0, removedLocal: 0, removedRemote: 0, localChanged: false };
  const td = new TextDecoder(), te = new TextEncoder();

  const files = await remote.list();
  const byName = new Map(files.map(f => [f.name, f]));
  const readJson = async name => {
    const f = byName.get(name);
    return f ? JSON.parse(td.decode(await remote.download(f.id))) : null;
  };
  const writeJson = async (name, obj) => {
    const saved = await remote.upload({
      name, data: te.encode(json(obj)), existingId: byName.get(name)?.id, appProperties: {}, mime: 'application/json',
    });
    byName.set(name, saved);
  };

  // ---- 1. deletions ----
  const remoteDel = (await readJson('deleted.json')) ?? {};
  const del = { ...remoteDel };
  for (const [id, ts] of Object.entries(await local.getTombstones())) {
    if (!(id in del) || ms(ts) > ms(del[id])) del[id] = ts;
  }
  const metas = new Map((await local.listRecipeMeta()).map(m => [m.id, m.dm || '']));
  for (const [id, ts] of Object.entries(del)) {
    const rf = byName.get(`recipe-${id}.zip`);
    const ldm = metas.get(id);
    if (Math.max(ms(ldm), ms(rf?.appProperties?.dm)) > ms(ts)) { delete del[id]; continue; }   // edited after deletion: keep
    if (ldm !== undefined) { await local.deleteRecipe(id); metas.delete(id); res.removedLocal++; res.localChanged = true; }
    if (rf) { await remote.remove(rf.id); byName.delete(rf.name); res.removedRemote++; }
  }

  // ---- 2. recipes ----
  const remoteRecipes = new Map();
  for (const f of byName.values()) {
    const m = /^recipe-(.+)\.zip$/.exec(f.name);
    if (m) remoteRecipes.set(m[1], f);
  }
  const ids = [...new Set([...metas.keys(), ...remoteRecipes.keys()])];
  let n = 0;
  for (const id of ids) {
    onProgress({ step: 'recipes', done: n++, total: ids.length });
    const ldm = metas.get(id), rf = remoteRecipes.get(id);
    let dir;
    if (ldm === undefined) dir = 'down';
    else if (!rf) dir = 'up';
    else {
      const l = ms(ldm), r = ms(rf.appProperties?.dm);
      dir = r > l ? 'down' : l > r ? 'up' : 'same';
    }
    if (dir === 'up') {
      await remote.upload({
        name: `recipe-${id}.zip`, data: await local.getRecipeBundle(id), existingId: rf?.id,
        appProperties: { dm: ldm || '0' }, mime: 'application/zip',
      });
      res.up++;
    } else if (dir === 'down') {
      await local.putRecipeBundle(id, await remote.download(rf.id));
      res.down++; res.localChanged = true;
    } else res.same++;
  }

  // ---- 3. menu ----
  onProgress({ step: 'plan' });
  const remotePlan = (await readJson('plan.json')) ?? [];
  const localPlan = mergePlan(await local.getPlanRaw(), []);
  const mergedPlan = mergePlan(localPlan, remotePlan);
  if (json(mergedPlan) !== json(localPlan)) { await local.putPlanRaw(mergedPlan); res.localChanged = true; }
  if (json(mergedPlan) !== json(mergePlan(remotePlan, []))) await writeJson('plan.json', mergedPlan);

  // ---- 4. leftovers ----
  const remoteSettings = await readJson('settings.json');
  const localSettings = await local.getSettings();
  const r = ms(remoteSettings?.leftoversUpdatedAt), l = ms(localSettings.leftoversUpdatedAt);
  if (remoteSettings && r > l) { await local.putSettings(remoteSettings); res.localChanged = true; }
  else if ((l > r) || (!remoteSettings && localSettings.leftovers?.length)) await writeJson('settings.json', localSettings);

  // ---- 5. tombstones ----
  await local.setTombstones(del);
  if (json(del) !== json(remoteDel) && (Object.keys(del).length || byName.has('deleted.json'))) await writeJson('deleted.json', del);

  return res;
}
