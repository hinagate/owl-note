// Session state for a transcription capture. The service worker owns it and
// chrome.storage.local is the source of truth, so the side panel is a pure view:
// closing the panel, switching tabs, or the worker being suspended never loses a
// session. Raw cues are stored and markdown is derived, which makes recovering an
// interrupted capture an exact replay rather than a reconstruction.
//
// Cues are stored in SEALED BLOCKS, not one growing array. Rewriting the whole
// array on every cue costs O(n) per cue — an hour-long lecture spends its last
// minutes serializing hundreds of KB every second, and every write wakes the
// panel to re-render all of it. Blocks bound a write to BLOCK_SIZE cues no
// matter how long the session runs.

export const SESSION_KEY = 'owl:capture';
export const CUES_KEY = 'owl:capture:cues';

// No cue and no speech for this long means the user walked away — finish the
// session rather than record silence over a closed laptop lid.
export const SILENCE_MS = 30 * 60 * 1000;

export const BLOCK_SIZE = 200;

const area = (storage) => storage || chrome.storage.local;
const blockKey = (i) => `${CUES_KEY}:${i}`;
const blockKeys = (count) => Array.from({ length: Math.max(0, count || 0) }, (_, i) => blockKey(i));

/** Session metadata only — no cues. Cheap enough to call on every render. */
export async function getSessionMeta(storage) {
  const got = await area(storage).get(SESSION_KEY);
  return got[SESSION_KEY] || null;
}

/** The whole session including every cue. Used when saving the note. */
export async function getSession(storage) {
  const store = area(storage);
  const got = await store.get([SESSION_KEY, CUES_KEY]);
  const session = got[SESSION_KEY];
  if (!session) return null;
  const keys = blockKeys(session.blocks);
  const sealed = keys.length ? await store.get(keys) : {};
  const cues = [...keys.flatMap((k) => sealed[k] || []), ...(got[CUES_KEY] || [])];
  return { ...session, cues };
}

/**
 * The most recent cues only. The live panel shows a moving window, so it must
 * not pay for the whole transcript on every repaint.
 */
export async function getSessionTail(storage) {
  const store = area(storage);
  const got = await store.get([SESSION_KEY, CUES_KEY]);
  const session = got[SESSION_KEY];
  if (!session) return null;
  const current = got[CUES_KEY] || [];
  // One sealed block behind the open one, so the view never looks empty right
  // after a block seals.
  const previousIndex = (session.blocks || 0) - 1;
  const previous = previousIndex >= 0 ? (await store.get(blockKey(previousIndex)))[blockKey(previousIndex)] || [] : [];
  return { ...session, cues: [...previous, ...current], partial: previousIndex > 0 };
}

export async function startSession({ tabId, windowId, url, title, lang }, storage, now = Date.now()) {
  await clearSession(storage);
  const session = {
    tabId,
    windowId,
    url: url || '',
    title: title || '',
    lang: lang || 'en-US',
    startedAt: now,
    lastCueAt: now,
    endedAt: 0,
    state: 'recording', // recording | paused | stopped
    blocks: 0,
    cueCount: 0,
    status: {},
  };
  await area(storage).set({ [SESSION_KEY]: session, [CUES_KEY]: [] });
  return session;
}

export async function patchSession(patch, storage) {
  const got = await area(storage).get(SESSION_KEY);
  const session = got[SESSION_KEY];
  if (!session) return null;
  const next = { ...session, ...patch, status: { ...session.status, ...(patch.status || {}) } };
  await area(storage).set({ [SESSION_KEY]: next });
  return next;
}

/**
 * Append cues from either engine. Returns the running cue total, or 0 when there
 * is no live session — a late message from a torn-down engine must not resurrect
 * one.
 */
export async function appendCues(cues, storage, now = Date.now()) {
  if (!Array.isArray(cues) || !cues.length) return 0;
  const store = area(storage);
  const got = await store.get([SESSION_KEY, CUES_KEY]);
  const session = got[SESSION_KEY];
  if (!session || session.state !== 'recording') return 0;

  let current = [...(got[CUES_KEY] || []), ...cues];
  let blocks = session.blocks || 0;
  const patch = {};
  while (current.length >= BLOCK_SIZE) {
    patch[blockKey(blocks)] = current.slice(0, BLOCK_SIZE);
    current = current.slice(BLOCK_SIZE);
    blocks += 1;
  }
  const cueCount = blocks * BLOCK_SIZE + current.length;
  patch[CUES_KEY] = current;
  patch[SESSION_KEY] = { ...session, lastCueAt: now, blocks, cueCount };
  await store.set(patch);
  return cueCount;
}

export async function stopSession(storage, now = Date.now()) {
  return patchSession({ state: 'stopped', endedAt: now }, storage);
}

export async function clearSession(storage) {
  const store = area(storage);
  const session = (await store.get(SESSION_KEY))[SESSION_KEY];
  await store.remove([SESSION_KEY, CUES_KEY, ...blockKeys(session?.blocks)]);
}

/** A recording session that has heard nothing for SILENCE_MS is finished, not live. */
export function isSilent(session, now = Date.now()) {
  if (!session || session.state !== 'recording') return false;
  return now - Number(session.lastCueAt || 0) >= SILENCE_MS;
}
