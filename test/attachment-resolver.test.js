import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import * as mirror from '../src/lib/mirror.js';
import { encode, decode } from '../src/lib/codec.js';
import { createNote } from '../src/lib/note.js';
import { inlineImages } from '../src/lib/note-images.js';
import { resolveReferencedAttachments } from '../src/lib/attachment-resolver.js';
import { saveNote } from '../src/lib/save-note.js';

const PNG = 'data:image/png;base64,AAAA';
const ATT = { id: 'copied123', name: 'owl.png', mime: 'image/png', dataUri: PNG };
const REF = '![owl](owl-img:copied123)';

beforeEach(() => installFakeChrome());

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
