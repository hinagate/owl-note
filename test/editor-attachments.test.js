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
});
