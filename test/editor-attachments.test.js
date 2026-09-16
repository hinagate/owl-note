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

  it('pastes ordinary clipboard files as owl-file attachments', async () => {
    const editor = renderEditor(document.getElementById('root'), {});
    const textarea = document.querySelector('.note-body');
    const pdf = fakeFile('report.pdf', 'application/pdf', 'PDF');
    const zip = fakeFile('archive.zip', 'application/zip', 'ZIP');
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: [pdf, zip].map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
        getData: () => '',
      },
    });

    textarea.dispatchEvent(paste);
    await vi.waitFor(() => expect(editor.getAttachments()).toHaveLength(2));

    expect(paste.defaultPrevented).toBe(true);
    expect(editor.getBody()).toMatch(/\[report\.pdf\]\(owl-file:[A-Za-z0-9]+\)/);
    expect(editor.getBody()).toMatch(/\[archive\.zip\]\(owl-file:[A-Za-z0-9]+\)/);
    expect(document.querySelectorAll('.attachments-bar .attach-chip')).toHaveLength(2);
    editor.destroy();
  });

  // Office puts a bitmap of the selection on the clipboard next to the real HTML, and the
  // bitmap used to win — so a pasted spreadsheet arrived as a picture nobody could edit.
  const EXCEL_RANGE = '<html xmlns:o="urn:schemas-microsoft-com:office:office">'
    + '<head><meta name=ProgId content=Excel.Sheet><style><!--.xl65 {font-weight:700;}--></style></head>'
    + '<body><table><!--StartFragment--><col width=64 span=2>'
    + '<tr><td class=xl65>Region</td><td class=xl65>Q1</td></tr>'
    + '<tr><td>North</td><td align=right>120</td></tr>'
    + '<!--EndFragment--></table></body></html>';

  const WORD_PICTURE = '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>'
    + '<!--StartFragment--><p class=MsoNormal><img width=400 height=300'
    + ' src="file:///C:/Users/a/AppData/Local/Temp/msohtmlclip1/01/clip_image001.png"></p>'
    + '<!--EndFragment--></body></html>';

  function pasteOffice(textarea, html, plain, bitmap) {
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', {
      value: {
        items: bitmap ? [{ kind: 'file', type: bitmap.type, getAsFile: () => bitmap }] : [],
        getData: (type) => (type === 'text/html' ? html : plain),
      },
    });
    textarea.dispatchEvent(paste);
    return paste;
  }

  it('pastes a copied Excel range as an editable table, not the clipboard bitmap', async () => {
    const editor = renderEditor(document.getElementById('root'), {});
    const textarea = document.querySelector('.note-body');
    const paste = pasteOffice(textarea, EXCEL_RANGE, 'Region\tQ1\nNorth\t120',
      new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(paste.defaultPrevented).toBe(true);
    expect(editor.getAttachments()).toHaveLength(0); // the bitmap was not attached
    expect(editor.getBody()).toMatch(/\|\s*Region\s*\|\s*Q1\s*\|/);
    expect(editor.getBody()).toMatch(/\|\s*North\s*\|\s*120\s*\|/);
    editor.destroy();
  });

  it('starts the pasted table on its own block so it still renders as a table', async () => {
    const editor = renderEditor(document.getElementById('root'), { body: 'Intro line' });
    const textarea = document.querySelector('.note-body');
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    pasteOffice(textarea, EXCEL_RANGE, '', new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }));
    await new Promise((r) => setTimeout(r, 0));

    expect(editor.getBody()).toMatch(/^Intro line\n\n\|/);
    expect(document.querySelector('.preview-body table')).toBeTruthy();
    editor.destroy();
  });

  it('still attaches the bitmap when Word copied a picture, which has no HTML to convert', async () => {
    const editor = renderEditor(document.getElementById('root'), {});
    const textarea = document.querySelector('.note-body');
    pasteOffice(textarea, WORD_PICTURE, '', new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' }));
    await vi.waitFor(() => expect(editor.getAttachments()).toHaveLength(1));

    expect(editor.getBody()).toMatch(/!\[.*\]\(owl-img:[A-Za-z0-9]+\)/);
    expect(editor.getBody()).not.toContain('clip_image001');
    editor.destroy();
  });

  it('leaves a non-Office paste to the browser', () => {
    const editor = renderEditor(document.getElementById('root'), {});
    const textarea = document.querySelector('.note-body');
    const paste = pasteOffice(textarea, '<h1>A blog post</h1>', 'A blog post', null);

    expect(paste.defaultPrevented).toBe(false); // browser inserts its own plain text
    expect(editor.getBody()).toBe('');
    editor.destroy();
  });

  it('accepts multiple dropped files and shows the attachment drop target', async () => {
    const editor = renderEditor(document.getElementById('root'), {});
    const textarea = document.querySelector('.note-body');
    const bodyWrap = document.querySelector('.note-body-wrap');
    const files = [
      fakeFile('notes.txt', 'text/plain', 'hello'),
      fakeFile('data.csv', 'text/csv', 'a,b'),
    ];
    const dragover = new Event('dragover', { bubbles: true, cancelable: true });
    Object.defineProperty(dragover, 'dataTransfer', { value: { types: ['Files'], items: [], dropEffect: 'none' } });
    textarea.dispatchEvent(dragover);

    expect(dragover.defaultPrevented).toBe(true);
    expect(bodyWrap.classList.contains('file-drop-active')).toBe(true);

    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: { items: [], files } });
    textarea.dispatchEvent(drop);
    await vi.waitFor(() => expect(editor.getAttachments()).toHaveLength(2));

    expect(drop.defaultPrevented).toBe(true);
    expect(bodyWrap.classList.contains('file-drop-active')).toBe(false);
    expect(editor.getBody()).toContain('[notes.txt](owl-file:');
    expect(editor.getBody()).toContain('[data.csv](owl-file:');
    editor.destroy();
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
