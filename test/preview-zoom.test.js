import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createZoomBar, stepZoom, normalizeZoom, formatZoom, ZOOM_STEPS, DEFAULT_ZOOM,
} from '../src/app/preview-zoom.js';

const MIN = ZOOM_STEPS[0];
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

describe('stepZoom', () => {
  it('walks the ladder one rung at a time', () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.5, 1)).toBe(1.75);
  });

  it('stops at the ends instead of running off them', () => {
    expect(stepZoom(MAX, 1)).toBe(MAX);
    expect(stepZoom(MIN, -1)).toBe(MIN);
  });

  it('snaps a value that fell between rungs back onto the ladder', () => {
    // A hand-edited preference, or one written by an older step ladder.
    expect(stepZoom(1.2, 1)).toBe(1.25);
    expect(stepZoom(1.2, -1)).toBe(1.1);
  });
});

describe('normalizeZoom', () => {
  it('rejects a stored preference that is not a usable number', () => {
    for (const bad of [undefined, null, 'huge', NaN, 0, -2, {}]) {
      expect(normalizeZoom(bad)).toBe(DEFAULT_ZOOM);
    }
  });

  it('clamps a number that is out of range rather than applying it', () => {
    expect(normalizeZoom(99)).toBe(MAX);
    expect(normalizeZoom(0.01)).toBe(MIN);
    expect(normalizeZoom(1.25)).toBe(1.25);
  });
});

describe('formatZoom', () => {
  it('reads as a whole percentage', () => {
    expect(formatZoom(1)).toBe('100%');
    expect(formatZoom(0.67)).toBe('67%');
    expect(formatZoom(1.75)).toBe('175%');
  });
});

describe('createZoomBar', () => {
  let pane;
  let content;
  const bar = () => pane.querySelector('.preview-zoom');
  const btnOut = () => pane.querySelector('.preview-zoom-out');
  const btnIn = () => pane.querySelector('.preview-zoom-in');
  const level = () => pane.querySelector('.preview-zoom-level');

  beforeEach(() => {
    document.body.innerHTML = '';
    pane = document.createElement('div');
    pane.className = 'preview';
    content = document.createElement('div');
    content.className = 'preview-content';
    pane.append(content);
    document.body.append(pane);
  });

  it('puts minus, the level, and plus in that order at the foot of the pane', () => {
    const zoom = createZoomBar(pane, content);
    expect([...bar().children].map((el) => el.className))
      .toEqual(['preview-zoom-out', 'preview-zoom-level', 'preview-zoom-in']);
    expect(level().textContent).toBe('100%');
    expect(pane.lastElementChild).toBe(bar()); // after the content, so it sits below it
    zoom.destroy();
  });

  it('zooms the preview content in and out', () => {
    const zoom = createZoomBar(pane, content);
    btnIn().click();
    expect(content.style.zoom).toBe('1.1');
    expect(level().textContent).toBe('110%');
    btnOut().click();
    btnOut().click();
    expect(content.style.zoom).toBe('0.9');
    expect(level().textContent).toBe('90%');
    zoom.destroy();
  });

  it('leaves no inline zoom at 100%, so the stylesheet governs', () => {
    const zoom = createZoomBar(pane, content, { value: 1.25 });
    expect(content.style.zoom).toBe('1.25');
    level().click(); // the readout doubles as "reset"
    expect(content.style.zoom).toBe('');
    expect(level().textContent).toBe('100%');
    zoom.destroy();
  });

  it('opens at the saved level without reporting it back as a change', () => {
    const seen = [];
    const zoom = createZoomBar(pane, content, { value: 1.5, onChange: (z) => seen.push(z) });
    expect(content.style.zoom).toBe('1.5');
    expect(level().textContent).toBe('150%');
    expect(seen).toEqual([]); // restoring is not an edit worth persisting
    zoom.destroy();
  });

  it('reports every change so the host can persist it', () => {
    const seen = [];
    const zoom = createZoomBar(pane, content, { onChange: (z) => seen.push(z) });
    btnIn().click();
    btnIn().click();
    expect(seen).toEqual([1.1, 1.25]);
    zoom.destroy();
  });

  it('falls back to 100% when the stored preference is corrupt', () => {
    const zoom = createZoomBar(pane, content, { value: 'not a number' });
    expect(level().textContent).toBe('100%');
    zoom.destroy();
  });

  it('disables the button that would step past the end of the ladder', () => {
    const zoom = createZoomBar(pane, content, { value: MAX });
    expect(btnIn().disabled).toBe(true);
    expect(btnOut().disabled).toBe(false);
    zoom.setZoom(MIN);
    expect(btnOut().disabled).toBe(true);
    expect(btnIn().disabled).toBe(false);
    zoom.destroy();
  });

  it('setZoom applies without reporting back, for host-driven updates', () => {
    const seen = [];
    const zoom = createZoomBar(pane, content, { onChange: (z) => seen.push(z) });
    zoom.setZoom(2);
    expect(zoom.getZoom()).toBe(2);
    expect(seen).toEqual([]);
    zoom.destroy();
  });

  it('takes the bar and the zoom away on destroy', () => {
    const zoom = createZoomBar(pane, content, { value: 1.5 });
    zoom.destroy();
    expect(pane.querySelector('.preview-zoom')).toBe(null);
    expect(content.style.zoom).toBe(''); // a torn-down editor must not leave the note scaled
  });

  it('is announced as one labelled group of controls', () => {
    const zoom = createZoomBar(pane, content);
    expect(bar().getAttribute('role')).toBe('group');
    expect(bar().getAttribute('aria-label')).toBe('Preview zoom');
    expect(btnOut().getAttribute('aria-label')).toBe('Zoom out');
    expect(level().getAttribute('aria-label')).toMatch(/reset to 100%/i);
    zoom.destroy();
  });
});

// ── End-to-end through the app ─────────────────────────────────────────────────
// The module tests above prove the bar works; this proves the level actually survives the
// extension being closed, which is the part that was asked for. Scaffolded like the other
// app-level tests: a note list load is in flight after resetUI, so each session is given a
// moment to settle before the next one replaces the fake bookmark tree under it.
describe('preview zoom persistence', () => {
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 50); });
  let app;

  const openNewNote = async () => {
    const bm = await import('../src/lib/bookmarks.js');
    await app.initUI(await bm.ensureRoot());
    document.querySelector('button.new').click();
  };
  const levelText = () => document.querySelector('#editor .preview-zoom-level').textContent;

  beforeEach(async () => {
    const { installFakeChrome } = await import('./helpers/fake-chrome.js');
    installFakeChrome();
    document.body.innerHTML =
      '<div id="toolbar"></div><aside id="sidebar"></aside><section id="note-list"></section><main id="editor"></main><div id="toast" hidden></div>';
    app = await import('../src/app/app.js');
    app.resetUI();
  });

  afterEach(async () => {
    app?.resetUI();
    await settle();
  });

  it('saves the level and restores it in a fresh session', async () => {
    await openNewNote();
    document.querySelector('#editor .preview-zoom-in').click();
    document.querySelector('#editor .preview-zoom-in').click();

    expect(levelText()).toBe('125%');
    expect((await chrome.storage.local.get('owl:previewZoom'))['owl:previewZoom']).toBe(1.25);

    // Fresh session: same stored preference, new module state.
    app.resetUI();
    await settle();
    await openNewNote();

    expect(levelText()).toBe('125%');
    expect(document.querySelector('#editor .preview-content').style.zoom).toBe('1.25');
  });

  it('opens at 100% when nothing has been saved yet', async () => {
    await openNewNote();
    expect(levelText()).toBe('100%');
    expect(document.querySelector('#editor .preview-content').style.zoom).toBe('');
  });
});
