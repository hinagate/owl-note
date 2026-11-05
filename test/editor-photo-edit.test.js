// Editing a note's photo from the viewer: ✏️ Edit opens the drawing panel over the
// photo, and its Save puts the edited photo back in place of the one opened. The panel
// is stubbed — it has its own tests — so this file covers only the editor's half.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';

vi.mock('../src/app/draw-panel.js', () => ({ showDrawPanel: vi.fn() }));
const { showDrawPanel } = await import('../src/app/draw-panel.js');
const { renderEditor } = await import('../src/app/editor.js');

const A = { id: 'aaa111', name: 'street.png', mime: 'image/png', dataUri: 'data:image/png;base64,QUFB' };
const B = { id: 'bbb222', name: 'map.jpg', mime: 'image/jpeg', dataUri: 'data:image/jpeg;base64,QkJC' };
const BODY = [
  '![first](owl-img:aaa111)',
  '![second](owl-img:aaa111)',
  '![map](owl-img:bbb222)',
  '![remote](https://example.com/x.png)',
].join('\n\n');

beforeEach(() => {
  installFakeChrome();
  document.body.innerHTML = '<div id="root"></div>';
  showDrawPanel.mockReset();
});

const open = (opts = {}) => renderEditor(document.getElementById('root'), {
  body: BODY, attachments: [A, B], ...opts,
});
const previewImages = () => [...document.querySelectorAll('.preview-body img')];
const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const editButton = () => document.querySelector('.image-lightbox-edit');

describe('photos in the preview know which attachment they are', () => {
  it('tags each photo with its attachment and which of its references it is', () => {
    open();
    const tags = previewImages().map((img) => [img.dataset.owlImg, img.dataset.owlImgNth]);
    expect(tags).toEqual([['aaa111', '0'], ['aaa111', '1'], ['bbb222', '0'], [undefined, undefined]]);
  });
});

describe('the viewer offers ✏️ Edit', () => {
  it('for a note\'s own photo', () => {
    open();
    click(previewImages()[0]);
    expect(document.querySelector('.image-lightbox').hidden).toBe(false);
    expect(editButton().hidden).toBe(false);
  });

  it('not for a remote image, which has no attachment to replace', () => {
    open();
    click(previewImages()[3]);
    expect(editButton().hidden).toBe(true);
  });

  it('not in a read-only note', () => {
    open({ readOnly: true });
    click(previewImages()[0]);
    expect(editButton().hidden).toBe(true);
  });

  it('opens the photo in the drawing panel and closes the viewer', async () => {
    open();
    click(previewImages()[2]);
    click(editButton());
    await vi.waitFor(() => expect(showDrawPanel).toHaveBeenCalled());
    expect(document.querySelector('.image-lightbox').hidden).toBe(true);
    expect(showDrawPanel.mock.calls[0][0].photo).toEqual({ src: B.dataUri, name: 'map.jpg', mime: 'image/jpeg' });
  });
});

describe('saving the edited photo', () => {
  async function editAndSave(index, file) {
    click(previewImages()[index]);
    click(editButton());
    await vi.waitFor(() => expect(showDrawPanel).toHaveBeenCalled());
    await showDrawPanel.mock.calls[0][0].onSave(file);
  }
  const edited = () => new File(['edited-bytes'], 'street.png', { type: 'image/png' });

  it('replaces only the reference that was opened, keeping its alt text', async () => {
    open();
    await editAndSave(1, edited());
    const body = document.querySelector('textarea.note-body').value;
    const refs = [...body.matchAll(/!\[([^\]]*)\]\(owl-img:(\w+)\)/g)].map((m) => [m[1], m[2]]);
    expect(refs[0]).toEqual(['first', 'aaa111']);   // the same photo, used elsewhere: untouched
    expect(refs[1][0]).toBe('second');
    expect(refs[1][1]).not.toBe('aaa111');
    expect(refs[2]).toEqual(['map', 'bbb222']);
  });

  it('saves the edited photo with the note, at its full size (no insert downscale)', async () => {
    const onSave = vi.fn();
    open({ onSave });
    await editAndSave(2, new File(['edited-bytes'], 'map.jpg', { type: 'image/jpeg' }));
    click(document.querySelector('button.save'));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    const saved = onSave.mock.calls.at(-1)[0];
    const newId = /!\[map\]\(owl-img:(\w+)\)/.exec(saved.body)[1];
    const att = saved.attachments.find((a) => a.id === newId);
    expect(att.name).toBe('map.jpg');
    expect(att.dataUri).toBe(`data:image/jpeg;base64,${btoa('edited-bytes')}`);
    // Nothing refers to the original map any more, so it is not saved.
    expect(saved.attachments.map((a) => a.id).sort()).toEqual(['aaa111', newId].sort());
  });

  it('holds the bytes of an original kept only in Drive, so an undo can save it again', async () => {
    const onSave = vi.fn();
    const inDrive = { id: 'ccc333', name: 'scan.png', mime: 'image/png', driveFileId: 'drive-file-1' };
    const bytes = 'data:image/png;base64,Q0ND';
    const body = '![scan](owl-img:ccc333)';
    renderEditor(document.getElementById('root'), {
      body, attachments: [inDrive], onSave, loadImageBytes: async () => bytes,
    });
    const photo = await vi.waitFor(() => {
      const img = document.querySelector('.preview-body img[data-owl-img="ccc333"]');
      expect(img).toBeTruthy();
      return img;
    });
    click(photo);
    click(editButton());
    await vi.waitFor(() => expect(showDrawPanel).toHaveBeenCalled());
    await showDrawPanel.mock.calls[0][0].onSave(new File(['edited'], 'scan.png', { type: 'image/png' }));
    // What Ctrl+Z does (jsdom has no native undo): the reference comes back.
    const ta = document.querySelector('textarea.note-body');
    ta.value = body;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    click(document.querySelector('button.save'));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls.at(-1)[0].attachments).toEqual([{ ...inDrive, dataUri: bytes }]);
  });

  it('keeps the edit at the caret if the photo was removed while it was open', async () => {
    open();
    click(previewImages()[2]);
    click(editButton());
    await vi.waitFor(() => expect(showDrawPanel).toHaveBeenCalled());
    const ta = document.querySelector('textarea.note-body');
    ta.value = ta.value.replace('![map](owl-img:bbb222)', '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.setSelectionRange(0, 0);
    await showDrawPanel.mock.calls[0][0].onSave(new File(['x'], 'map.jpg', { type: 'image/jpeg' }));
    expect(ta.value).toMatch(/^!\[map\.jpg\]\(owl-img:\w+\)/);
  });
});

describe('editImage (a fresh capture lands here)', () => {
  it('opens the photo for an attachment id', async () => {
    const editor = open();
    expect(await editor.editImage('bbb222')).toBe(true);
    expect(showDrawPanel.mock.calls[0][0].photo.src).toBe(B.dataUri);
  });

  it('does nothing for an unknown photo or a read-only note', async () => {
    expect(await open().editImage('nope')).toBe(false);
    expect(await open({ readOnly: true }).editImage('aaa111')).toBe(false);
    expect(showDrawPanel).not.toHaveBeenCalled();
  });
});

describe('the caret after a photo is put back', () => {
  const textarea = () => document.querySelector('textarea.note-body');
  const save = async (editor) => {
    await editor.editImage('bbb222');
    await showDrawPanel.mock.calls[0][0].onSave(new File(['edited photo'], 'map.jpg', { type: 'image/jpeg' }));
  };
  const typeAtCaret = (text) => {
    const ta = textarea();
    const at = ta.selectionStart;
    ta.value = ta.value.slice(0, at) + text + ta.value.slice(ta.selectionEnd);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const placeCaret = (at) => textarea().setSelectionRange(at, at);

  it('stays before the photo if it was before it', async () => {
    const editor = open();
    placeCaret(0);
    await save(editor);
    expect(textarea().selectionStart).toBe(0);
  });

  it('stays after the photo if it was after it, though the id changed length', async () => {
    const editor = open();
    placeCaret(textarea().value.length);
    await save(editor);
    expect(textarea().selectionStart).toBe(textarea().value.length);
  });

  it('never ends up inside the reference, so typing cannot break the photo', async () => {
    const editor = open();
    placeCaret(textarea().value.indexOf('bbb222') + 3);
    await save(editor);
    typeAtCaret('note');
    expect(textarea().value).toMatch(/!\[map\]\(owl-img:[A-Za-z0-9]+\)note/);
    expect(previewImages()[2].getAttribute('src')).toMatch(/^data:image\/jpeg/);
  });
});

// A full-page capture of a long page. The panel re-encodes it on Save, which can carry a
// photo that opened fine past what the Markdown parser takes: the panel closed, the photo
// disappeared from the preview, and the note was never saved.
describe('a photo too long for the Markdown parser', () => {
  const bigFile = () => new File([new Uint8Array(9_000_000)], 'map.jpg', { type: 'image/jpeg' });

  it('opens: the preview shows it', () => {
    const big = { id: 'big1', name: 'long.jpg', mime: 'image/jpeg', dataUri: `data:image/jpeg;base64,${'QUJD'.repeat(3_000_000)}` };
    renderEditor(document.getElementById('root'), { body: '![long](owl-img:big1)', attachments: [big] });
    expect(document.querySelector('.preview-body img').getAttribute('src')).toBe(big.dataUri);
  });

  it('comes back from Save: it shows, and the note is saved', async () => {
    const onSave = vi.fn();
    const editor = open({ onSave });
    await editor.editImage('bbb222');
    await showDrawPanel.mock.calls[0][0].onSave(bigFile());

    const shown = previewImages()[2].getAttribute('src');
    expect(shown.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(shown.length).toBeGreaterThan(12_000_000);
    await editor.flush();
    expect(onSave).toHaveBeenCalled();
    const saved = onSave.mock.calls.at(-1)[0];
    expect(saved.attachments.some((a) => a.dataUri === shown)).toBe(true);
  });

  it('says so if the edited photo cannot be put back, instead of nothing happening', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const editor = open();
    await editor.editImage('bbb222');
    await showDrawPanel.mock.calls[0][0].onSave('not a file'); // the read fails
    expect(document.getElementById('root').textContent).toContain('Could not save the photo');
    warn.mockRestore();
  });
});

describe('typing in a note holding a very large photo', () => {
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const big = { id: 'big1', name: 'long.jpg', mime: 'image/jpeg', dataUri: `data:image/jpeg;base64,${'QUJD'.repeat(1_000_000)}` };
  const type = (text) => {
    const ta = document.querySelector('textarea.note-body');
    ta.value += text;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const preview = () => document.querySelector('.preview-body');

  it('refreshes the preview after a pause, not on every key', async () => {
    renderEditor(document.getElementById('root'), { body: '![long](owl-img:big1)\n\n', attachments: [big] });
    const before = preview();
    type('a');
    type('b');
    expect(preview()).toBe(before);
    await wait(500);
    expect(preview()).not.toBe(before);
    expect(preview().textContent).toContain('ab');
  });

  it('still saves what was typed if the note is saved before that pause', async () => {
    const onSave = vi.fn();
    const editor = renderEditor(document.getElementById('root'), { body: '![long](owl-img:big1)\n\n', attachments: [big], onSave });
    type('kept');
    await editor.flush();
    expect(onSave.mock.calls.at(-1)[0].body).toContain('kept');
  });

  it('does not refresh once the editor is gone', async () => {
    const editor = renderEditor(document.getElementById('root'), { body: '![long](owl-img:big1)\n\n', attachments: [big] });
    const before = preview();
    type('a');
    editor.destroy();
    await wait(500);
    expect(preview()).toBe(before);
  });

  it('keeps an ordinary note refreshing on every key', () => {
    open();
    const before = preview();
    type('a');
    expect(preview()).not.toBe(before);
  });
});

describe('a note the Markdown parser cannot render at all', () => {
  const unbroken = 'x'.repeat(12_000_000); // one word, past what its regexes can step through

  it('still opens, says why there is no preview, and can be saved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const onSave = vi.fn();
    const editor = renderEditor(document.getElementById('root'), { body: unbroken, onSave });
    expect(document.querySelector('.preview-body').textContent).toContain('too large to preview');
    const ta = document.querySelector('textarea.note-body');
    ta.value = `${unbroken} more`;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await editor.flush();
    expect(onSave).toHaveBeenCalled();
    warn.mockRestore();
  });
});
