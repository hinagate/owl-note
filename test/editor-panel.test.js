import { describe, it, expect, beforeEach, vi } from 'vitest';
vi.mock('../src/lib/image-downscale.js', () => ({
  imageFileToDataUri: vi.fn(async () => 'data:image/webp;base64,AAAA'),
}));

let mockPanesState = { noteListHidden: false, editCollapsed: false };
vi.mock('../src/app/panes.js', () => ({
  isNoteListHidden: vi.fn(() => mockPanesState.noteListHidden),
  isEditCollapsed: vi.fn(() => mockPanesState.editCollapsed),
  toggleNoteList: vi.fn(() => { mockPanesState.noteListHidden = !mockPanesState.noteListHidden; }),
  toggleEditPane: vi.fn(() => { mockPanesState.editCollapsed = !mockPanesState.editCollapsed; }),
}));

import { renderEditor } from '../src/app/editor.js';

beforeEach(() => {
  document.body.innerHTML = '<main id="editor"></main>';
  mockPanesState = { noteListHidden: false, editCollapsed: false };
});

function render(extra = {}) {
  const c = document.getElementById('editor');
  return renderEditor(c, { title: 'T', body: 'hello', onSave: () => {}, ...extra });
}

describe('editor panel toggles', () => {
  it('renders Hide-list and Read toggle buttons in the bar', () => {
    render();
    expect(document.querySelector('.editor-bar .toggle-list')).not.toBeNull();
    expect(document.querySelector('.editor-bar .toggle-edit')).not.toBeNull();
  });
  it('clicking the list toggle flips its own label', () => {
    render();
    const btn = document.querySelector('.toggle-list');
    const before = btn.textContent;
    btn.click();
    expect(btn.textContent).not.toBe(before); // panes.isNoteListHidden() flipped
    btn.click(); // restore global state for other tests
  });
  it('puts a double-arrow preview toggle to the left of Save', () => {
    render();
    const bar = document.querySelector('.editor-bar');
    const kids = [...bar.children];
    const view = bar.querySelector('.toggle-edit');
    const save = bar.querySelector('.save');
    expect(kids.indexOf(view)).toBeLessThan(kids.indexOf(save)); // left of Save
    expect(['«', '»']).toContain(view.textContent.trim());        // double-arrow icon
    const before = view.textContent;
    view.click();
    expect(view.textContent).not.toBe(before);                    // flips on toggle
    view.click(); // restore module state
  });
});

describe('paste image into the editor', () => {
  it('inserts a downscaled image ref + attachment from a pasted image item', async () => {
    const api = render({ body: '' });
    const ta = document.querySelector('#editor textarea.note-body');
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const e = new Event('paste', { cancelable: true, bubbles: true });
    e.clipboardData = { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] };
    const prevented = !ta.dispatchEvent(e); // dispatchEvent returns false if preventDefault called
    await new Promise((r) => setTimeout(r, 5));
    expect(prevented).toBe(true);
    expect(ta.value).toContain('owl-img:');           // a ref, not a base64 wall
    expect(api.getAttachments()).toHaveLength(1);     // image stored as an attachment
  });

  it('does NOT intercept a plain-text paste', async () => {
    const api = render({ body: 'x' });
    const ta = document.querySelector('#editor textarea.note-body');
    const e = new Event('paste', { cancelable: true, bubbles: true });
    e.clipboardData = { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] };
    const prevented = !ta.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 5));
    expect(prevented).toBe(false);                    // default paste left alone
    expect(api.getAttachments()).toHaveLength(0);
  });
});

describe('size meter accounts for removed images', () => {
  it('measures pruned attachments so the meter drops when an image ref is removed', async () => {
    const seen = [];
    const measure = ({ attachments }) => { seen.push(attachments.map((a) => a.id)); return { bytes: 1, warn: 9, max: 9 }; };
    renderEditor(document.getElementById('editor'), {
      body: '![p](owl-img:abc)',
      attachments: [{ id: 'abc', name: 'p.png', dataUri: 'data:image/png;base64,AAAA' }],
      measure, onSave: () => {},
    });
    expect(seen[seen.length - 1]).toEqual(['abc']); // referenced image is counted
    const ta = document.querySelector('#editor textarea.note-body');
    ta.value = ''; // remove the image ref from the body
    ta.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 5));
    expect(seen[seen.length - 1]).toEqual([]); // orphaned attachment pruned -> meter drops
  });
});

describe('preview-only: reading hint + title heading', () => {
  it('shows the reading hint when preview-only is on', () => {
    mockPanesState.editCollapsed = true;
    renderEditor(document.getElementById('editor'), { title: 'T', body: 'b', onSave: () => {} });
    const hint = document.querySelector('#editor .editor-bar .reading-hint');
    expect(hint).not.toBeNull();
    expect(hint.hidden).toBe(false);
  });
  it('hides the reading hint in edit mode', () => {
    renderEditor(document.getElementById('editor'), { title: 'T', body: 'b', onSave: () => {} });
    expect(document.querySelector('#editor .reading-hint').hidden).toBe(true);
  });
  it('toggles the reading hint when « / » switches to preview-only', () => {
    renderEditor(document.getElementById('editor'), { title: 'T', body: 'b', onSave: () => {} });
    expect(document.querySelector('#editor .reading-hint').hidden).toBe(true);
    document.querySelector('.toggle-edit').click(); // -> preview-only
    expect(document.querySelector('.reading-hint').hidden).toBe(false);
    document.querySelector('.toggle-edit').click(); // restore module state
  });
  it('renders the title heading in the preview in preview-only (reading mode)', () => {
    // The edit pane (with its title field) is hidden in reading mode, so the
    // preview's own heading is how the title shows — it MUST render.
    mockPanesState.editCollapsed = true;
    renderEditor(document.getElementById('editor'), { title: 'Dup', body: 'b', onSave: () => {} });
    expect(document.querySelector('#editor .preview .preview-title')).not.toBeNull();
  });
  it('renders the preview title heading in edit (split) mode', () => {
    renderEditor(document.getElementById('editor'), { title: 'Dup', body: 'b', onSave: () => {} });
    expect(document.querySelector('#editor .preview .preview-title')).not.toBeNull();
  });
});

describe('title lives in the edit pane and stays single-line', () => {
  it('renders the title as a textarea stacked above the body in the edit pane', () => {
    render();
    const title = document.querySelector('#editor .editor-split .edit-pane .note-title');
    expect(title).not.toBeNull();
    expect(title.tagName).toBe('TEXTAREA');
    expect(document.querySelector('#editor .edit-pane textarea.note-body')).not.toBeNull();
    expect(document.querySelector('#editor .edit-pane .preview')).toBeNull(); // preview is NOT in the edit pane
  });
  it('strips newlines so the title stays one logical line', () => {
    const changes = [];
    renderEditor(document.getElementById('editor'), { title: '', body: 'b', onChange: (d) => changes.push(d.title), onSave: () => {} });
    const title = document.querySelector('#editor .note-title');
    title.value = 'one\ntwo';
    title.dispatchEvent(new Event('input'));
    expect(title.value).toBe('one two');
    expect(changes[changes.length - 1]).toBe('one two');
  });
});

describe('auto-save (debounced)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const typeBody = (text) => {
    const ta = document.querySelector('#editor textarea.note-body');
    ta.value = text;
    ta.dispatchEvent(new Event('input'));
    return ta;
  };

  it('saves ~2.5s after typing stops, flagged auto:true', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render({ onSave });
    typeBody('hello world');
    expect(onSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2600);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][1]).toEqual({ auto: true });
  });

  it('coalesces rapid edits into a single save', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render({ onSave });
    typeBody('a');
    await vi.advanceTimersByTimeAsync(1500);
    typeBody('ab'); // resets the debounce window
    await vi.advanceTimersByTimeAsync(1500);
    expect(onSave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('never auto-creates an empty new note', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    renderEditor(document.getElementById('editor'), { title: '', body: '', onSave });
    typeBody('   '); // whitespace only
    await vi.advanceTimersByTimeAsync(3000);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('flushes immediately on blur', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render({ onSave });
    typeBody('draft').dispatchEvent(new Event('blur'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][1]).toEqual({ auto: true });
  });

  it('flush() (tab-hide hook) saves the current content', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    const api = render({ onSave });
    typeBody('via flush');
    await api.flush();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('manual Save is flagged auto:false', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render({ onSave });
    document.querySelector('#editor button.save').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0][1]).toEqual({ auto: false });
  });

  it('shows a subtle status (Unsaved… → Saved ✓), not a toast', async () => {
    const onSave = vi.fn().mockResolvedValue({});
    render({ onSave });
    const status = document.querySelector('.save-status'); // now floats in the edit pane, not the toolbar
    typeBody('x');
    expect(status.textContent).toBe('Unsaved…');
    await vi.advanceTimersByTimeAsync(2600);
    expect(status.textContent).toBe('Saved ✓');
  });
});

describe('notebook breadcrumb', () => {
  it('renders the folder path as clickable crumbs with separators', () => {
    render({ breadcrumb: [{ id: 'r', title: '📓 Notes' }, { id: 'w', title: 'Work' }, { id: 's', title: 'Research' }] });
    const crumbs = [...document.querySelectorAll('.editor-breadcrumb .crumb')];
    expect(crumbs.map((c) => c.textContent)).toEqual(['📓 Notes', 'Work', 'Research']);
    expect(document.querySelectorAll('.editor-breadcrumb .sep')).toHaveLength(2);
  });
  it('clicking a crumb calls onNavigate with that folder id', () => {
    const onNavigate = vi.fn();
    render({ breadcrumb: [{ id: 'r', title: '📓 Notes' }, { id: 'w', title: 'Work' }], onNavigate });
    [...document.querySelectorAll('.editor-breadcrumb .crumb')][1].click();
    expect(onNavigate).toHaveBeenCalledWith('w');
  });
  it('renders no crumbs when the path is empty', () => {
    render({ breadcrumb: [] });
    expect(document.querySelectorAll('.editor-breadcrumb .crumb')).toHaveLength(0);
  });
});
