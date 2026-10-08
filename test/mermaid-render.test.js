import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown.js';
import { decorateMermaid, renderMermaid, loadMermaid, diagramImageUrl, _setMermaidImporter, MERMAID_ENTRY } from '../src/lib/mermaid-render.js';
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

  it('tries again later when the renderer itself could not load', async () => {
    let attempts = 0;
    _setMermaidImporter(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('net::ERR_FILE_NOT_FOUND');
      return { default: fake };
    });
    const first = host(fence('graph TD\n retry'));
    await decorateMermaid(first);
    expect(first.querySelector('.mermaid-error-message').textContent).toMatch(/could not load/);
    const second = host(fence('graph TD\n retry'));
    await decorateMermaid(second);
    expect(second.querySelector('svg')).toBeTruthy();
    expect(attempts).toBe(2);
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
    const previous = ['<svg xmlns="http://www.w3.org/2000/svg" id="old"><text>old drawing</text></svg>'];
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
    const previous = ['<svg xmlns="http://www.w3.org/2000/svg" id="old"><text>last good</text></svg>'];
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
    const painting = decorateMermaid(el, { previous: ['<svg xmlns="http://www.w3.org/2000/svg"><text>only one before</text></svg>'] });
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
  it('gives up on it after the deadline, and the diagrams after it still draw', async () => {
    const stuck = fakeMermaid();
    stuck.render = vi.fn(async (id, text) => (text.includes('hang')
      ? new Promise(() => {}) // an image whose host never answers
      : { svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 10 10"><text>${text.trim()}</text></svg>` }));
    _setMermaidImporter(async () => ({ default: stuck }), { timeoutMs: 30 });
    const el = host([fence('graph TD\n hang'), fence('graph TD\n after')].join('\n\n'));
    await decorateMermaid(el);
    const [first, second] = el.querySelectorAll('.mermaid-diagram');
    expect(first.querySelector('.mermaid-error-message').textContent).toMatch(/took too long to draw/);
    expect(second.querySelector('svg').textContent).toContain('after');
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
