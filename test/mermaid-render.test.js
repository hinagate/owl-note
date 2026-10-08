import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.js';
import { decorateMermaid, renderMermaid, loadMermaid, diagramImageUrl, _setMermaidImporter, MERMAID_ENTRY, EDIT_PAUSE_MS } from '../src/lib/mermaid-render.js';
import { annotateRuby } from '../src/lib/ruby-annotate.js';
import { installFakeChrome } from './helpers/fake-chrome.js';

// The real Mermaid needs a browser to measure text, so these tests swap in a fake with
// the same API: initialize(config) and render(id, text) -> { svg }.
function fakeMermaid({ fail = null, delay = 0 } = {}) {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const api = {
    initialize: vi.fn(),
    render: vi.fn(async (id, text) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(text);
      if (delay) await new Promise((r) => setTimeout(r, delay));
      active -= 1;
      if (fail && text.includes(fail)) throw new Error('Parse error on line 2');
      const label = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
      return { svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 400 200" style="max-width: 400px;"><style>#${id} .node{fill:#eee}</style><defs><marker id="${id}-arrow"><path d="M0,0 L10,5"></path></marker></defs><g class="node"><text>${label}</text></g><path marker-end="url(#${id}-arrow)" d="M0,0 L1,1"></path></svg>` };
    }),
    calls,
    maxActive: () => maxActive,
  };
  return api;
}

let fake;
beforeEach(() => {
  installFakeChrome();
  document.body.innerHTML = '';
  fake = fakeMermaid();
  _setMermaidImporter(async () => ({ default: fake }));
});
afterEach(() => _setMermaidImporter(null));

// A drawing as the preview held it before a rebuild.
const drawing = (text) => {
  const holder = document.createElement('div');
  holder.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>${text}</text></svg>`;
  return holder.firstElementChild;
};
const fence = (src) => '```mermaid\n' + src + '\n```';
const host = (markdown) => {
  const el = document.createElement('div');
  el.innerHTML = renderMarkdown(markdown);
  document.body.append(el);
  return el;
};

describe('Mermaid diagrams in rendered Markdown', () => {
  it('replaces a mermaid code block with its diagram, in the same place', async () => {
    const el = host(`# Title\n\n${fence('flowchart TB\n  A --> B')}\n\nAfter`);
    const before = el.children.length;
    await decorateMermaid(el);
    expect(el.children.length).toBe(before); // one element per Markdown block, still
    const box = el.children[1];
    expect(box.className).toBe('mermaid-diagram');
    expect(box.querySelector('svg')).toBeTruthy();
    expect(el.querySelector('pre')).toBeNull();
    expect(fake.render).toHaveBeenCalledWith(expect.stringMatching(/^owl-mermaid-\d+$/), 'flowchart TB\n  A --> B\n');
  });

  it('loads the vendored module from inside the extension, once, with safe settings', async () => {
    const importer = vi.fn(async () => ({ default: fake }));
    _setMermaidImporter(importer);
    await decorateMermaid(host(`${fence('graph LR\n a-->b')}\n\n${fence('graph LR\n c-->d')}`));
    expect(importer).toHaveBeenCalledTimes(1);
    expect(importer).toHaveBeenCalledWith(chrome.runtime.getURL(MERMAID_ENTRY));
    expect(fake.initialize).toHaveBeenCalledTimes(1);
    expect(fake.initialize.mock.calls[0][0]).toMatchObject({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true });
  });

  it('leaves notes without a diagram alone and never loads Mermaid for them', async () => {
    const importer = vi.fn(async () => ({ default: fake }));
    _setMermaidImporter(importer);
    const el = host('```js\nlet x = 1;\n```');
    await decorateMermaid(el);
    expect(el.querySelector('pre code.language-js')).toBeTruthy();
    expect(importer).not.toHaveBeenCalled();
  });

  it('shows a diagram it has drawn before at once, without rendering it again', async () => {
    await decorateMermaid(host(fence('graph TD\n x-->y')));
    expect(fake.render).toHaveBeenCalledTimes(1);
    // The preview is rebuilt on every keystroke.
    const again = host(fence('graph TD\n x-->y'));
    const painting = decorateMermaid(again);
    expect(again.querySelector('.mermaid-diagram svg')).toBeTruthy(); // synchronously
    await painting;
    expect(fake.render).toHaveBeenCalledTimes(1);
  });

  it('shows a placeholder until a new diagram is ready', async () => {
    fake = fakeMermaid({ delay: 20 });
    _setMermaidImporter(async () => ({ default: fake }));
    const el = host(fence('graph TD\n slow-->done'));
    const painting = decorateMermaid(el);
    expect(el.querySelector('.mermaid-diagram.mermaid-pending').textContent).toBe('Rendering diagram…');
    await painting;
    expect(el.querySelector('.mermaid-pending')).toBeNull();
    expect(el.querySelector('svg')).toBeTruthy();
  });

  it('renders one diagram at a time, and the same text only once', async () => {
    fake = fakeMermaid({ delay: 5 });
    _setMermaidImporter(async () => ({ default: fake }));
    const el = host([fence('graph LR\n a-->b'), fence('graph LR\n c-->d'), fence('graph LR\n a-->b')].join('\n\n'));
    await decorateMermaid(el);
    expect(fake.maxActive()).toBe(1);
    expect(fake.calls).toHaveLength(2);
    expect(el.querySelectorAll('.mermaid-diagram svg')).toHaveLength(3);
  });

  it('shows a broken diagram as its source with the error, never as markup', async () => {
    fake = fakeMermaid({ fail: 'oops' });
    _setMermaidImporter(async () => ({ default: fake }));
    const source = 'graph TD\n oops <img src=x onerror=alert(1)>';
    const el = host(fence(source));
    await decorateMermaid(el);
    const box = el.querySelector('.mermaid-diagram.mermaid-error');
    expect(box.querySelector('.mermaid-error-message').textContent).toBe('Diagram error: Parse error on line 2');
    expect(box.querySelector('pre').textContent).toBe(`${source}\n`);
    expect(el.querySelector('img')).toBeNull();
  });

  it('removes anything executable from the SVG it is given', async () => {
    fake.render = vi.fn(async (id) => ({
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)"><text>x</text></a><foreignObject><div onclick="alert(4)">y</div></foreignObject><style>.n{fill:red}</style><path marker-end="url(#m)" d="M0 0"/></svg>`,
    }));
    const el = host(fence('graph TD\n a'));
    await decorateMermaid(el);
    const html = el.querySelector('.mermaid-diagram').innerHTML;
    expect(html).not.toMatch(/onload|<script|javascript:|onclick|foreignObject/i);
    expect(html).toContain('<style>'); // Mermaid's own scoped styles survive
    expect(html).toContain('marker-end'); // and so do arrowheads
  });

  it('says so, and stops trying, when the renderer itself could not load', async () => {
    // Chrome answers every later import of a module that failed to load with the same
    // failure, so trying again on each keystroke would only flash the error again.
    const importer = vi.fn(async () => { throw new Error('net::ERR_FILE_NOT_FOUND'); });
    _setMermaidImporter(importer);
    const first = host(fence('graph TD\n retry'));
    await decorateMermaid(first);
    expect(first.querySelector('.mermaid-error-message').textContent).toMatch(/could not load\. Reopen OWL-Note/);
    const second = host(fence('graph TD\n other'));
    decorateMermaid(second);
    expect(second.querySelector('.mermaid-error-message').textContent).toMatch(/could not load/); // at once
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it('cleans up the scratch element Mermaid can leave behind on failure', async () => {
    fake.render = vi.fn(async (id) => {
      const scratch = document.createElement('div');
      scratch.id = `d${id}`;
      document.body.append(scratch);
      throw new Error('bad');
    });
    await decorateMermaid(host(fence('graph TD\n z')));
    expect(document.querySelector('[id^="downl-mermaid"], [id^="dowl-mermaid"]')).toBeNull();
  });

  it('keeps the same result for every caller asking for the same text', async () => {
    const [a, b] = await Promise.all([renderMermaid('graph LR\n q-->r'), renderMermaid('graph LR\n q-->r')]);
    expect(a).toBe(b);
    expect(fake.render).toHaveBeenCalledTimes(1);
    await expect(loadMermaid()).resolves.toBe(fake);
  });
});

describe('phonetic readings stay out of diagrams', () => {
  it('does not annotate text inside a diagram', async () => {
    const el = host(`漢字\n\n${fence('graph TD\n 漢字')}`);
    await decorateMermaid(el);
    const segment = (text) => [{ text, reading: 'かんじ' }];
    annotateRuby(el, segment);
    expect(el.querySelector('p ruby')).toBeTruthy();
    expect(el.querySelector('.mermaid-diagram ruby')).toBeNull();
  });
});

describe('the editor preview', () => {
  it('draws the diagrams in a note\'s preview', async () => {
    const { renderEditor } = await import('../src/app/editor.js');
    document.body.innerHTML = '<div id="root"></div>';
    const editor = renderEditor(document.getElementById('root'), {
      body: '# Plan\n\n```mermaid\nflowchart TB\n  O["任務起點 origin"] -->|"spawns"| G["目標 goal"]\n```\n\nDone.',
    });
    await vi.waitFor(() => expect(document.querySelector('.preview-body .mermaid-diagram svg')).toBeTruthy());
    expect(fake.render).toHaveBeenCalledWith(expect.any(String), 'flowchart TB\n  O["任務起點 origin"] -->|"spawns"| G["目標 goal"]\n');
    // The click-to-source mapping counts one preview element per Markdown block.
    expect(document.querySelector('.preview-body').children).toHaveLength(3);
    editor.destroy();
  });
});

describe('enlarging a diagram like a photo', () => {
  const svgFrom = (markup) => {
    const host = document.createElement('div');
    host.innerHTML = markup;
    return host.firstElementChild;
  };
  const decoded = (url) => decodeURIComponent(url.slice(url.indexOf(',') + 1));

  it('makes a standalone image sized to fill the space it is given', () => {
    const svg = svgFrom('<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 400 200" style="max-width: 400px;"><text>x</text></svg>');
    const url = diagramImageUrl(svg, 1000, 900);
    expect(url).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    const out = svgFrom(decoded(url));
    expect(out.getAttribute('width')).toBe('1000'); // 400 wide, scaled to fit 1000
    expect(out.getAttribute('height')).toBe('500');
    expect(out.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    expect(out.getAttribute('style') || '').not.toContain('max-width');
    expect(svg.getAttribute('width')).toBe('100%'); // the preview's own diagram is untouched
  });

  it('shrinks a diagram larger than the window, and never blows a small one up more than 3x', () => {
    const big = svgFrom('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 3000 1000"></svg>');
    expect(svgFrom(decoded(diagramImageUrl(big, 1500, 900))).getAttribute('width')).toBe('1500');
    const tiny = svgFrom('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"></svg>');
    expect(svgFrom(decoded(diagramImageUrl(tiny, 1500, 900))).getAttribute('width')).toBe('300');
  });

  it('gives up rather than produce an image of no size', () => {
    expect(diagramImageUrl(svgFrom('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 1000, 800)).toBeNull();
  });

  async function openEditorWithDiagram() {
    const { renderEditor } = await import('../src/app/editor.js');
    document.body.innerHTML = '<div id="root"></div>';
    const editor = renderEditor(document.getElementById('root'), {
      body: '```mermaid\nflowchart LR\n  A --> B\n```\n\n![photo](data:image/png;base64,iVBORw0KGgo=)',
    });
    await vi.waitFor(() => expect(document.querySelector('.preview-body .mermaid-diagram svg')).toBeTruthy());
    return editor;
  }

  it('marks a drawn diagram as something to click, as photos are', async () => {
    const editor = await openEditorWithDiagram();
    const box = document.querySelector('.preview-body .mermaid-diagram');
    expect(box.getAttribute('role')).toBe('button');
    expect(box.tabIndex).toBe(0);
    expect(box.getAttribute('aria-label')).toBe('Enlarge diagram');
    editor.destroy();
  });

  it('opens the diagram in the photo viewer when clicked, on a white page', async () => {
    const editor = await openEditorWithDiagram();
    document.querySelector('.preview-body .mermaid-diagram svg text, .preview-body .mermaid-diagram svg')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    const lightbox = document.querySelector('.image-lightbox');
    const image = lightbox.querySelector('.image-lightbox-image');
    expect(lightbox.hidden).toBe(false);
    expect(image.src).toMatch(/^data:image\/svg\+xml/);
    expect(image.classList.contains('diagram')).toBe(true);
    expect(lightbox.getAttribute('aria-label')).toBe('Enlarged diagram');

    // Closing and opening a photo afterwards shows the photo normally.
    lightbox.querySelector('.image-lightbox-close').click();
    expect(lightbox.hidden).toBe(true);
    document.querySelector('.preview-body img').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(image.src).toMatch(/^data:image\/png/);
    expect(image.classList.contains('diagram')).toBe(false);
    editor.destroy();
  });

  it('opens from the keyboard too', async () => {
    const editor = await openEditorWithDiagram();
    const box = document.querySelector('.preview-body .mermaid-diagram');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(document.querySelector('.image-lightbox').hidden).toBe(false);
    editor.destroy();
  });

  it('does not open when the click ends a text selection over the diagram', async () => {
    const editor = await openEditorWithDiagram();
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false, rangeCount: 0 });
    document.querySelector('.preview-body .mermaid-diagram')
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.image-lightbox').hidden).toBe(true);
    selection.mockRestore();
    editor.destroy();
  });

  it('leaves diagrams in a PDF as plain figures', async () => {
    const el = host(fence('graph TD\n a-->b'));
    await decorateMermaid(el);
    expect(el.querySelector('.mermaid-diagram').hasAttribute('role')).toBe(false);
  });
});

describe('fixes from the first real-Chrome round', () => {
  it('locks htmlLabels against a diagram\'s own init or frontmatter, keeping Mermaid\'s defaults', async () => {
    await decorateMermaid(host(fence('graph TD\n a')));
    const { secure } = fake.initialize.mock.calls[0][0];
    expect(secure).toEqual(expect.arrayContaining(['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels']));
  });

  it('keeps the diagram\'s accessible role through the sanitizer', async () => {
    fake.render = vi.fn(async (id) => ({ svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" role="graphics-document document" viewBox="0 0 10 10"></svg>` }));
    const el = host(fence('graph TD\n a'));
    await decorateMermaid(el);
    expect(el.querySelector('svg').getAttribute('role')).toBe('graphics-document document');
  });

  it('keeps the last drawing on screen while an edited diagram redraws, instead of a placeholder', async () => {
    fake = fakeMermaid({ delay: 20 });
    _setMermaidImporter(async () => ({ default: fake }));
    const previous = [drawing('old drawing')];
    const el = host(fence('graph TD\n a-->b2'));
    const painting = decorateMermaid(el, { previous });
    const box = el.querySelector('.mermaid-diagram');
    expect(box.classList.contains('mermaid-stale')).toBe(true);
    expect(box.textContent).toContain('old drawing');
    expect(box.textContent).not.toContain('Rendering diagram');
    await painting;
    expect(box.classList.contains('mermaid-stale')).toBe(false);
    expect(box.textContent).toContain('b2');
  });

  it('keeps the last good drawing, faded, with the error above it while the diagram is mid-edit', async () => {
    fake = fakeMermaid({ fail: 'half' });
    _setMermaidImporter(async () => ({ default: fake }));
    const previous = [drawing('last good')];
    const el = host(fence('graph TD\n half -->'));
    await decorateMermaid(el, { previous });
    const box = el.querySelector('.mermaid-diagram');
    expect(box.classList.contains('mermaid-stale')).toBe(true);
    expect(box.querySelector('.mermaid-error-message').textContent).toMatch(/^Diagram error:/);
    expect(box.querySelector('svg').textContent).toBe('last good');
    expect(box.querySelector('pre')).toBeNull(); // no tall block of source pushing the note down
    expect(box.hasAttribute('role')).toBe(false); // an outdated drawing is not offered for enlarging
  });

  it('does not borrow another diagram\'s drawing when one was added or removed', async () => {
    fake = fakeMermaid({ delay: 10 });
    _setMermaidImporter(async () => ({ default: fake }));
    const el = host([fence('graph TD\n new1'), fence('graph TD\n new2')].join('\n\n'));
    const painting = decorateMermaid(el, { previous: [drawing('only one before')] });
    expect(el.textContent).not.toContain('only one before');
    await painting;
  });

  it('passes each diagram its drawing from the last preview rebuild, in the editor', async () => {
    const { renderEditor } = await import('../src/app/editor.js');
    document.body.innerHTML = '<div id="root"></div>';
    const editor = renderEditor(document.getElementById('root'), { body: '```mermaid\ngraph TD\n first\n```' });
    await vi.waitFor(() => expect(document.querySelector('.preview-body .mermaid-diagram svg')).toBeTruthy());
    fake.render.mockImplementation(() => new Promise(() => {})); // the next drawing never arrives
    const ta = document.querySelector('textarea.note-body');
    ta.value = '```mermaid\ngraph TD\n first edited\n```';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const box = document.querySelector('.preview-body .mermaid-diagram');
    expect(box.classList.contains('mermaid-stale')).toBe(true);
    expect(box.querySelector('svg')).toBeTruthy();
    editor.destroy();
  });
});

describe('a diagram that never finishes drawing', () => {
  it('gives up on it after the deadline, and draws the ones after it once Mermaid lets go', async () => {
    // Mermaid queues its own renders, so while one hangs every later one would wait
    // behind it and time out too. They are held back instead, then drawn.
    let release;
    const stuck = fakeMermaid();
    stuck.render = vi.fn(async (id, text) => (text.includes('hang')
      ? new Promise((resolve) => { release = () => resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }); }) // an image whose host does not answer
      : { svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 10 10"><text>${text.trim()}</text></svg>` }));
    _setMermaidImporter(async () => ({ default: stuck }), { timeoutMs: 30 });
    const el = host([fence('graph TD\n hang'), fence('graph TD\n after')].join('\n\n'));
    await decorateMermaid(el, { live: true });
    const [first, second] = el.querySelectorAll('.mermaid-diagram');
    expect(first.querySelector('.mermaid-error-message').textContent).toMatch(/took too long to draw/);
    expect(second.classList.contains('mermaid-pending')).toBe(true);
    expect(second.textContent).toMatch(/Diagrams are paused/);
    expect(stuck.render).toHaveBeenCalledTimes(1); // nothing was started behind the stuck one

    release();
    await vi.waitFor(() => expect(second.querySelector('svg')?.textContent).toContain('after'));
    expect(second.classList.contains('mermaid-pending')).toBe(false);
    expect(first.querySelector('.mermaid-error-message').textContent).toMatch(/took too long to draw/); // not tried again
    expect(stuck.render).toHaveBeenCalledTimes(2);
  });

  it('leaves a PDF as it was captured when the stuck render lets go', async () => {
    // The PDF host is measured once and then photographed slab by slab; a diagram drawn
    // into it mid-capture would shift everything after it.
    let release;
    const stuck = fakeMermaid();
    stuck.render = vi.fn(async (id, text) => (text.includes('hang')
      ? new Promise((resolve) => { release = () => resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }); })
      : { svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 10 10"><text>${text.trim()}</text></svg>` }));
    _setMermaidImporter(async () => ({ default: stuck }), { timeoutMs: 30 });
    await decorateMermaid(host(fence('graph TD\n hang')), { live: true });
    const pdf = host(fence('graph TD\n report')); // attached to the page, as note-pdf.js does
    await decorateMermaid(pdf);
    expect(pdf.textContent).toMatch(/Diagrams are paused/);
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(pdf.querySelector('svg')).toBeNull();
    expect(pdf.textContent).toMatch(/Diagrams are paused/);
  });

  it('is not retried on every keystroke once it has timed out', async () => {
    const stuck = fakeMermaid();
    stuck.render = vi.fn(() => new Promise(() => {}));
    _setMermaidImporter(async () => ({ default: stuck }), { timeoutMs: 20 });
    await decorateMermaid(host(fence('graph TD\n hang')));
    await decorateMermaid(host(fence('graph TD\n hang')));
    expect(stuck.render).toHaveBeenCalledTimes(1);
  });
});

describe('the render cache', () => {
  it('keeps the 64 most recently used diagrams and forgets older ones', async () => {
    for (let i = 0; i < 65; i += 1) await renderMermaid(`graph TD\n n${i}`);
    expect(fake.render).toHaveBeenCalledTimes(65);
    await renderMermaid('graph TD\n n64'); // most recent: still cached
    expect(fake.render).toHaveBeenCalledTimes(65);
    await renderMermaid('graph TD\n n0'); // the oldest was dropped
    expect(fake.render).toHaveBeenCalledTimes(66);
  });

  it('keeps a diagram that is still being shown, however many newer ones arrive', async () => {
    for (let i = 0; i < 64; i += 1) await renderMermaid(`graph TD\n n${i}`);
    await renderMermaid('graph TD\n n0'); // shown again: now the most recently used
    await renderMermaid('graph TD\n n64'); // pushes out the least recently used, n1
    expect(fake.render).toHaveBeenCalledTimes(65);
    await renderMermaid('graph TD\n n0');
    expect(fake.render).toHaveBeenCalledTimes(65);
    await renderMermaid('graph TD\n n1');
    expect(fake.render).toHaveBeenCalledTimes(66);
  });
});

describe('typing into a diagram', () => {
  // A rebuild handing decorateMermaid the given drawings as what each diagram showed.
  const retypeWith = (el, text, previous) => {
    el.innerHTML = renderMarkdown(fence(text));
    return decorateMermaid(el, { live: true, previous });
  };
  // One keystroke: the preview is rebuilt, handing decorateMermaid what each diagram showed.
  const retype = (el, text) => {
    const previous = [...el.querySelectorAll('.mermaid-diagram')].map((box) => box.querySelector('svg'));
    el.innerHTML = renderMarkdown(fence(text));
    return decorateMermaid(el, { live: true, previous });
  };

  it('draws only the text the typing stopped at, not every keystroke', async () => {
    fake = fakeMermaid({ delay: 5 });
    _setMermaidImporter(async () => ({ default: fake }));
    const el = host(fence('graph TD\n a'));
    await decorateMermaid(el);
    let painting;
    for (const text of ['graph TD\n a-', 'graph TD\n a--', 'graph TD\n a-->', 'graph TD\n a-->b']) {
      painting = retype(el, text);
      await new Promise((r) => setTimeout(r, 30)); // faster than the pause before a redraw
    }
    await painting;
    expect(fake.calls).toEqual(['graph TD\n a\n', 'graph TD\n a-->b\n']);
    expect(el.querySelector('.mermaid-diagram svg').textContent).toContain('a-->b');
  });

  it('moves an unchanged drawing back in instead of parsing it again', async () => {
    const el = host(fence('graph TD\n same'));
    await decorateMermaid(el, { enlargeable: true });
    const svg = el.querySelector('.mermaid-diagram svg');
    el.innerHTML = renderMarkdown(fence('graph TD\n same'));
    decorateMermaid(el, { enlargeable: true, previous: [svg] });
    const box = el.querySelector('.mermaid-diagram');
    expect(box.querySelector('svg')).toBe(svg);
    expect(box.getAttribute('role')).toBe('button');
  });

  it('keeps the last good drawing for a mistake it has already seen', async () => {
    fake = fakeMermaid({ fail: 'half' });
    _setMermaidImporter(async () => ({ default: fake }));
    await decorateMermaid(host(fence('graph TD\n half -->'))); // the error is now cached
    const el = host(fence('graph TD\n half -->'));
    decorateMermaid(el, { previous: [drawing('last good')] });
    const box = el.querySelector('.mermaid-diagram');
    expect(box.classList.contains('mermaid-stale')).toBe(true);
    expect(box.querySelector('svg').textContent).toBe('last good');
    expect(box.querySelector('pre')).toBeNull();
  });

  it('pauses once for an edit that changes several diagrams, not once per diagram', async () => {
    const texts = Array.from({ length: 6 }, (_, i) => `graph TD\n n${i}`);
    const el = host(texts.map(fence).join('\n\n'));
    await decorateMermaid(el);
    const previous = [...el.querySelectorAll('.mermaid-diagram')].map((box) => box.querySelector('svg'));
    el.innerHTML = renderMarkdown(texts.map((t) => fence(`${t}x`)).join('\n\n')); // e.g. one undo
    const started = performance.now();
    await decorateMermaid(el, { previous });
    expect(performance.now() - started).toBeLessThan(EDIT_PAUSE_MS * 3);
    expect(el.querySelectorAll('.mermaid-diagram svg')).toHaveLength(6);
  });

  it('keeps the faded drawing on screen when a late error arrives for a box already replaced', async () => {
    let failFirst;
    fake.render = vi.fn((id, text) => (text.includes('S1')
      ? new Promise((_, reject) => { failFirst = () => reject(new Error('Parse error')); })
      : Promise.reject(new Error('Parse error'))));
    const el = host(fence('graph TD\n S0'));
    const drawn = drawing('drawn S0');
    let rebuilt = retypeWith(el, 'graph TD\n S1', [drawn]); // its render is still running…
    await vi.waitFor(() => expect(fake.render).toHaveBeenCalled());
    rebuilt = retypeWith(el, 'graph TD\n S2', [el.querySelector('.mermaid-diagram svg')]); // …when the next keystroke lands
    failFirst();
    await new Promise((r) => setTimeout(r, 20)); // S1's error has landed; S2 is still in its pause
    const box = el.querySelector('.mermaid-diagram');
    expect(box.querySelector('svg')).toBe(drawn); // still on screen, not pulled into the replaced box
    await rebuilt;
  });

  it('keeps a drawing on screen that has dropped out of the cache instead of drawing it again', async () => {
    const texts = Array.from({ length: 70 }, (_, i) => `graph TD\n m${i}`);
    const el = host(texts.map(fence).join('\n\n'));
    await decorateMermaid(el);
    const before = fake.render.mock.calls.length;
    for (let round = 0; round < 2; round += 1) {
      const previous = [...el.querySelectorAll('.mermaid-diagram')].map((box) => box.querySelector('svg'));
      el.innerHTML = renderMarkdown(`${texts.map(fence).join('\n\n')}\n\nA new paragraph ${round}`);
      const painting = decorateMermaid(el, { previous });
      expect(el.querySelectorAll('.mermaid-pending')).toHaveLength(0);
      await painting;
    }
    expect(fake.render.mock.calls.length).toBe(before);
  });

  it('still draws a diagram for a PDF after the preview that asked for it has moved on', async () => {
    fake = fakeMermaid({ delay: 20 });
    _setMermaidImporter(async () => ({ default: fake }));
    const preview = host(fence('graph TD\n shared'));
    decorateMermaid(preview, { previous: [drawing('old')] });
    preview.innerHTML = ''; // the next keystroke replaced it
    const pdf = document.createElement('div'); // laid out away from the page
    pdf.innerHTML = renderMarkdown(fence('graph TD\n shared'));
    await decorateMermaid(pdf);
    expect(pdf.querySelector('.mermaid-diagram svg')).toBeTruthy();
  });
});

describe('fixes from the second real-Chrome round', () => {
  it('keeps the alignment Mermaid sets on titles and labels', async () => {
    fake.render = vi.fn(async (id) => ({ svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text dominant-baseline="middle">t</text></svg>` }));
    const el = host(fence('journey\n title t'));
    await decorateMermaid(el);
    expect(el.querySelector('text').getAttribute('dominant-baseline')).toBe('middle');
  });

  it('gives journey section titles a colour that shows against their box', async () => {
    await decorateMermaid(host(fence('journey\n title t')));
    expect(fake.initialize.mock.calls[0][0].themeCSS).toMatch(/text\.journey-section\s*\{\s*fill:/);
  });

  it('lays a diagram out at the width it will be shown at', async () => {
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(640);
    let seen;
    fake.render = vi.fn(async (id, text, container) => {
      seen = { width: container?.style.width, inPage: container?.isConnected };
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>' };
    });
    await decorateMermaid(host(fence('gantt\n title t')));
    width.mockRestore();
    expect(seen).toEqual({ width: '640px', inPage: true });
    expect([...document.body.children].some((child) => child.style.left === '-10000px')).toBe(false); // removed after
  });

  it('lays a diagram out at the width of a box still on the page, not one a keystroke replaced', async () => {
    // A box that has left the page measures 0.
    const width = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function () { return this.isConnected ? 640 : 0; });
    let seen;
    fake.render = vi.fn(async (id, text, container) => {
      seen = container?.style.width;
      return { svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>' };
    });
    const el = host(fence('gantt\n title t'));
    const first = decorateMermaid(el);
    el.innerHTML = renderMarkdown(fence('gantt\n title t')); // rebuilt before the render started
    await Promise.all([first, decorateMermaid(el)]);
    width.mockRestore();
    expect(fake.render).toHaveBeenCalledTimes(1);
    expect(seen).toBe('640px');
  });

  it('does not paint boxes a later keystroke replaced', async () => {
    fake = fakeMermaid({ delay: 10 });
    _setMermaidImporter(async () => ({ default: fake }));
    const el = host(fence('graph TD\n a-->b'));
    const first = decorateMermaid(el, { live: true });
    const replaced = el.querySelector('.mermaid-diagram');
    el.innerHTML = renderMarkdown(fence('graph TD\n a-->b'));
    await Promise.all([first, decorateMermaid(el, { live: true })]);
    expect(replaced.querySelector('svg')).toBeNull();
    expect(el.querySelector('.mermaid-diagram svg')).toBeTruthy();
  });

  it('says plainly when one diagram type\'s part of the renderer could not load', async () => {
    fake.render = vi.fn(async () => {
      throw new TypeError('Failed to fetch dynamically imported module: chrome-extension://abc/mermaid/chunks/mermaid.esm.min/flowDiagram-X.mjs');
    });
    const el = host(fence('graph TD\n a-->b'));
    await decorateMermaid(el);
    expect(el.querySelector('.mermaid-error-message').textContent).toBe('Diagram error: Part of the diagram renderer could not load. Reopen OWL-Note to try again.');
  });

  it('refuses a diagram longer than Mermaid allows with its own message, without loading Mermaid', async () => {
    const importer = vi.fn(async () => ({ default: fake }));
    _setMermaidImporter(importer);
    const el = host(fence(`graph TD\n${' a-->b\n'.repeat(8000)}`));
    await decorateMermaid(el);
    expect(el.querySelector('.mermaid-error-message').textContent).toBe('Diagram error: This diagram is too long to draw (over 50,000 characters).');
    expect(importer).not.toHaveBeenCalled();
  });

  it('explains a diagram with too many connections in plain words', async () => {
    fake.render = vi.fn(async () => {
      throw new Error('Edge limit exceeded. 500 edges found, but the limit is 500.\n\nInitialize mermaid with maxEdges set to a higher number to allow more edges.\nYou cannot set this config via configuration inside the diagram as it is a secure config.\nYou have to call mermaid.initialize.');
    });
    const el = host(fence('graph TD\n a-->b'));
    await decorateMermaid(el);
    expect(el.querySelector('.mermaid-error-message').textContent).toBe('Diagram error: This diagram has too many connections to draw (the limit is 500).');
  });
});

describe('links inside a diagram', () => {
  it('open in a new tab, never in place of OWL-Note', async () => {
    fake.render = vi.fn(async (id) => ({
      svg: `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><a href="https://example.com/doc"><text>doc</text></a></svg>`,
    }));
    const el = host(fence('graph TD\n A\n click A href "https://example.com/doc"'));
    await decorateMermaid(el);
    const link = el.querySelector('.mermaid-diagram a');
    expect(link.getAttribute('href')).toBe('https://example.com/doc');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});
