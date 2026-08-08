import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderFormatBar, formatActions, HIGHLIGHT_COLORS, TEXT_COLORS } from '../src/app/format-bar.js';
import { setHighlight, setTextColor } from '../src/lib/format.js';

function mount() {
  document.body.innerHTML = '<div id="fb"></div>';
  return document.getElementById('fb');
}

let cleanup = null;
afterEach(() => { cleanup?.(); cleanup = null; });
function render(container, options) {
  cleanup = renderFormatBar(container, options);
}

const mousedown = () => new MouseEvent('mousedown', { cancelable: true, bubbles: true });

describe('format bar', () => {
  it('renders sixteen action buttons and a group divider, in order', () => {
    const c = mount();
    render(c, { apply: () => {} });
    const buttons = [...c.querySelectorAll('button.format-btn')];
    expect(buttons).toHaveLength(16);
    expect([...c.querySelectorAll('button')].every((b) => b.type === 'button')).toBe(true); // never submits
    expect(c.querySelector('.format-divider')).not.toBeNull();
    const kids = [...c.children];
    expect(kids.indexOf(c.querySelector('.format-divider')))
      .toBeGreaterThan(kids.indexOf(c.querySelector('.format-highlight'))); // divider splits inline | block
  });

  it('offers a table button whose action tabulates the selected lines', () => {
    const c = mount();
    render(c, { apply: () => {} });
    expect(c.querySelector('.format-table')).not.toBeNull();

    const table = formatActions().find((a) => a.id === 'table');
    const body = 'note\n![x](owl-img:abc)';
    const edit = table.run(body, 0, body.length);
    expect(edit.insert).toBe('| title 1 | title 2 |\n| --- | --- |\n| note | ![x](owl-img:abc) |');
  });

  it('fires apply(run) on mousedown and prevents the focus steal', () => {
    const c = mount();
    const apply = vi.fn();
    render(c, { apply });
    const ev = mousedown();
    const prevented = !c.querySelector('.format-bold').dispatchEvent(ev);
    expect(prevented).toBe(true); // preventDefault -> textarea keeps focus + selection
    expect(apply).toHaveBeenCalledTimes(1);
    expect(typeof apply.mock.calls[0][0]).toBe('function');
  });

  it('every action returns a well-formed edit object', () => {
    for (const a of formatActions()) {
      if (a.divider) continue;
      const edit = a.run('hello world', 0, 5);
      for (const k of ['replaceStart', 'replaceEnd', 'selStart', 'selEnd']) expect(typeof edit[k]).toBe('number');
      expect(typeof edit.insert).toBe('string');
    }
  });

  it('exposes shortcuts only for bold/italic/underline/link', () => {
    const withShortcut = formatActions().filter((a) => a.shortcut).map((a) => a.id);
    expect(withShortcut.sort()).toEqual(['bold', 'italic', 'link', 'underline']);
  });

  it('opens a highlighter palette and applies the picked color', () => {
    const c = mount();
    const apply = vi.fn();
    render(c, { apply });
    c.querySelector('.format-highlight-menu').click();
    const popup = c.querySelector('.format-highlight-popup');
    expect(popup.hidden).toBe(false);

    popup.querySelector('[data-color="green"]').click();
    expect(popup.hidden).toBe(true);
    const run = apply.mock.calls[0][0];
    expect(run('hello', 0, 5).insert).toBe('<mark class="highlight-green">hello</mark>');
    expect(c.querySelector('.format-highlight').title).toContain('Green');
  });

  it('opens a font-color palette and applies the picked color', () => {
    const c = mount();
    const apply = vi.fn();
    render(c, { apply });
    c.querySelector('.format-font-color-menu').click();
    const popup = c.querySelector('.format-font-color-popup');
    expect(popup.hidden).toBe(false);

    popup.querySelector('[data-color="blue"]').click();
    expect(popup.hidden).toBe(true);
    const run = apply.mock.calls[0][0];
    expect(run('hello', 0, 5).insert).toBe('<span class="text-color-blue">hello</span>');
    expect(c.querySelector('.format-font-color').title).toContain('Blue');
  });

  it('offers the five Word-style change-case choices', () => {
    const c = mount();
    const apply = vi.fn();
    render(c, { apply });
    c.querySelector('.format-case').click();
    const items = [...c.querySelectorAll('.format-case-popup .format-popup-item')];
    expect(items.map((item) => item.textContent)).toEqual([
      'Sentence case', 'lowercase', 'UPPERCASE', 'Capitalize Each Word', 'tOGGLE cASE',
    ]);
    items[2].click();
    expect(apply.mock.calls[0][0]('Owl', 0, 3).insert).toBe('OWL');
  });

  it('previews a dragged table size and inserts that exact grid', () => {
    const c = mount();
    const apply = vi.fn();
    render(c, { apply });
    c.querySelector('.format-table-menu').click();
    const start = c.querySelector('.table-size-cell[data-column="1"][data-row="1"]');
    const end = c.querySelector('.table-size-cell[data-column="5"][data-row="4"]');
    start.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    end.dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(c.querySelector('.table-grid-label').textContent).toBe('5 × 4 Table');
    expect(c.querySelectorAll('.table-size-cell.selected')).toHaveLength(20);
    document.dispatchEvent(new Event('pointerup', { bubbles: true }));

    expect(apply).toHaveBeenCalledTimes(1);
    const edit = apply.mock.calls[0][0]('', 0, 0);
    const lines = edit.insert.trimEnd().split('\n');
    expect(lines).toHaveLength(5); // header + delimiter + three body rows
    expect((lines[0].match(/title /g) || [])).toHaveLength(5);
  });

  it('offers one-click left, center and right alignment', () => {
    const c = mount();
    const apply = vi.fn();
    render(c, { apply });
    expect(c.querySelector('.format-align-left')).not.toBeNull();
    expect(c.querySelector('.format-align-center')).not.toBeNull();
    expect(c.querySelector('.format-align-right')).not.toBeNull();
    c.querySelector('.format-align-center').dispatchEvent(mousedown());
    const edit = apply.mock.calls[0][0]('hello', 0, 5);
    expect(edit.insert).toBe('<span class="text-align-center">hello</span>');
  });
});

// A swatch id lives in three places: the picker, the allow-list in format.js
// that keeps generated spans on the audited palette, and the stylesheet that
// gives the class a color. Drift in any one of them fails silently — the swatch
// still looks right in the menu but paints the fallback color, or nothing.
describe('palettes stay in sync across picker, allow-list and stylesheet', () => {
  const css = readFileSync('src/app/app.css', 'utf8');

  it('fills both grids evenly at four columns', () => {
    expect(HIGHLIGHT_COLORS).toHaveLength(8);
    expect(TEXT_COLORS).toHaveLength(8);
  });

  it('names the same hues in both palettes, bar the two that cannot cross over', () => {
    const highlightOnly = HIGHLIGHT_COLORS.map((c) => c.id).filter((id) => !TEXT_COLORS.some((t) => t.id === id));
    const textOnly = TEXT_COLORS.map((c) => c.id).filter((id) => !HIGHLIGHT_COLORS.some((h) => h.id === id));
    expect(highlightOnly).toEqual(['yellow', 'cyan']); // illegible as text
    expect(textOnly).toEqual(['red', 'teal']); // red is too strong behind text; 'teal' is the text name for 'cyan'
  });

  it('every highlight swatch survives the allow-list and has a rule', () => {
    for (const { id } of HIGHLIGHT_COLORS) {
      expect(setHighlight('x', 0, 1, id).insert).toContain(id === 'yellow' ? '<mark>' : `highlight-${id}`);
      expect(css).toContain(`.preview mark.highlight-${id}`);
    }
  });

  it('every font swatch survives the allow-list and has a rule', () => {
    for (const { id } of TEXT_COLORS) {
      expect(setTextColor('x', 0, 1, id).insert).toContain(`text-color-${id}`);
      expect(css).toContain(`.preview .text-color-${id}`);
    }
  });

  it('still renders the retired gold used by notes written before the revision', () => {
    expect(setTextColor('x', 0, 1, 'gold').insert).toContain('text-color-gold');
    expect(css).toContain('.preview .text-color-gold');
  });
});
