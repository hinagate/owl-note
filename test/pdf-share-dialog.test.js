import { beforeEach, describe, expect, it, vi } from 'vitest';
import { showPdfShareDialog } from '../src/app/pdf-share-dialog.js';

beforeEach(() => { document.body.innerHTML = '<button id="opener">Share</button>'; });

const pdfFile = () => new File(['pdf bytes'], 'Example.pdf', { type: 'application/pdf' });

describe('PDF ready share dialog', () => {
  it('waits for a fresh Share PDF click before opening the system app selector', async () => {
    const share = vi.fn(async () => {});
    const nav = { canShare: vi.fn(() => true), share };
    const api = showPdfShareDialog({ file: pdfFile(), title: 'Example', download: vi.fn(), navigatorImpl: nav });
    expect(document.querySelector('#pdf-share-title').textContent).toBe('PDF ready');
    expect(share).not.toHaveBeenCalled();
    expect(api.shareButton.textContent).toBe('Share PDF');
    api.shareButton.click();
    // Called synchronously inside the click handler, before any await can consume activation.
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].files[0].name).toBe('Example.pdf');
    expect(share.mock.calls[0][0]).not.toHaveProperty('text');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.querySelector('.pdf-share-dialog')).toBeNull();
  });

  it('uses the same ready panel with a download action when file sharing is unsupported', () => {
    const download = vi.fn();
    const api = showPdfShareDialog({ file: pdfFile(), title: 'Example', download, navigatorImpl: {} });
    expect(api.shareButton.textContent).toBe('Download PDF');
    api.shareButton.click();
    expect(download).toHaveBeenCalledTimes(1);
    expect(api.status.textContent).toContain('downloaded');
  });

  it('always offers an explicit Download button beside system sharing', () => {
    const download = vi.fn();
    const api = showPdfShareDialog({
      file: pdfFile(), title: 'Example', download,
      navigatorImpl: { canShare: () => true, share: vi.fn() },
    });
    api.downloadButton.click();
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ name: 'Example.pdf' }));
  });

  it('keeps the ready panel open if the system share menu cannot open', () => {
    const api = showPdfShareDialog({
      file: pdfFile(), title: 'Example', download: vi.fn(),
      navigatorImpl: { canShare: () => true, share: () => { throw new Error('blocked'); } },
    });
    api.shareButton.click();
    expect(document.querySelector('.pdf-share-dialog')).not.toBeNull();
    expect(api.status.textContent).toContain('download');
  });
});
