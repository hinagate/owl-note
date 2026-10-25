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
