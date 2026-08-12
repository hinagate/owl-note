import { describe, it, expect } from 'vitest';
import { blockRanges, locateSelection, blockIndexOf, MIN_SELECTION_CHARS } from '../src/lib/source-map.js';
import { renderMarkdown } from '../src/lib/markdown.js';

// A table-heavy CJK note with <br> inside cells and repeated cell text — the shape
// that breaks naive matching, and the shape this feature is actually used on.
const NOTE = [
  '## Vowels 元音（17 個教學發音目標）',
  '',
  '> 近似音欄：普 = 普通話／注音，粵 = 粵語（粵拼）。',
  '',
  '### Full Monophthongs 完整單元音（10）',
  '| Symbol | Sounds like 近似音 | Mouth |',
  '| --- | --- | --- |',
  '| /i/ (iː) | 普「衣」拉長，嘴角更用力往兩邊<br>see eat need | 咧嘴 |',
  '| /ɛ/ (e) | 普「欸」；粵「些 se1」的元音<br>bed red said | 欸 |',
  '',
  '### Voiceless 清輔音（9）',
  '| Symbol | Sounds like 近似音 | Mouth |',
  '| --- | --- | --- |',
  '| /s/ | 注音ㄙ（絲）<br>see bus nice | 送氣流到下前牙 |',
  '| /h/ | 注音ㄏ（哈）但更輕<br>hi behind hope | |',
].join('\n');

const blockFor = (needle) => blockRanges(NOTE).find((r) => NOTE.slice(r.start, r.end).includes(needle));

describe('blockRanges', () => {
  it('gives exact offsets that slice their own source back out', () => {
    for (const r of blockRanges(NOTE)) expect(NOTE.slice(r.start, r.end).length).toBe(r.end - r.start);
    const first = blockRanges(NOTE)[0];
    expect(NOTE.slice(first.start, first.end)).toContain('## Vowels');
  });

  it('produces one range per rendered top-level element', () => {
    const host = document.createElement('div');
    host.innerHTML = renderMarkdown(NOTE);
    expect(host.children.length).toBe(blockRanges(NOTE).length);
  });

  it('treats each table as a single block', () => {
    expect(blockRanges(NOTE).filter((r) => r.type === 'table')).toHaveLength(2);
  });

  it('never throws on empty or malformed input', () => {
    expect(blockRanges('')).toEqual([]);
    expect(blockRanges(null)).toEqual([]);
    expect(Array.isArray(blockRanges('| ragged |\n| -- |\n| a | b |'))).toBe(true);
  });
});

describe('locateSelection — exact or nothing', () => {
  it('finds a CJK phrase inside a table cell', () => {
    const block = blockFor('普「衣」拉長');
    const spot = locateSelection(NOTE, block, '普「衣」拉長，嘴角更用力往兩邊');
    expect(NOTE.slice(spot.start, spot.end)).toBe('普「衣」拉長，嘴角更用力往兩邊');
  });

  it('finds English text inside a cell', () => {
    const block = blockFor('see eat need');
    const spot = locateSelection(NOTE, block, 'see eat need');
    expect(NOTE.slice(spot.start, spot.end)).toBe('see eat need');
  });

  // The selection crosses a <br>, which arrives as a newline but is markup in source.
  it('matches across a <br>, mapping back to the real offsets', () => {
    const block = blockFor('普「衣」拉長');
    const spot = locateSelection(NOTE, block, '嘴角更用力往兩邊\nsee eat need');
    expect(spot).not.toBeNull();
    const got = NOTE.slice(spot.start, spot.end);
    expect(got.startsWith('嘴角更用力往兩邊')).toBe(true);
    expect(got.endsWith('see eat need')).toBe(true);
    expect(got).toContain('<br>'); // the source span really does include the markup
  });

  // The block window is what keeps repeated text from matching the wrong row.
  it('does not stray outside the selected block', () => {
    const second = blockFor('注音ㄙ（絲）');
    const spot = locateSelection(NOTE, second, 'see bus nice');
    expect(spot.start).toBeGreaterThanOrEqual(second.start);
    expect(spot.end).toBeLessThanOrEqual(second.end);
    expect(NOTE.slice(spot.start, spot.end)).toBe('see bus nice');
  });

  it('resolves text that appears in BOTH tables to the one selected', () => {
    const first = blockFor('普「衣」拉長');
    const second = blockFor('注音ㄙ（絲）');
    const a = locateSelection(NOTE, first, 'Sounds like 近似音');
    const b = locateSelection(NOTE, second, 'Sounds like 近似音');
    expect(a.start).not.toBe(b.start);
    expect(a.start).toBeGreaterThanOrEqual(first.start);
    expect(b.start).toBeGreaterThanOrEqual(second.start);
  });

  it('refuses a selection too short to place', () => {
    const block = blockFor('普「衣」拉長');
    expect(locateSelection(NOTE, block, '普')).toBeNull();
    expect(locateSelection(NOTE, block, 'see')).toBeNull();
    expect(locateSelection(NOTE, block, ' ')).toBeNull();
    expect('普「衣」'.length).toBeGreaterThanOrEqual(MIN_SELECTION_CHARS);
  });

  // The point of the rewrite: no approximate answers.
  it('returns null rather than a near miss', () => {
    const block = blockFor('普「衣」拉長');
    expect(locateSelection(NOTE, block, 'text that is definitely not present')).toBeNull();
    expect(locateSelection(NOTE, block, '普「衣」拉長 EXTRA WORDS APPENDED')).toBeNull();
  });

  it('is safe with missing input', () => {
    expect(locateSelection(NOTE, null, 'Sounds like 近似音')).not.toBeNull(); // whole-note window
    expect(locateSelection('', blockFor('普'), 'anything')).toBeNull();
    expect(locateSelection(NOTE, blockFor('普「衣」拉長'), null)).toBeNull();
  });
});

describe('blockIndexOf', () => {
  const build = () => {
    const root = document.createElement('div');
    root.innerHTML = '<h2>T</h2><table><tbody><tr><td>cell</td></tr></tbody></table>';
    return root;
  };

  it('walks up from a deeply nested cell to its top-level block', () => {
    const root = build();
    expect(blockIndexOf(root, root.querySelector('td'))).toBe(1);
  });

  it('returns -1 for the root itself or a node outside it', () => {
    const root = build();
    expect(blockIndexOf(root, root)).toBe(-1);
    expect(blockIndexOf(root, document.createElement('p'))).toBe(-1);
  });
});
