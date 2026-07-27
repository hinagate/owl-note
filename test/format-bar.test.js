import { describe, it, expect, vi } from 'vitest';
import { renderFormatBar, formatActions } from '../src/app/format-bar.js';

function mount() {
  document.body.innerHTML = '<div id="fb"></div>';
  return document.getElementById('fb');
}

describe('format bar', () => {
  it('renders eleven type="button" buttons and a group divider, in order', () => {
    const c = mount();
    renderFormatBar(c, { apply: () => {} });
    const buttons = [...c.querySelectorAll('button.format-btn')];
    expect(buttons).toHaveLength(11);
    expect(buttons.every((b) => b.type === 'button')).toBe(true); // never submits
    expect(c.querySelector('.format-divider')).not.toBeNull();
    const kids = [...c.children];
    expect(kids.indexOf(c.querySelector('.format-divider')))
      .toBeGreaterThan(kids.indexOf(c.querySelector('.format-highlight'))); // divider splits inline | block
  });

  it('offers a table button whose action tabulates the selected lines', () => {
    const c = mount();
    renderFormatBar(c, { apply: () => {} });
    expect(c.querySelector('.format-table')).not.toBeNull();

    const table = formatActions().find((a) => a.id === 'table');
    const body = 'note\n![x](owl-img:abc)';
    const edit = table.run(body, 0, body.length);
    expect(edit.insert).toBe('| Step | Sketch |\n| --- | --- |\n| note | ![x](owl-img:abc) |');
  });

  it('fires apply(run) on mousedown and prevents the focus steal', () => {
    const c = mount();
    const apply = vi.fn();
    renderFormatBar(c, { apply });
    const ev = new MouseEvent('mousedown', { cancelable: true, bubbles: true });
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
});
