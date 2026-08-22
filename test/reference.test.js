// Tests for the Reference button, which replaced Quote in the format bar.
//
// Select what you are citing, press it, and a numbered marker goes in at the
// selection while a matching APA skeleton appears under a References heading at the
// foot of the note. Markers renumber in document order, Word-style, and each entry
// travels with its own marker — the property that stops a filled-in citation from
// silently attaching itself to the wrong sentence.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  insertReference, splitReferences, parseEntries, REFERENCE_TEMPLATE,
} from '../src/lib/reference.js';
import { renderMarkdown } from '../src/lib/markdown.js';
import { renderEditor } from '../src/app/editor.js';

const apply = (body, start, end) => {
  const edit = insertReference(body, start, end === undefined ? start : end);
  return body.slice(0, edit.replaceStart) + edit.insert + body.slice(edit.replaceEnd);
};
const FILLED = 'Vaswani, A. (2017). *Attention Is All You Need*. arXiv.';
const fill = (body, text) => body.replace(REFERENCE_TEMPLATE, text);
// Scoped to the References section: an unscoped search would match the INLINE
// marker first ("Alpha claim.[1] Beta claim.") and capture the prose after it.
const entryFor = (body, n) => {
  const refs = body.slice(body.indexOf('## References'));
  return (new RegExp(`^\\[${n}\\] (.*)$`, 'm').exec(refs) || [])[1];
};

describe('Reference button — inserting', () => {
  it('puts the marker at the end of the selection', () => {
    const out = apply('The Transformer changed things.', 0, 31);
    expect(out).toContain('The Transformer changed things.[1]');
  });

  it('puts the marker at the caret when nothing is selected', () => {
    const out = apply('Alpha claim. Beta claim.', 12, 12);
    expect(out).toContain('Alpha claim.[1] Beta claim.');
  });

  it('creates the References section with a fillable APA skeleton', () => {
    const out = apply('Claim.', 6, 6);
    expect(out).toContain('## References');
    expect(out).toContain(`[1] ${REFERENCE_TEMPLATE}`);
  });

  it('selects the skeleton so it can be typed straight over', () => {
    const body = 'Claim.';
    const edit = insertReference(body, 6, 6);
    expect(edit.insert.slice(edit.selStart, edit.selEnd)).toBe(REFERENCE_TEMPLATE);
  });

  it('adds to the existing section rather than starting a second one', () => {
    let out = apply('Alpha. Beta.', 6, 6);
    out = apply(out, out.indexOf('Beta.') + 5, out.indexOf('Beta.') + 5);
    expect(out.match(/## References/g)).toHaveLength(1);
    expect(out).toContain('[1] ');
    expect(out).toContain('[2] ');
  });

  it('works on an empty note', () => {
    const out = apply('', 0, 0);
    expect(out).toContain('[1]');
    expect(out).toContain('## References');
  });
});

describe('Reference button — Word-style renumbering', () => {
  it('renumbers markers in document order when one is inserted earlier', () => {
    let body = apply('Alpha claim. Beta claim.', 24, 24); // cite Beta -> [1]
    body = apply(body, 12, 12); // now cite Alpha, which comes first
    expect(body).toContain('Alpha claim.[1] Beta claim.[2]');
  });

  // The property that matters: a citation you already filled in must follow ITS
  // marker. If entries stayed put while markers renumbered, every earlier insert
  // would silently re-point finished citations at the wrong sentence.
  it('keeps a filled-in entry attached to its own marker', () => {
    let body = apply('Alpha claim. Beta claim.', 24, 24);
    body = fill(body, FILLED);
    expect(entryFor(body, 1)).toBe(FILLED);

    body = apply(body, 12, 12); // insert before it
    expect(entryFor(body, 2)).toBe(FILLED); // moved with its marker
    expect(entryFor(body, 1)).toBe(REFERENCE_TEMPLATE); // the new, empty one
  });

  it('keeps several filled entries in the right order', () => {
    let body = apply('One. Two. Three.', 4, 4);
    body = fill(body, 'FIRST');
    body = apply(body, body.indexOf('Three.') + 6, body.indexOf('Three.') + 6);
    body = fill(body, 'THIRD');
    body = apply(body, body.indexOf('Two.') + 4, body.indexOf('Two.') + 4);
    body = fill(body, 'SECOND');
    expect(entryFor(body, 1)).toBe('FIRST');
    expect(entryFor(body, 2)).toBe('SECOND');
    expect(entryFor(body, 3)).toBe('THIRD');
  });

  it('numbers a marker appended after all existing ones last', () => {
    let body = apply('Alpha. Beta.', 6, 6);
    body = apply(body, body.indexOf('Beta.') + 5, body.indexOf('Beta.') + 5);
    expect(body.indexOf('[1]')).toBeLessThan(body.indexOf('[2]'));
  });
});

describe('Reference button — markdown safety', () => {
  // `[1]: url` is a reference-LINK definition: written that way the marker becomes a
  // hyperlink and the entry vanishes from the note. Entries must never use a colon.
  it('never emits the [n]: form that markdown turns into a link definition', () => {
    const out = apply('Claim.', 6, 6);
    expect(out).not.toMatch(/^\[\d+\]:/m);
    const html = renderMarkdown(out);
    expect(html).toContain('[1]'); // still literal text, not swallowed into a link
  });

  it('leaves real markdown links alone', () => {
    const body = 'See [1](https://example.com) and more.';
    const out = apply(body, body.length, body.length);
    expect(out).toContain('[1](https://example.com)'); // untouched
    expect(out).toContain('## References');
  });

  // A `[1]` in a code sample is sample text, not a citation.
  it('does not renumber markers inside a fenced code block', () => {
    const body = 'Text.\n\n```\narr[1] = x;\narr[2] = y;\n```';
    const out = apply(body, 5, 5);
    expect(out).toContain('arr[1] = x;');
    expect(out).toContain('arr[2] = y;');
    expect(out).toContain('Text.[1]');
  });

  it('renders the reference list as readable text', () => {
    const html = renderMarkdown(apply('Claim.', 6, 6));
    expect(html).toContain('References');
    expect(html).toContain('Author, A. A.');
  });
});

describe('Reference button — malformed input', () => {
  it('normalises a reversed selection', () => {
    expect(apply('hello', 5, 0)).toContain('hello[1]');
  });

  it('clamps a selection past the end of the body', () => {
    expect(apply('hi', 99, 999)).toContain('hi[1]');
  });

  it('clamps a negative start', () => {
    expect(apply('hi', -5, 0)).toContain('[1]');
  });

  it('treats a caret inside the References section as citing the prose above', () => {
    const first = apply('Claim.', 6, 6);
    const out = apply(first, first.length - 2, first.length - 2);
    expect(out.match(/## References/g)).toHaveLength(1);
    expect(out).toContain('Claim.');
  });
});

describe('splitReferences / parseEntries', () => {
  it('finds an existing section and returns the prose before it', () => {
    const parsed = splitReferences('Body text.\n\n## References\n\n[1] Something.');
    expect(parsed.hasSection).toBe(true);
    expect(parsed.content.trim()).toBe('Body text.');
    expect(parsed.refsText).toContain('[1] Something.');
  });

  it('reports no section when the note has none', () => {
    const parsed = splitReferences('Just body text.');
    expect(parsed.hasSection).toBe(false);
    expect(parsed.content).toBe('Just body text.');
  });

  it('accepts any heading level for References', () => {
    expect(splitReferences('x\n\n# References\n\n[1] a').hasSection).toBe(true);
    expect(splitReferences('x\n\n#### References\n\n[1] a').hasSection).toBe(true);
  });

  it('reads entries that wrap onto a continuation line', () => {
    const entries = parseEntries('[1] Author, A. A. (2020). *Long title\nthat wrapped*. Source.');
    expect(entries.get(1)).toBe('Author, A. A. (2020). *Long title that wrapped*. Source.');
  });
});

describe('Reference button — wiring', () => {
  beforeEach(() => { document.body.innerHTML = '<main id="editor"></main>'; });

  const refButton = (el) => [...el.querySelectorAll('.format-bar button')]
    .find((b) => b.getAttribute('aria-label') === 'Reference (APA)');

  it('replaced Quote in the format bar', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'x', onChange: vi.fn() });
    expect(refButton(el)).toBeTruthy();
    const labels = [...el.querySelectorAll('.format-bar button')].map((b) => b.getAttribute('aria-label'));
    expect(labels).not.toContain('Quote');
  });

  const openForm = (el) => {
    refButton(el).click();
    return el.querySelector('.format-reference-popup');
  };
  const setField = (popup, index, value) => {
    const input = popup.querySelectorAll('.reference-field input')[index];
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('opens a form rather than inserting straight away', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'The claim.', onChange: vi.fn() });
    const ta = el.querySelector('textarea.note-body');
    const popup = el.querySelector('.format-reference-popup');
    expect(popup.hidden).toBe(true);
    expect(ta.value).toBe('The claim.'); // untouched until the form is submitted
    refButton(el).click();
    expect(popup.hidden).toBe(false);
    expect(popup.querySelectorAll('.reference-field input')).toHaveLength(5);
  });

  it('previews the APA line as the fields are typed', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'x', onChange: vi.fn() });
    const popup = openForm(el);
    setField(popup, 0, 'Vaswani, Ashish; Shazeer, Noam');
    setField(popup, 1, '2017');
    setField(popup, 2, 'Attention Is All You Need');
    setField(popup, 3, 'arXiv');
    const preview = popup.querySelector('.reference-preview').textContent;
    // The URL was left blank, so its placeholder stays visible rather than the line
    // silently collapsing.
    expect(preview).toBe('Vaswani, A., & Shazeer, N. (2017). Attention Is All You Need. *arXiv*. URL');
  });

  // The reported bug: typing an author and a year produced nothing, and pressing
  // Insert then discarded both. A partly-filled form must keep what was typed.
  it('previews a partly-filled form instead of throwing the input away', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'x', onChange: vi.fn() });
    const popup = openForm(el);
    setField(popup, 0, 'Vaswani, Ashish');
    setField(popup, 1, '2017');
    expect(popup.querySelector('.reference-preview').textContent)
      .toBe('Vaswani, A. (2017). Title. *Source*. URL');
    expect(popup.querySelector('.reference-insert').textContent).toBe('Insert');
  });

  it('inserts a partly-filled reference, keeping the typed fields', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'The claim.', onChange: vi.fn() });
    const ta = el.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 10);
    const popup = openForm(el);
    setField(popup, 0, 'Vaswani, Ashish');
    setField(popup, 1, '2017');
    popup.querySelector('.reference-insert').click();
    expect(ta.value).toContain('[1] Vaswani, A. (2017). Title. *Source*. URL');
    expect(ta.value).not.toContain('Author, A. A.');
  });

  // The selection must survive typing in the popup, or the marker lands in the
  // wrong place. A blurred textarea keeps selectionStart/End, which is what this pins.
  it('inserts the finished reference at the selection on submit', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'The claim.', onChange: vi.fn() });
    const ta = el.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 10);
    const popup = openForm(el);
    setField(popup, 0, 'Vaswani, Ashish');
    setField(popup, 1, '2017');
    setField(popup, 2, 'Attention Is All You Need');
    setField(popup, 3, 'arXiv');
    popup.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(ta.value).toContain('The claim.[1]');
    expect(ta.value).toContain('[1] Vaswani, A. (2017). Attention Is All You Need. *arXiv*.');
    expect(popup.hidden).toBe(true);
  });

  it('shows the skeleton itself when empty, so leaving it blank is discoverable', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'x', onChange: vi.fn() });
    const popup = openForm(el);
    expect(popup.querySelector('.reference-preview').textContent).toBe(REFERENCE_TEMPLATE);
    expect(popup.querySelector('.reference-insert').textContent).toBe('Insert blank');
    // ANY field counts as content, not just the title.
    setField(popup, 1, '2017');
    expect(popup.querySelector('.reference-insert').textContent).toBe('Insert');
  });

  it('falls back to the blank skeleton when the form is submitted empty', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'The claim.', onChange: vi.fn() });
    const ta = el.querySelector('textarea.note-body');
    ta.setSelectionRange(0, 10);
    const popup = openForm(el);
    popup.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(ta.value).toContain(`[1] ${REFERENCE_TEMPLATE}`);
  });

  it('cancel closes the form and changes nothing', () => {
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'The claim.', onChange: vi.fn() });
    const ta = el.querySelector('textarea.note-body');
    const popup = openForm(el);
    setField(popup, 2, 'Some title');
    popup.querySelector('.reference-cancel').click();
    expect(popup.hidden).toBe(true);
    expect(ta.value).toBe('The claim.');
  });

  it('reports the change so autosave runs', () => {
    const onChange = vi.fn();
    const el = document.getElementById('editor');
    renderEditor(el, { body: 'The claim.', onChange });
    el.querySelector('textarea.note-body').setSelectionRange(0, 10);
    const popup = openForm(el);
    setField(popup, 2, 'A title');
    popup.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('[1]') }));
  });
});
