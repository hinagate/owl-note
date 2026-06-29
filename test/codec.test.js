import { describe, it, expect } from 'vitest';
import { encode, decode, selfTest, compressionAvailable } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';

describe('codec', () => {
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
