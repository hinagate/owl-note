import { beforeEach, describe, expect, it } from 'vitest';
import { hidePdfProgress, updatePdfProgress } from '../src/app/pdf-progress.js';

beforeEach(() => { document.body.innerHTML = ''; });

describe('PDF progress', () => {
  it('persists with a percentage until explicitly hidden', () => {
    const root = updatePdfProgress({ percent: 0, label: 'Creating PDF…' });
    expect(root.hidden).toBe(false);
    expect(root.querySelector('.pdf-progress-label').textContent).toBe('Creating PDF… 0%');
    expect(root.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('0');
    updatePdfProgress({ percent: 63, label: 'Creating PDF…' });
    expect(root.querySelector('.pdf-progress-label').textContent).toBe('Creating PDF… 63%');
    expect(root.hidden).toBe(false);
    hidePdfProgress();
    expect(root.hidden).toBe(true);
  });

  it('supports an indeterminate upload phase without auto-hiding', () => {
    const root = updatePdfProgress({ percent: null, label: 'Uploading PDF to Drive…' });
    expect(root.textContent).toContain('Uploading PDF to Drive…');
    expect(root.querySelector('.pdf-progress-track').classList.contains('indeterminate')).toBe(true);
    expect(root.hidden).toBe(false);
  });
});
