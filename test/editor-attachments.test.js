import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderEditor } from '../src/app/editor.js';
import { installFakeChrome } from './helpers/fake-chrome.js';

beforeEach(() => { installFakeChrome(); document.body.innerHTML = '<div id="root"></div>'; });

function fakeFile(name, type, text) {
  return { name, type, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}

describe('editor file attachments', () => {
  it('shows a 📎 File button', () => {
    renderEditor(document.getElementById('root'), {});
    expect(document.querySelector('.attach-file')).toBeTruthy();
  });

  it('renders a chip for each file attachment in the note', () => {
    renderEditor(document.getElementById('root'), {
      body: 'see [report.pdf](owl-file:abc)',
      attachments: [{ id: 'abc', name: 'report.pdf', mime: 'application/pdf', driveFileId: 'F' }],
    });
    const chips = document.querySelectorAll('.attachments-bar .attach-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toContain('report.pdf');
  });

  it('code-block Copy button survives async Drive image re-render', async () => {
    // Pre-seed the image cache so resolveDriveImages takes the re-render path
    // without any network call.
    await chrome.storage.local.set({ 'owlcache:img1': 'data:image/png;base64,iVBORw0KGgo=' });

    renderEditor(document.getElementById('root'), {
      body: '```js\nlet x = 1;\n```\n\n![img](owl-img:img1)',
      attachments: [{ id: 'img1', mime: 'image/png', driveFileId: 'F' }],
    });

    // Flush all pending microtasks so resolveDriveImages completes.
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.preview .copy-code')).toBeTruthy();
  });

  function pickFile(input, file) {
    Object.defineProperty(input, 'files', { value: [file], configurable: true, writable: true });
    input.dispatchEvent(new Event('change'));
  }

  it('renders one chip per file reference, even when two refs point to the same file', () => {
    renderEditor(document.getElementById('root'), {
      body: '[a.zip](owl-file:dup)\n[b.zip](owl-file:dup)',
      attachments: [{ id: 'dup', name: 'a.zip', mime: 'application/zip', driveFileId: 'F' }],
    });
    const chips = document.querySelectorAll('.attachments-bar .attach-chip');
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain('a.zip');
    expect(chips[1].textContent).toContain('b.zip');
  });

  it('adds a chip immediately on attach and appends a second chip', async () => {
    renderEditor(document.getElementById('root'), {});
    const fileInput = [...document.querySelectorAll('input[type="file"]')].find((i) => i.accept !== 'image/*');
    pickFile(fileInput, fakeFile('a.pdf', 'application/pdf', 'AAA'));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll('.attachments-bar .attach-chip')).toHaveLength(1);
    pickFile(fileInput, fakeFile('b.zip', 'application/zip', 'BBB'));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelectorAll('.attachments-bar .attach-chip')).toHaveLength(2);
  });

  it('recovers a copied short image ref and renders it in the target note', async () => {
    const attachment = { id: 'copied123', name: 'owl.png', dataUri: 'data:image/png;base64,AAAA' };
    const recoverAttachments = vi.fn(async () => [attachment]);
    const editor = renderEditor(document.getElementById('root'), { recoverAttachments });
    const textarea = document.querySelector('.note-body');
    const ref = '![owl](owl-img:copied123)';
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], getData: (type) => type === 'text/plain' ? ref : '' },
    });

    textarea.dispatchEvent(paste);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(paste.defaultPrevented).toBe(true);
    expect(recoverAttachments).toHaveBeenCalledWith({ body: ref, attachments: [] });
    expect(editor.getAttachments()).toEqual([attachment]);
    expect(document.querySelector('.preview-body img')).toBeTruthy();
    editor.destroy();
  });

  it('shows progress for a copied Drive image and refreshes automatically when it loads', async () => {
    const attachment = { id: 'remote123', name: 'remote.png', mime: 'image/png', driveFileId: 'DRIVE_FILE' };
    const recoverAttachments = vi.fn(async () => [attachment]);
    let finishLoading;
    const loadImageBytes = vi.fn(() => new Promise((resolve) => { finishLoading = resolve; }));
    const editor = renderEditor(document.getElementById('root'), { recoverAttachments, loadImageBytes });
    const textarea = document.querySelector('.note-body');
    const ref = '![remote](owl-img:remote123)';
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [], getData: (type) => type === 'text/plain' ? ref : '' },
    });

    textarea.dispatchEvent(paste);
    expect(document.querySelector('.owl-image-placeholder.loading')?.textContent).toContain('Loading image');
    expect(document.querySelector('.preview-body img')).toBeNull(); // never flash a broken image icon

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loadImageBytes).toHaveBeenCalledWith(attachment);
    expect(document.querySelector('.owl-image-placeholder.loading')).toBeTruthy();

    const dataUri = 'data:image/png;base64,AAAA';
    finishLoading(dataUri);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector('.owl-image-placeholder')).toBeNull();
    expect(document.querySelector('.preview-body img')?.getAttribute('src')).toBe(dataUri);
    expect(editor.getAttachments()[0]).toEqual(attachment); // downloaded bytes stay cached; the saved note keeps its compact Drive pointer
    editor.destroy();
  });
});
