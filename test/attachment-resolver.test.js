import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { encode, decode } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';
import { inlineImages } from '../src/lib/note-images.js';
import { resolveReferencedAttachments } from '../src/lib/attachment-resolver.js';
import { saveNote } from '../src/lib/save-note.js';
import { rememberCopiedAttachments, _resetCopiedAttachments } from '../src/lib/copied-attachments.js';

const PNG = 'data:image/png;base64,AAAA';
const ATT = { id: 'copied123', name: 'owl.png', mime: 'image/png', dataUri: PNG };
const REF = '![owl](owl-img:copied123)';

beforeEach(() => { installFakeChrome(); _resetCopiedAttachments(); });

describe('cross-note attachment recovery', () => {
  it('repairs a copied image ref during save and persists a working target note', async () => {
    const root = await bm.ensureRoot();
    const source = createNote({ title: 'Source', body: REF, attachments: [ATT] });
    await saveNote(source, root);

    const target = createNote({ title: 'Target', body: `Copied:\n\n${REF}`, attachments: [] });
    const result = await saveNote(target, root);

    expect(result.note.attachments).toEqual([ATT]);
    const row = (await bm.listNotes(root)).find((item) => item.bookmarkId === result.bookmarkId);
    const persisted = await decode(row.payload);
    expect(persisted.attachments).toEqual([ATT]);
    expect(inlineImages(persisted.body, persisted.attachments)).toContain(PNG);
  });

  it('repairs a CUT image ref, which its source note has already saved without', async () => {
    const root = await bm.ensureRoot();
    const source = createNote({ title: 'Source', body: REF, attachments: [ATT] });
    const saved = await saveNote(source, root);
    rememberCopiedAttachments([ATT]); // the editor's cut handler
    // The source saves with the reference cut out, which prunes the attachment.
    await saveNote({ ...saved.note, body: 'nothing left', attachments: [] }, root, saved.bookmarkId);
    expect((await mirror.allBackups()).some((n) => (n.attachments || []).length)).toBe(false);

    const result = await saveNote(createNote({ title: 'Target', body: REF, attachments: [] }), root);
    expect(result.note.attachments).toEqual([ATT]);
  });

  it('reads what another OWL-Note page cut, from storage', async () => {
    rememberCopiedAttachments([ATT]);
    _resetCopiedAttachments(); // this page never saw the cut
    const recovered = await resolveReferencedAttachments(createNote({ title: 'T', body: REF, attachments: [] }), { sourceNotes: [] });
    expect(recovered.attachments).toEqual([ATT]);
  });

  it('falls back to a bookmark when the source mirror is unavailable', async () => {
    const root = await bm.ensureRoot();
    const source = createNote({ title: 'Bookmark source', body: REF, attachments: [ATT] });
    await bm.createNote(root, source.title, await encode(source));
    expect(await mirror.allBackups()).toEqual([]);

    const target = createNote({ title: 'Target', body: REF, attachments: [] });
    const recovered = await resolveReferencedAttachments(target, { rootId: root });
    expect(recovered.attachments).toEqual([ATT]);
  });
});
