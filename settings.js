// ⚙ dialog: backup (zip download / share / restore) and Google Drive settings.
import * as db from './db.js';
import { h } from './util.js';
import { exportBackup, importBackup } from './backup.js';
import { getClientId } from './sync.js';
import { forgetToken } from './drive.js';

let modal = null;
export const closeSettings = () => { modal?.remove(); modal = null; };

function download(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** `onSync()` runs the Drive sync, `reload()` re-renders the current page. */
export async function openSettings({ onSync, reload, focusClientId = false }) {
  closeSettings();
  const status = h('p', { class: 'muted' });
  const say = text => { status.textContent = text; };
  const stamp = new Date().toISOString().slice(0, 10);

  const share = typeof navigator.canShare === 'function' && h('button', { class: 'btn', type: 'button', onclick: async () => {
    try {
      const file = new File([await exportBackup()], `kookboek-backup-${stamp}.zip`, { type: 'application/zip' });
      if (!navigator.canShare({ files: [file] })) return say('Delen van bestanden wordt hier niet ondersteund; gebruik "Downloaden".');
      await navigator.share({ files: [file], title: 'Kookboek back-up' });
    } catch (e) { if (e.name !== 'AbortError') say('Delen mislukt: ' + e.message); }
  } }, '📤 Delen / opslaan in Drive…');

  const clientInput = h('input', { placeholder: '123456789-abc….apps.googleusercontent.com', value: await db.getSetting('googleClientId', ''), autocomplete: 'off' });
  let syncNow;
  clientInput.addEventListener('input', () => { syncNow.disabled = !hasId && !clientInput.value.trim(); });
  const last = await db.getSetting('lastSync', null);
  const hasId = !!(await getClientId());

  modal = h('div', { class: 'backdrop', onclick: e => { if (e.target === modal) closeSettings(); } },
    h('div', { class: 'modal', style: 'max-width:640px' },
      h('div', { class: 'row between' }, h('h2', { style: 'margin:0' }, '⚙ Instellingen'),
        h('button', { class: 'btn small', type: 'button', onclick: closeSettings }, 'Sluiten')),

      h('h3', {}, '💾 Back-up'),
      h('p', { class: 'muted small-text' }, 'Eén zipbestand met alle recepten, foto\'s, je menu en overschotten.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          say('Back-up maken…');
          download(await exportBackup(), `kookboek-backup-${stamp}.zip`);
          say('✓ Back-up gedownload.');
        } }, '⬇ Downloaden'), share),
      h('label', { class: 'f' }, 'Back-up terugzetten (voegt samen; nieuwste versie wint)',
        h('input', { type: 'file', accept: '.zip,application/zip', onchange: async e => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            say('Terugzetten…');
            const c = await importBackup(new Uint8Array(await file.arrayBuffer()));
            say(`✓ ${c.added} toegevoegd, ${c.updated} bijgewerkt, ${c.skipped} ongewijzigd; ${c.plan} menu-items samengevoegd.`);
            reload();
          } catch (err) { say('Mislukt: ' + err.message); }
          e.target.value = '';
        } })),

      h('h3', {}, '☁ Google Drive'),
      h('p', { class: 'muted small-text' },
        'Synchroniseert met de map "Kookboek" op je Google Drive (alleen bestanden van deze app). ',
        'Je hebt eenmalig een eigen client-id nodig: zie docs/DRIVE-SETUP.md.'),
      h('label', { class: 'f' }, 'Google client-id (voor dit toestel)', clientInput),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          await db.setSetting('googleClientId', clientInput.value.trim());
          say('✓ Client-id opgeslagen.');
        } }, 'Opslaan'),
        syncNow = h('button', { class: 'btn primary', type: 'button', disabled: !hasId && !clientInput.value.trim(), onclick: async () => {
          await db.setSetting('googleClientId', clientInput.value.trim());
          closeSettings();
          onSync();
        } }, '☁ Nu synchroniseren'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          forgetToken();
          await db.setSetting('driveFolderId', null);
          say('✓ Losgekoppeld van Drive op dit toestel (je bestanden op Drive blijven staan).');
        } }, 'Ontkoppelen')),
      h('p', { class: 'muted small-text' }, last
        ? `Laatste sync: ${new Date(last.at).toLocaleString('nl-BE')} (↑${last.up} ↓${last.down} =${last.same})`
        : 'Nog niet gesynchroniseerd.'),
      status));
  document.body.append(modal);
  if (focusClientId) clientInput.focus();
}
