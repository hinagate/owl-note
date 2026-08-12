import { describe, it, expect } from 'vitest';
import { renderEditor } from '../src/app/editor.js';

// The 8 KB figure is the bookmark-URL cap. It is a real ceiling only when Drive sync
// is off: with it on, saveNote offloads an over-cap note whole to Drive and it still
// syncs. Presenting "/ 8 KB" (and turning it red) in that state warns about a limit
// that does not apply.
async function badgeFor(measureResult) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  renderEditor(el, { title: 'note', body: 'body', measure: async () => measureResult });
  await new Promise((r) => setTimeout(r, 50));
  return el.querySelector('.preview-size');
}

const base = { warn: 6144, max: 8192 };

describe('the live size meter', () => {
  describe('a note stored entirely in its bookmark', () => {
    it('shows the size against the cap', async () => {
      const badge = await badgeFor({ ...base, bytes: 4096, usesDrive: false });
      expect(badge.textContent).toBe('4.0 / 8 KB');
      expect(badge.classList.contains('warn')).toBe(false);
      expect(badge.classList.contains('over')).toBe(false);
    });

    it('warns as the note nears the cap', async () => {
      const badge = await badgeFor({ ...base, bytes: 7000, usesDrive: false });
      expect(badge.textContent).toBe('6.8 / 8 KB');
      expect(badge.classList.contains('warn')).toBe(true);
    });

    it('flags a note that will not sync', async () => {
      const badge = await badgeFor({ ...base, bytes: 9000, usesDrive: false });
      expect(badge.classList.contains('over')).toBe(true);
      expect(badge.title).toContain("won't sync");
    });
  });

  // A note that keeps its body or its attachments in Drive has no meaningful bookmark
  // size: the parts that make it big are not in the bookmark. usesDrive is the same
  // condition as the note list's Drive chip, so the two always agree.
  describe('a note that uses Drive', () => {
    it('says so instead of showing a size', async () => {
      const badge = await badgeFor({ ...base, bytes: 4096, usesDrive: true });
      expect(badge.textContent).toBe('Syncs with Drive');
      expect(badge.textContent).not.toMatch(/\d/);
    });

    it('never warns, whatever the bookmark payload measures', async () => {
      for (const bytes of [4096, 7000, 9000]) {
        const badge = await badgeFor({ ...base, bytes, usesDrive: true });
        expect(badge.textContent).toBe('Syncs with Drive');
        expect(badge.classList.contains('warn')).toBe(false);
        expect(badge.classList.contains('over')).toBe(false);
      }
    });
  });

  it('falls back to the capped display when the measurer omits the flag', async () => {
    const badge = await badgeFor({ ...base, bytes: 9000 });
    expect(badge.textContent).toBe('8.8 / 8 KB');
    expect(badge.classList.contains('over')).toBe(true);
  });
});
