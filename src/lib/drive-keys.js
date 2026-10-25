// src/lib/drive-keys.js — a copy of the note keys in Google Drive, so that connecting
// Drive in a new or reinstalled browser brings every note back.
//
// Notes outlive their keys. The ciphertext is in bookmarks, which survive an uninstall
// and sync on their own; the keys are in extension storage, which an uninstall wipes —
// leaving notes nobody can open. With Drive connected, each key also lives in Drive's
// hidden app-data folder: readable by OWL-Note alone, not shown in Drive, not open to
// other Drive apps, not synced to disk by Drive for desktop. That is the trust already
// placed in Google by chrome.storage.sync, which carries these same keys between devices.
//
// One file per key, for the reason note-key.js gives one storage item per key: two
// devices backing up at once can only add files, never overwrite each other's. The key
// rides in the file's appProperties (private to this app), so one list reads them all.
import { exportKeyring, importKeyring } from './note-key.js';
import { listAppData, createAppData } from './drive/client.js';

const KIND = 'owl-note-key';

// Every key the Drive copy holds, `{ id: base64 }`.
export async function driveKeys() {
  const keys = {};
  for (const file of await listAppData(`appProperties has { key='owlKind' and value='${KIND}' }`)) {
    const { owlKeyId: id, owlKey: b64 } = file.appProperties || {};
    if (id && b64 && !keys[id]) keys[id] = b64;
  }
  return keys;
}

// A Drive connection made before key backup existed lacks its permission: Drive answers
// 403 with an insufficient-scope reason, unlike a 403 for a rate limit.
function lacksPermission(err) {
  return err?.status === 403 && /insufficient|scope/i.test(String(err.detail || ''));
}

// Restore every key Drive holds that this browser lacks, then back up every key this
// browser holds that Drive lacks. importKeyring never overwrites a key already here.
// Returns { restored, backedUp, needsAccess } — needsAccess when Drive is connected
// without the key-backup permission, which only connecting again can grant.
export async function syncKeysWithDrive() {
  let inDrive;
  try {
    inDrive = await driveKeys();
  } catch (err) {
    if (lacksPermission(err)) return { restored: 0, backedUp: 0, needsAccess: true };
    throw err;
  }
  const restored = await importKeyring({ keys: inDrive });
  const { keys: here } = await exportKeyring();
  let backedUp = 0;
  for (const [id, b64] of Object.entries(here)) {
    if (inDrive[id]) continue;
    await createAppData({ name: `owl-note-key-${id}`, appProperties: { owlKind: KIND, owlKeyId: id, owlKey: b64 } });
    backedUp += 1;
  }
  return { restored, backedUp, needsAccess: false };
}
