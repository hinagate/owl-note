import { describe, it, expect } from 'vitest';
import {
  startSession, appendCues, getSession, getSessionMeta, getSessionTail, stopSession,
  clearSession, isSilent, SILENCE_MS, BLOCK_SIZE,
} from '../src/lib/capture-session.js';

// Minimal stand-in for chrome.storage.local — the module takes it as a seam so
// session behavior can be specified without a browser.
function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(patch) { Object.assign(data, patch); },
    async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete data[k]); },
  };
}

const cue = (text, at = 0) => ({ text, videoTime: null, at });

describe('capture session', () => {
  it('starts empty and records what is being captured', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 7, url: 'https://x.test/v', title: 'Lecture', lang: 'en-US' }, s, 1000);
    const session = await getSession(s);
    expect(session).toMatchObject({ tabId: 7, state: 'recording', startedAt: 1000 });
    expect(session.cues).toEqual([]);
  });

  it('accumulates cues from either engine', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await appendCues([cue('one')], s, 100);
    await appendCues([cue('two'), cue('three')], s, 200);
    expect((await getSession(s)).cues.map((c) => c.text)).toEqual(['one', 'two', 'three']);
  });

  it('ignores cues that arrive after the session stopped', async () => {
    // An engine torn down mid-flight can still deliver one last batch; it must not
    // append to a finished transcript or restart a session.
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await stopSession(s, 500);
    expect(await appendCues([cue('late')], s, 600)).toBe(0);
    expect((await getSession(s)).cues).toEqual([]);
  });

  it('ignores cues when there is no session at all', async () => {
    const s = fakeStorage();
    expect(await appendCues([cue('orphan')], s, 10)).toBe(0);
  });

  it('treats a recording session that has heard nothing for 30 minutes as silent', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await appendCues([cue('last words')], s, 1000);
    const session = await getSession(s);
    expect(isSilent(session, 1000 + SILENCE_MS - 1)).toBe(false);
    expect(isSilent(session, 1000 + SILENCE_MS)).toBe(true);
  });

  it('does not call a stopped session silent', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    const stopped = await stopSession(s, 1000);
    expect(isSilent({ ...stopped, cues: [] }, 1000 + SILENCE_MS * 2)).toBe(false);
  });

  it('clears both the session and its cues', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await appendCues([cue('x')], s, 1);
    await clearSession(s);
    expect(await getSession(s)).toBe(null);
  });
});

describe('cue storage scales with session length', () => {
  const many = (n, from = 0) => Array.from({ length: n }, (_, i) => cue(`word${from + i}`, (from + i) * 10));

  it('keeps every cue in order across sealed blocks', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await appendCues(many(BLOCK_SIZE + 50), s, 1);
    const session = await getSession(s);
    expect(session.cues).toHaveLength(BLOCK_SIZE + 50);
    expect(session.cues[0].text).toBe('word0');
    expect(session.cues.at(-1).text).toBe(`word${BLOCK_SIZE + 49}`);
  });

  it('only ever rewrites the open block, so a long session does not get slower', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await appendCues(many(BLOCK_SIZE * 2 + 10), s, 1);
    // Sealed blocks are separate keys; the hot key holds only the remainder.
    expect(s.data['owl:capture:cues']).toHaveLength(10);
    expect(s.data['owl:capture:cues:0']).toHaveLength(BLOCK_SIZE);
    expect(s.data['owl:capture:cues:1']).toHaveLength(BLOCK_SIZE);
  });

  it('reports a running total without loading the transcript', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await appendCues(many(BLOCK_SIZE + 5), s, 1);
    expect((await getSessionMeta(s)).cueCount).toBe(BLOCK_SIZE + 5);
  });

  it('the live tail shows recent cues and admits there is more', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await appendCues(many(BLOCK_SIZE * 3), s, 1);
    const tail = await getSessionTail(s);
    expect(tail.cues.length).toBeLessThan(BLOCK_SIZE * 3);
    expect(tail.partial).toBe(true);
    expect(tail.cues.at(-1).text).toBe(`word${BLOCK_SIZE * 3 - 1}`);
  });

  it('a short session tail is the whole thing, with nothing hidden', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await appendCues(many(12), s, 1);
    const tail = await getSessionTail(s);
    expect(tail.cues).toHaveLength(12);
    expect(tail.partial).toBe(false);
  });

  it('clearing a session leaves no orphaned blocks behind', async () => {
    const s = fakeStorage();
    await startSession({ tabId: 1 }, s, 0);
    await appendCues(many(BLOCK_SIZE * 2), s, 1);
    await clearSession(s);
    expect(Object.keys(s.data).filter((k) => k.startsWith('owl:capture'))).toEqual([]);
  });
});
