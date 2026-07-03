// [Task E12] Tests for the pluggable ask quick-action registry (src/app/ask-actions.js).
// builtinAskActions() composes the built-in AskAction descriptors (Summarize, Tidy)
// with their host deps; the panel renders one chip-row button per descriptor. These
// tests pin the descriptor shapes and each run(ctx) contract in isolation from the DOM.
import { describe, it, expect, vi } from 'vitest';
import { builtinAskActions } from '../src/app/ask-actions.js';

describe('ask-actions — builtin quick-action registry (E12)', () => {
  it('returns the two built-in descriptors in order with stable ids/labels/ariaLabels', () => {
    const actions = builtinAskActions({ tidyNote: vi.fn() });
    expect(actions.map((a) => a.id)).toEqual(['summarize', 'tidy']);
    expect(actions.map((a) => a.label)).toEqual(['Summarize', 'Tidy']);
    const summarize = actions.find((a) => a.id === 'summarize');
    const tidy = actions.find((a) => a.id === 'tidy');
    expect(summarize.ariaLabel).toBe('Summarize this note');
    expect(tidy.ariaLabel).toBe('Tidy the note formatting');
    expect(typeof summarize.run).toBe('function');
    expect(typeof tidy.run).toBe('function');
  });

  it('summarize.run asks the fixed question pinned to the chip note (pinAll) via ctx.ask', () => {
    const summarize = builtinAskActions({ tidyNote: vi.fn() }).find((a) => a.id === 'summarize');
    const ask = vi.fn();
    summarize.run({ noteId: 'n9', ask });
    expect(ask).toHaveBeenCalledWith('Summarize this note.', { pinnedNoteId: 'n9', pinAll: true });
  });

  it('tidy.run calls the injected tidyNote with the chip note id and ignores ctx.ask', () => {
    const tidyNote = vi.fn();
    const tidy = builtinAskActions({ tidyNote }).find((a) => a.id === 'tidy');
    const ask = vi.fn();
    tidy.run({ noteId: 'n7', ask });
    expect(tidyNote).toHaveBeenCalledWith('n7');
    expect(ask).not.toHaveBeenCalled();
  });

  it('resolves noteId per call — the same descriptor asks about whatever note it is handed', () => {
    const summarize = builtinAskActions({ tidyNote: vi.fn() }).find((a) => a.id === 'summarize');
    const ask = vi.fn();
    summarize.run({ noteId: 'A', ask });
    summarize.run({ noteId: 'B', ask });
    expect(ask).toHaveBeenNthCalledWith(1, 'Summarize this note.', { pinnedNoteId: 'A', pinAll: true });
    expect(ask).toHaveBeenNthCalledWith(2, 'Summarize this note.', { pinnedNoteId: 'B', pinAll: true });
  });
});
