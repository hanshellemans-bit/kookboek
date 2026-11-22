// Pure sync logic (no browser APIs): reconciles a `local` store with a `remote` store.
// Unit-tested with in-memory fakes (tools/test_sync.mjs); in the app `remote` is Google Drive.
//
// Remote layout (one folder):
//   recipe-<id>.zip   recipe.json + images/*   (appProperties.dm = recipe.dateModified)
//   plan.json         menu entries [{id, date, recipeId, name, updatedAt, del?}]  (per dish, newest wins)
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

/** Entries from before "several dishes per day" have no id and recipeId:null for an empty day: normalise both. */
const normPlan = e => ({ ...e, id: e.id ?? `legacy-${e.date}`, ...(e.recipeId == null && !e.del ? { del: true } : {}) });

/** Per dish (entry id) the newest updatedAt wins; ties keep the first argument. Sorted by date, then id. */
export function mergePlan(a, b) {
  const byId = new Map();
  for (const raw of [...a, ...b]) {
    const e = normPlan(raw);
    const cur = byId.get(e.id);
    if (!cur || ms(e.updatedAt) > ms(cur.updatedAt)) byId.set(e.id, e);
  }
  return [...byId.values()].sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
}

/** Per key the entry with the newest `t` wins (shopping prefs / checks). */
export function mergeKeyed(a = {}, b = {}) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) if (!out[k] || ms(v.t) > ms(out[k].t)) out[k] = v;
  return out;
}

/** Leftovers: newest list wins (ties keep `a`). Shopping prefs/checks: newest per ingredient. Also fills defaults. */
export function mergeSettings(a = {}, b = {}) {
  const lead = ms(b.leftoversUpdatedAt) > ms(a.leftoversUpdatedAt) ? b : a;
  return {
    leftovers: lead.leftovers ?? [],
    leftoversUpdatedAt: lead.leftoversUpdatedAt ?? '',
    shopPrefs: mergeKeyed(a.shopPrefs, b.shopPrefs),
    shopChecks: mergeKeyed(a.shopChecks, b.shopChecks),
    shopExtra: mergeKeyed(a.shopExtra, b.shopExtra),
    todos: mergeKeyed(a.todos, b.todos),
  };
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

  // ---- 4. leftovers + shopping list state ----
  const remoteSettings = await readJson('settings.json');
  const localSettings = mergeSettings(await local.getSettings(), {});
  const mergedSettings = mergeSettings(localSettings, remoteSettings ?? {});
  if (json(mergedSettings) !== json(localSettings)) { await local.putSettings(mergedSettings); res.localChanged = true; }
  const hasContent = mergedSettings.leftovers.length || Object.keys(mergedSettings.shopPrefs).length || Object.keys(mergedSettings.shopChecks).length || Object.keys(mergedSettings.shopExtra).length || Object.keys(mergedSettings.todos).length;
  if (remoteSettings ? json(mergedSettings) !== json(mergeSettings(remoteSettings, {})) : hasContent) await writeJson('settings.json', mergedSettings);

  // ---- 5. tombstones ----
  await local.setTombstones(del);
  if (json(del) !== json(remoteDel) && (Object.keys(del).length || byName.has('deleted.json'))) await writeJson('deleted.json', del);

  return res;
}
