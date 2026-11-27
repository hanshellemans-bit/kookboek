// Google Drive access without a server: Google Identity Services (token flow) + Drive REST API v3.
// Scope drive.file = the app only sees files it created itself, in a folder "Kookboek" on your Drive.
// Needs an OAuth client id (see docs/DRIVE-SETUP.md).

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FIELDS = 'id,name,appProperties';

// ---------- sign-in ----------

let token = null;
let tokenExpires = 0;

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Google-aanmelding kon niet geladen worden (geen internet?)'));
    document.head.append(s);
  });
}

/** True when a still-valid token is in memory (so a sync needs no popup). */
export const hasValidToken = () => !!token && Date.now() < tokenExpires - 60_000;

/** Access token; asks Google (popup only when needed) when there is none or it is about to expire. */
export async function getToken(clientId, { force = false } = {}) {
  if (!force && token && Date.now() < tokenExpires - 60_000) return token;
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: r => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        token = r.access_token;
        tokenExpires = Date.now() + (r.expires_in ?? 3600) * 1000;
        resolve(token);
      },
      error_callback: e => reject(new Error(e.type === 'popup_closed' ? 'Aanmelden geannuleerd' : (e.message || e.type))),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function forgetToken() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {});
  token = null;
  tokenExpires = 0;
}

// ---------- Drive remote (interface used by syncCore) ----------

export function createDriveRemote({ getAccessToken, folderId = null, folderName = 'Kookboek', fetchImpl = (...a) => fetch(...a) }) {
  let folder = folderId;

  async function call(url, init = {}, retry = true) {
    const res = await fetchImpl(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await getAccessToken(!retry)}` } });
    if (res.status === 401 && retry) return call(url, init, false);        // expired token: get a fresh one once
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).error?.message ?? ''; } catch { /* no json */ }
      const err = new Error(`Google Drive: ${res.status} ${msg}`.trim());
      err.status = res.status;
      throw err;
    }
    return res;
  }

  async function findFolder() {
    const q = `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const res = await call(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=10`);
    return (await res.json()).files?.[0]?.id ?? null;
  }

  return {
    get folderId() { return folder; },

    /** Make sure the sync folder exists; returns its id. */
    async init() {
      if (folder) {
        try {
          const meta = await (await call(`${API}/files/${folder}?fields=id,trashed`)).json();
          if (!meta.trashed) return folder;
        } catch (e) { if (e.status !== 404) throw e; }
        folder = null;
      }
      folder = await findFolder();
      if (!folder) {
        const res = await call(`${API}/files?fields=id`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
        });
        folder = (await res.json()).id;
      }
      return folder;
    },

    async list() {
      const out = [];
      let pageToken = '';
      do {
        const q = `'${folder}' in parents and trashed=false`;
        const url = `${API}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(${FIELDS})&pageSize=1000` +
          (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
        const data = await (await call(url)).json();
        out.push(...(data.files ?? []));
        pageToken = data.nextPageToken ?? '';
      } while (pageToken);
      return out;
    },

    async download(id) {
      return new Uint8Array(await (await call(`${API}/files/${id}?alt=media`)).arrayBuffer());
    },

    /** Create (no existingId) or replace the content of a file; returns {id, name, appProperties}. */
    async upload({ name, data, existingId, appProperties = {}, mime = 'application/octet-stream' }) {
      const meta = existingId ? { appProperties } : { name, parents: [folder], appProperties };
      const boundary = 'kb' + crypto.randomUUID().replaceAll('-', '');
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`, data, `\r\n--${boundary}--`,
      ]);
      const url = existingId
        ? `${UPLOAD}/files/${existingId}?uploadType=multipart&fields=${FIELDS}`
        : `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`;
      const res = await call(url, {
        method: existingId ? 'PATCH' : 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body,
      });
      return res.json();
    },

    /** Moves the file to the Drive trash (recoverable). */
    async remove(id) {
      await call(`${API}/files/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
      });
    },
  };
}
