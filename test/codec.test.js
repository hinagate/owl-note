import { describe, it, expect, beforeEach } from 'vitest';
import { encode, decode, selfTest, compressionAvailable, isEncryptedNote, ENCRYPT_WRITES, LOCKED_NOTE_BODY } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { activeKey, MissingKeyError, _resetCache } from '../src/lib/note-key.js';
import { base64urlToBytes } from '../src/lib/base64url.js';

// Byte-for-byte what a build released before encryption does with a payload:
// inflate, JSON.parse, done. Anything that makes THIS throw makes an older
// build treat the note as corrupt — and older builds hard-delete corrupt notes
// when a notebook is deleted, which is the whole reason for the envelope.
async function decodeAsOldBuild(payload) {
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter();
  w.write(base64urlToBytes(payload)).catch(() => {});
  w.close().catch(() => {});
  return JSON.parse(new TextDecoder().decode(await new Response(ds.readable).arrayBuffer()));
}

describe('codec', () => {
  // encode() now encrypts by default, so it needs a key — and therefore chrome.storage.
  beforeEach(() => { installFakeChrome(); _resetCache(); });

  it('CompressionStream is available in the test runtime', () => {
    expect(compressionAvailable()).toBe(true);
  });

  it('round-trips a note through a url-safe payload', async () => {
    const note = createNote({ body: '# Title\n```js\nconst x = 1;\n```\n中文 + emoji 🎯' });
    const payload = await encode(note);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    const back = await decode(payload);
    expect(back).toEqual(note);
  });

  it('selfTest returns true for a valid note', async () => {
    expect(await selfTest(createNote({ body: 'hello' }))).toBe(true);
  });

  it('decode rejects cleanly on an invalid payload without an unhandled rejection', async () => {
    await expect(decode('not-a-valid-payload')).rejects.toBeDefined();
  });

  it('round-trips a large note without deadlocking', async () => {
    // A real-sized note: decompressed output exceeds the stream's internal queue,
    // so awaiting writer.write/close before reading the readable would deadlock.
    const note = createNote({ body: 'Lorem ipsum dolor sit amet. '.repeat(2000) });
    const back = await decode(await encode(note));
    expect(back).toEqual(note);
  }, 4000);
});

describe('codec encryption', () => {
  beforeEach(() => { installFakeChrome(); _resetCache(); });

  it('encrypts every write', () => {
    expect(ENCRYPT_WRITES).toBe(true);
  });

  it('encrypts by default, with no options passed', async () => {
    const note = createNote({ body: 'hi' });
    const payload = await encode(note);
    expect(isEncryptedNote(await decodeAsOldBuild(payload))).toBe(true);
    expect(await decode(payload)).toEqual(note);
  });

  it('round-trips an encrypted note', async () => {
    const note = createNote({ body: '# Secret\n中文 + emoji 🎯\n```js\nconst x = 1;\n```' });
    expect(await decode(await encode(note, { encrypt: true }))).toEqual(note);
  });

  it('names the key that encrypted it', async () => {
    const { id } = await activeKey();
    const outer = await decodeAsOldBuild(await encode(createNote({ body: 'hi' }), { encrypt: true }));
    expect(outer._enc.startsWith(`${id}.`)).toBe(true);
  });

  // The safety contract with builds that are already installed and cannot be fixed.
  describe('as seen by a build released before encryption', () => {
    it('decodes without throwing, so no destructive path is triggered', async () => {
      const note = createNote({ title: 'Q3 plan', body: 'secret' });
      const outer = await decodeAsOldBuild(await encode(note, { encrypt: true }));
      expect(outer).toBeTypeOf('object');
      expect(outer.id).toBe(note.id);
      expect(outer.title).toBe('Q3 plan');
    });

    it('shows the update demand as the note body', async () => {
      const outer = await decodeAsOldBuild(await encode(createNote({ body: 'secret' }), { encrypt: true }));
      expect(outer.body).toBe(LOCKED_NOTE_BODY);
      expect(outer.body).toContain('2.3.24 or later');
      expect(outer.body).toContain('Do not edit, save, or delete this note');
    });

    it('still exposes attachment ids, so its Drive GC spares the files', async () => {
      const note = createNote({ body: 'x', attachments: [{ id: 'a1', driveFileId: 'KEEP1' }, { id: 'a2', driveFileId: 'KEEP2' }] });
      const outer = await decodeAsOldBuild(await encode(note, { encrypt: true }));
      expect(outer.attachments.map((a) => a.driveFileId)).toEqual(['KEEP1', 'KEEP2']);
    });

    it('never exposes the note body or any secret in it', async () => {
      const note = createNote({ title: 'AWS', body: 'sk-live-SUPERSECRET-42' });
      const outer = await decodeAsOldBuild(await encode(note, { encrypt: true }));
      expect(JSON.stringify(outer)).not.toContain('SUPERSECRET');
      expect(JSON.stringify(outer)).not.toContain('sk-live');
    });
  });

  it('leaks no plaintext into the bookmark URL', async () => {
    const payload = await encode(createNote({ title: 'AWS', body: 'sk-live-SUPERSECRET-42' }), { encrypt: true });
    expect(payload).not.toContain('SUPERSECRET');
    expect(payload).not.toContain('sk-live');
    expect(payload).not.toContain('AWS');
  });

  it('produces a different ciphertext each time (fresh IV per encrypt)', async () => {
    const note = createNote({ body: 'same bytes every time' });
    const a = await encode(note, { encrypt: true });
    const b = await encode(note, { encrypt: true });
    expect(a).not.toBe(b);
    expect(await decode(a)).toEqual(await decode(b));
  });

  it('still reads legacy payloads written before encryption existed', async () => {
    const note = createNote({ body: 'written by an older build' });
    const legacy = await encode(note, { encrypt: false });
    expect(await decode(legacy)).toEqual(note);
  });

  it('throws MissingKeyError — not a generic error — when the key has not synced yet', async () => {
    const payload = await encode(createNote({ body: 'from another device' }), { encrypt: true });
    installFakeChrome(); // a different machine: same bookmark, no key
    _resetCache();
    await expect(decode(payload)).rejects.toThrow(MissingKeyError);
  });

  it('rejects a truncated encrypted payload without hanging', async () => {
    const payload = await encode(createNote({ body: 'x' }), { encrypt: true });
    await expect(decode(payload.slice(0, payload.length - 8))).rejects.toBeDefined();
  });

  it('a tampered ciphertext fails authentication rather than decoding to garbage', async () => {
    const payload = await encode(createNote({ body: 'authentic' }), { encrypt: true });
    const flipped = `${payload.slice(0, -2)}${payload.slice(-2) === 'AA' ? 'BB' : 'AA'}`;
    await expect(decode(flipped)).rejects.toBeDefined(); // AES-GCM tag check
  });

  it('a real-sized note still fits well inside the 8 KB bookmark cap', async () => {
    // The envelope costs the notice text once per note; base64's 25% waste is
    // mostly recovered by deflating the envelope around it.
    const note = createNote({ body: 'Lorem ipsum dolor sit amet. '.repeat(100) });
    const sealed = new TextEncoder().encode(await encode(note, { encrypt: true })).length;
    expect(sealed).toBeLessThan(8192);
  });

  it('the envelope overhead is bounded and does not scale with note size', async () => {
    const cost = async (reps) => {
      const n = createNote({ body: 'Lorem ipsum dolor sit amet. '.repeat(reps) });
      return (await encode(n, { encrypt: true })).length - (await encode(n, { encrypt: false })).length;
    };
    const small = await cost(10);
    const large = await cost(200);
    expect(large).toBeLessThan(small + 200); // roughly constant, not proportional
  });

  it('selfTest passes on the encrypted path too', async () => {
    const note = createNote({ body: 'hello' });
    expect(await decode(await encode(note, { encrypt: true }))).toEqual(note);
    expect(await selfTest(note)).toBe(true);
  });
});
