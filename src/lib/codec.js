// src/lib/codec.js
import { bytesToBase64url, base64urlToBytes } from './base64url.js';
import { activeKey, keyById } from './note-key.js';

const IV_BYTES = 12; // AES-GCM standard nonce length

// Encryption is on for every write. Notes in bookmark URLs are readable by any
// extension holding the "bookmarks" permission, so the payload is ciphertext.
export const ENCRYPT_WRITES = true;

// THE ENVELOPE IS A LOAD-BEARING SAFETY DEVICE, not packaging.
//
// Extensions update per device, so the moment this build starts writing
// encrypted notes, some devices are still running an older one. The obvious
// format — a marker prefix the old decoder cannot parse — makes decode() THROW
// there, and older builds treat a throwing payload as a corrupt note: deleting
// a notebook skips such notes when moving them to Trash and then hard-deletes
// them with the folder, and Drive GC deletes their attachments. Those bugs are
// fixed here but cannot be fixed retroactively in a build already installed.
//
// So the ciphertext travels INSIDE an ordinary, fully valid note. An older
// build inflates it, parses it, finds a normal note object, and renders the
// upgrade notice as the body — no throw, no destructive path, attachments still
// enumerable so its GC spares the files. A current build sees `_enc` and
// decrypts the real note out of it.
//
// Cost is roughly the notice text per note. Base64 wastes 25% of each byte, and
// deflating the envelope wins most of that back, so the ciphertext itself is
// near break-even despite being encoded twice.
const ENC_FIELD = '_enc';

// Kept deliberately short. This text is carried by EVERY encrypted note, so each
// line spends part of the 8 KB bookmark budget for every note the user owns.
export const LOCKED_NOTE_BODY = [
  '# 🔒 Encrypted — update OWL-Note to read this note',
  '',
  'This version is too old to open it. The contents are intact.',
  '',
  '**Update OWL-Note to 2.3.24 or later, then reopen this note.**',
  'To force it now: `chrome://extensions` → Developer mode → Update.',
  '',
  '**Do not edit, save, or delete this note in this version — that destroys its contents.**',
].join('\n');

// Shown by a CURRENT build that understands the format but does not hold the key.
// Distinct from LOCKED_NOTE_BODY above, which tells an out-of-date build to update:
// telling someone to update when they are already current would send them chasing
// the wrong problem. The real causes are a key still in flight, or a note written
// by a different install — chrome.storage is per-extension, so an unpacked build
// and a Web Store build never share keys even on the same machine.
export const LOCKED_NO_KEY_BODY = [
  '# 🔒 This note is locked',
  '',
  'Its contents are encrypted and the key for it is not on this device.',
  '',
  '## If you have OWL-Note on another device',
  '',
  'The key usually arrives on its own within a minute. Close and reopen this note.',
  '',
  '## If it still says this',
  '',
  'Bring the key over from wherever this note opens normally:',
  '',
  '1. There: **Export ▾ → Recovery key (.json)**',
  '2. Here: **Import ▾ → Recovery key (.json)**, and choose that file',
  '',
  'The note then opens in place — nothing is copied or duplicated.',
  '',
  '---',
  '',
  '**Do not edit this note.** The real text is still here, encrypted — saving would',
  'overwrite it with this placeholder and it could not be recovered.',
].join('\n');

// True for a payload this build wrote encrypted. Takes the decoded object, not
// the string, because the marker lives inside the envelope by design.
export function isEncryptedNote(obj) {
  return !!obj && typeof obj[ENC_FIELD] === 'string';
}

export function compressionAvailable() {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

async function deflateRaw(str) {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(str));
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflateRaw(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  // Fire-and-forget: the Response below consumes ds.readable concurrently, so
  // write/close must NOT be awaited here — awaiting close() before the readable
  // is drained deadlocks under backpressure for any non-trivial payload. The
  // .catch keeps an invalid-input rejection from surfacing as an unhandled
  // rejection; the readable also errors, so the awaited Response still throws
  // to callers (who catch it).
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const buf = await new Response(ds.readable).arrayBuffer();
  return new TextDecoder().decode(buf);
}

// Compress FIRST, then encrypt. The order is not interchangeable: ciphertext is
// high-entropy by construction and does not compress, so encrypting first would
// forfeit the deflate ratio that keeps notes under MAX_URL_BYTES and push
// ordinary notes onto the Drive-offload path. Compress-then-encrypt leaks the
// compressed length (the CRIME/BREACH class), which needs a chosen-plaintext
// oracle to exploit; a bookmark reader gets one static snapshot per note, so
// the length alone discloses nothing useful.
export async function encode(note, { encrypt = ENCRYPT_WRITES, keyId = null } = {}) {
  const bytes = await deflateRaw(JSON.stringify(note));
  if (!encrypt) return bytesToBase64url(bytes);

  // Existing notes keep the key they were originally written with. This matters
  // when two OWL-Note installations share the bookmark tree but have distinct
  // extension storage: once an installation imports the other one's key, editing
  // that note must not rotate it back to its own key and lock the origin out again.
  const { id, key } = keyId
    ? { id: keyId, key: await keyById(keyId) }
    : await activeKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const joined = new Uint8Array(iv.length + ct.length);
  joined.set(iv, 0);
  joined.set(ct, iv.length);

  // The envelope must satisfy an older build's idea of a note. `id` keeps trash,
  // dedupe and citation lookups keying correctly there; `attachments` keeps its
  // Drive GC from deleting files this note still owns. The title is already
  // stored in the clear on the bookmark itself, so repeating it leaks nothing new.
  const envelope = {
    id: note.id,
    title: note.title,
    body: LOCKED_NOTE_BODY,
    attachments: (note.attachments || []).map((a) => ({ id: a.id, driveFileId: a.driveFileId })),
    created: note.created,
    updated: note.updated,
    version: note.version,
    [ENC_FIELD]: `${id}.${bytesToBase64url(joined)}`,
  };
  return bytesToBase64url(await deflateRaw(JSON.stringify(envelope)));
}

async function decodeOuter(payload) {
  return JSON.parse(await inflateRaw(base64urlToBytes(payload)));
}

// The note's id without decrypting it: the envelope keeps `id` in the clear for older
// builds, and a legacy plaintext payload is the note itself. Cheap enough to run over
// every bookmark, and it works for notes whose key this installation does not hold.
export async function noteIdOf(payload) {
  return (await decodeOuter(payload))?.id ?? null;
}

// Return the key id named by an encrypted payload without decrypting its note.
// Save paths use this to keep an existing bookmark on the same key. Legacy
// plaintext payloads return null and are upgraded with this installation's key.
export async function encryptionKeyId(payload) {
  const outer = await decodeOuter(payload);
  if (!isEncryptedNote(outer)) return null;
  const sealed = outer[ENC_FIELD];
  const sep = sealed.indexOf('.');
  if (sep <= 0) throw new Error('malformed encrypted note: no key id separator');
  return sealed.slice(0, sep);
}

export async function decode(payload) {
  const outer = await decodeOuter(payload);
  if (!isEncryptedNote(outer)) return outer; // written before encryption, or by an older build

  const sealed = outer[ENC_FIELD];
  const sep = sealed.indexOf('.');
  if (sep < 0) throw new Error('malformed encrypted note: no key id separator');
  const raw = base64urlToBytes(sealed.slice(sep + 1));
  // Throws MissingKeyError when this device has not received the key yet — a
  // transient state, NOT a corrupt note. Callers on destructive paths must tell
  // the two apart; see isMissingKeyError in note-key.js.
  //
  // The envelope rides along on the error. Without it a caller can only drop the
  // note, which is what made a keyless profile look like it had lost everything;
  // with it, the note can still be listed by its real title and opened locked.
  let key;
  try {
    key = await keyById(sealed.slice(0, sep));
  } catch (err) {
    if (err && err.name === 'MissingKeyError') err.envelope = { ...outer, body: LOCKED_NO_KEY_BODY };
    throw err;
  }
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: raw.subarray(0, IV_BYTES) },
    key,
    raw.subarray(IV_BYTES),
  );
  return JSON.parse(await inflateRaw(new Uint8Array(plain)));
}

export async function selfTest(note) {
  try {
    const back = await decode(await encode(note));
    return JSON.stringify(back) === JSON.stringify(note);
  } catch {
    return false;
  }
}
