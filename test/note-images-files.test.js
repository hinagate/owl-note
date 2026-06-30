import { describe, it, expect } from 'vitest';
import { attachFile, listFileRefs, inlineImagesAsync, pruneAttachments } from '../src/lib/note-images.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('note-images file attachments', () => {
  it('attachFile returns an owl-file ref and stores the attachment with a content-hash id', () => {
    const { ref, attachments } = attachFile({ name: 'report.pdf', mime: 'application/pdf', dataUri: 'data:application/pdf;base64,AAA=' }, []);
    expect(ref).toMatch(/^\[report\.pdf\]\(owl-file:[A-Za-z0-9]+\)$/);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mime).toBe('application/pdf');
  });

  it('listFileRefs finds owl-file references in a body', () => {
    const refs = listFileRefs('see [a.pdf](owl-file:abc) and [b.zip](owl-file:def)');
    expect(refs).toEqual([{ id: 'abc', name: 'a.pdf' }, { id: 'def', name: 'b.zip' }]);
  });

  it('inlineImagesAsync resolves owl-img refs via getBytes', async () => {
    const body = '![x](owl-img:h1)';
    const out = await inlineImagesAsync(body, [{ id: 'h1', mime: 'image/png', driveFileId: 'F' }], async () => PNG);
    expect(out).toBe(`![x](${PNG})`);
  });

  it('inlineImagesAsync leaves a ref untouched when bytes are unavailable', async () => {
    const body = '![x](owl-img:h1)';
    const out = await inlineImagesAsync(body, [{ id: 'h1' }], async () => null);
    expect(out).toBe('![x](owl-img:h1)');
  });

  it('pruneAttachments keeps file (owl-file) attachments still referenced in the body', () => {
    const body = 'doc [report.pdf](owl-file:abc) end';
    const atts = [
      { id: 'abc', name: 'report.pdf', mime: 'application/pdf', driveFileId: 'F' },
      { id: 'dead', name: 'old.zip', mime: 'application/zip', driveFileId: 'G' },
    ];
    const kept = pruneAttachments(body, atts);
    expect(kept.map((a) => a.id)).toEqual(['abc']);
  });

  it('pruneAttachments drops an owl-file attachment no longer referenced', () => {
    const body = 'no attachments here';
    const atts = [{ id: 'abc', name: 'report.pdf', mime: 'application/pdf', driveFileId: 'F' }];
    expect(pruneAttachments(body, atts)).toEqual([]);
  });
});
