import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showShareLinkDialog } from '../src/app/share-link-dialog.js';

beforeEach(() => { document.body.innerHTML = '<button id="opener">Share</button>'; });

describe('Drive share-link dialog', () => {
  it('shows access details and waits for an explicit Copy link click', async () => {
    const copy = vi.fn(async () => {});
    const api = showShareLinkDialog('https://drive.google.com/file/d/ONE/view', { copy });
    expect(document.querySelector('.share-link-access').textContent).toContain('Anyone with the link');
    expect(document.querySelector('.share-link-role').textContent).toBe('Viewer');
    expect(api.input.value).toBe('https://drive.google.com/file/d/ONE/view');
    expect(copy).not.toHaveBeenCalled();
    api.copyButton.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copy).toHaveBeenCalledWith('https://drive.google.com/file/d/ONE/view');
    expect(api.copyButton.textContent).toBe('Copied');
  });

  it('closes with Done, Escape, or the close button', () => {
    showShareLinkDialog('https://example.test', { copy: vi.fn() });
    document.querySelector('.share-link-done').click();
    expect(document.querySelector('.share-link-dialog')).toBeNull();

    showShareLinkDialog('https://example.test', { copy: vi.fn() });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.share-link-dialog')).toBeNull();

    showShareLinkDialog('https://example.test', { copy: vi.fn() });
    document.querySelector('.share-link-close').click();
    expect(document.querySelector('.share-link-dialog')).toBeNull();
  });
});
