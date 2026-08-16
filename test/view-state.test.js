import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import { renderEditor } from '../src/app/editor.js';

const NL = String.fromCharCode(10);
const LONG = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join(NL);

const build = (opts = {}) => {
  const el = document.createElement('div');
  el.id = 'editor';
  document.body.appendChild(el);
  return renderEditor(el, { title: 'T', body: LONG, ...opts });
};

beforeEach(() => { installFakeChrome(); document.body.innerHTML = ''; });

// Leaving a note to check something else and coming back should not reset a long
// note to the top. The editor owns capture/restore; app.js owns where it is kept.
describe('editor view state', () => {
  it('reports scroll, caret and preview position', () => {
    const api = build();
    const state = api.getViewState();
    expect(state).toHaveProperty('top');
    expect(state).toHaveProperty('caret');
    expect(state).toHaveProperty('previewTop');
  });

  it('restores the caret', () => {
    const api = build();
    api.restoreViewState({ top: 0, caret: 42, previewTop: 0 });
    const ta = document.querySelector('textarea.note-body');
    expect(ta.selectionStart).toBe(42);
    expect(ta.selectionEnd).toBe(42);
  });

  it('round-trips a captured state', () => {
    const api = build();
    const ta = document.querySelector('textarea.note-body');
    ta.setSelectionRange(120, 120);
    const saved = api.getViewState();
    api.restoreViewState({ top: 0, caret: 0, previewTop: 0 });
    expect(ta.selectionStart).toBe(0);
    api.restoreViewState(saved);
    expect(ta.selectionStart).toBe(120);
  });

  // A note edited elsewhere can come back shorter than the offset we stored.
  it('clamps a caret that is now past the end of the note', () => {
    const api = build({ body: 'short' });
    api.restoreViewState({ caret: 99999 });
    const ta = document.querySelector('textarea.note-body');
    expect(ta.selectionStart).toBe('short'.length);
  });

  it('ignores a missing or partial state instead of throwing', () => {
    const api = build();
    expect(() => api.restoreViewState(null)).not.toThrow();
    expect(() => api.restoreViewState(undefined)).not.toThrow();
    expect(() => api.restoreViewState({})).not.toThrow();
    expect(() => api.restoreViewState({ caret: 'nonsense', top: null })).not.toThrow();
  });

  it('keeps the highlight backdrop aligned with the restored scroll', () => {
    const api = build();
    api.restoreViewState({ top: 0, caret: 0, previewTop: 0 });
    const ta = document.querySelector('textarea.note-body');
    const backdrop = document.querySelector('.note-body-highlights');
    expect(backdrop.scrollTop).toBe(ta.scrollTop);
  });
});
