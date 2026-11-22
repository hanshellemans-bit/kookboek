// Backups and per-recipe bundles. Both use plain zips in the same folder layout as `recipes/`:
//   recipes/<slug>/recipe.json + recipes/<slug>/images/*   (+ plan.json, settings.json, manifest.json in a full backup)
// so a backup can also be unpacked into the project folder or imported with the folder importer.
import * as db from './db.js';
import { zip, unzip } from './zip.js';
import { importOne } from './importer.js';
import { mergePlan, mergeSettings } from './syncCore.js';

const te = new TextEncoder(), td = new TextDecoder();
const jsonBytes = o => te.encode(JSON.stringify(o, null, 2) + '\n');
const bytesOf = async blob => new Uint8Array(await blob.arrayBuffer());
const baseName = f => f.split('/').pop();

export function slugify(text) {
  return (text || 'recept').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recept';
}

// ---------- single recipe bundle (used by Drive sync) ----------

/** recipe.json + images/<file>; `imageBlob(file)` returns the Blob of a recipe image (or undefined). */
export async function buildRecipeBundle(recipe, imageBlob) {
  const entries = [{ name: 'recipe.json', data: jsonBytes(recipe) }];
  for (const f of recipe.image ?? []) {
    const blob = await imageBlob(f);
    if (blob) entries.push({ name: `images/${baseName(f)}`, data: await bytesOf(blob) });
  }
  return zip(entries);
}

/** -> { recipe, images: Map('images/x.jpg' -> Blob) } */
export async function readRecipeBundle(bytes) {
  const files = await unzip(bytes);
  const rec = files.find(f => f.name === 'recipe.json');
  if (!rec) throw new Error('Bundel zonder recipe.json');
  const images = new Map(files.filter(f => f.name.startsWith('images/')).map(f => [f.name, new Blob([f.data], { type: 'image/jpeg' })]));
  return { recipe: JSON.parse(td.decode(rec.data)), images };
}

// ---------- full backup ----------

export async function exportBackup() {
  const recipes = await db.listRecipes();
  const used = new Set();
  const entries = [];
  for (const r of recipes) {
    let folder = slugify(r.name);
    if (used.has(folder)) folder += '-' + r.identifier.slice(0, 8);
    used.add(folder);
    entries.push({ name: `recipes/${folder}/recipe.json`, data: jsonBytes(r) });
    for (const f of r.image ?? []) {
      const blob = await db.getImage(db.imageKey(r.identifier, f));
      if (blob) entries.push({ name: `recipes/${folder}/images/${baseName(f)}`, data: await bytesOf(blob) });
    }
  }
  entries.push(
    { name: 'plan.json', data: jsonBytes(await db.listPlanRaw()) },
    { name: 'settings.json', data: jsonBytes(await db.getSyncSettings()) },
    { name: 'manifest.json', data: jsonBytes({ format: 'kookboek-backup', version: 1, exportedAt: new Date().toISOString(), recipes: recipes.length }) },
  );
  return zip(entries);
}

/** Merge a backup into the local data (newer dateModified wins; menu per day). */
export async function importBackup(bytes) {
  const files = await unzip(bytes);
  const byPath = new Map(files.map(f => [f.name, f.data]));
  const manifest = byPath.get('manifest.json') && JSON.parse(td.decode(byPath.get('manifest.json')));
  if (manifest && manifest.format !== 'kookboek-backup') throw new Error('Dit is geen Kookboek-back-up');

  const counts = { added: 0, updated: 0, skipped: 0, plan: 0 };
  for (const [path, data] of byPath) {
    if (!path.endsWith('/recipe.json')) continue;
    const dir = path.slice(0, -'recipe.json'.length);
    const recipe = JSON.parse(td.decode(data));
    counts[await importOne(recipe, async img => {
      const d = byPath.get(dir + 'images/' + baseName(img));
      return d ? new Blob([d], { type: 'image/jpeg' }) : null;
    })]++;
  }

  if (byPath.has('plan.json')) {
    const incoming = JSON.parse(td.decode(byPath.get('plan.json')));
    const local = await db.listPlanRaw();
    const merged = mergePlan(local, incoming);
    await db.putPlanRaw(merged);
    counts.plan = incoming.length;
  }
  if (byPath.has('settings.json')) {
    const incoming = JSON.parse(td.decode(byPath.get('settings.json')));
    await db.putSyncSettings(mergeSettings(await db.getSyncSettings(), incoming));
  }
  return counts;
}
