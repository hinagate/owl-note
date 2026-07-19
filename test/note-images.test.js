import { describe, it, expect } from 'vitest';
import { extractImages, inlineImages, pruneAttachments, inheritReferencedAttachments } from '../src/lib/note-images.js';

const PNG = 'data:image/png;base64,AAAA';
const JPG = 'data:image/jpeg;base64,/9j/9w==';

describe('extractImages', () => {
  it('moves inline images to attachments and leaves owl-img refs', () => {
    const { body, attachments } = extractImages(`a ![p.png](${PNG}) b ![q.jpg](${JPG}) c`);
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({ name: 'p.png', dataUri: PNG });
    expect(attachments[1]).toMatchObject({ name: 'q.jpg', dataUri: JPG });
    expect(body).toBe(`a ![p.png](owl-img:${attachments[0].id}) b ![q.jpg](owl-img:${attachments[1].id}) c`);
    expect(body).not.toContain('base64');
  });

  it('dedups identical images into one attachment, stable id', () => {
    const r1 = extractImages(`![a](${PNG})`);
    const r2 = extractImages(`![b](${PNG})`);
    expect(r1.attachments[0].id).toBe(r2.attachments[0].id); // content-hashed -> stable
    const dup = extractImages(`![a](${PNG}) and ![b](${PNG})`);
    expect(dup.attachments).toHaveLength(1);
  });

  it('merges with existing attachments without duplicating', () => {
    const first = extractImages(`![a](${PNG})`);
    const second = extractImages(`![a](${PNG}) ![b](${JPG})`, first.attachments);
    expect(second.attachments).toHaveLength(2);
  });

  it('leaves a body with no inline images untouched', () => {
    expect(extractImages('# Title\n\n```\nSELECT 1\n```')).toEqual({ body: '# Title\n\n```\nSELECT 1\n```', attachments: [] });
  });
});

describe('inlineImages', () => {
  it('restores data URIs from refs', () => {
    const { body, attachments } = extractImages(`x ![p.png](${PNG}) y`);
    expect(inlineImages(body, attachments)).toBe(`x ![p.png](${PNG}) y`);
  });

  it('leaves an unknown ref as-is', () => {
    expect(inlineImages('![a](owl-img:deadbeef)', [])).toBe('![a](owl-img:deadbeef)');
  });

  it('leaves a Drive-backed ref intact until its bytes have loaded', () => {
    const ref = '![remote](owl-img:abc)';
    expect(inlineImages(ref, [{ id: 'abc', driveFileId: 'DRIVE_FILE', mime: 'image/png' }])).toBe(ref);
  });

  it('is an exact round-trip with extractImages', () => {
    const original = `intro ![one.png](${PNG}) mid ![two.jpg](${JPG}) end`;
    const { body, attachments } = extractImages(original);
    expect(inlineImages(body, attachments)).toBe(original);
  });
});

describe('pruneAttachments', () => {
  it('drops attachments whose ref was deleted from the body', () => {
    const { body, attachments } = extractImages(`![a](${PNG}) ![b](${JPG})`);
    expect(attachments).toHaveLength(2);
    const keptRef = body.replace(new RegExp(`\\s*!\\[b\\]\\(owl-img:${attachments[1].id}\\)`), '');
    const pruned = pruneAttachments(keptRef, attachments);
    expect(pruned).toHaveLength(1);
    expect(pruned[0].name).toBe('a');
  });
});

describe('inheritReferencedAttachments', () => {
  it('copies only the attachment referenced by pasted Markdown from another note', () => {
    const wanted = { id: 'abc', name: 'owl.png', dataUri: PNG };
    const unrelated = { id: 'other', name: 'other.jpg', dataUri: JPG };
    const inherited = inheritReferencedAttachments(
      'copied ![owl](owl-img:abc)',
      [],
      [{ attachments: [wanted, unrelated] }],
    );
    expect(inherited).toEqual([wanted]);
  });

  it('does not overwrite an existing target attachment with the same id', () => {
    const target = { id: 'abc', name: 'target.png', dataUri: PNG };
    const source = { id: 'abc', name: 'source.png', dataUri: JPG };
    expect(inheritReferencedAttachments('![owl](owl-img:abc)', [target], [{ attachments: [source] }])).toEqual([target]);
  });
});
