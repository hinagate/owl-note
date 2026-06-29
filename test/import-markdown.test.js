// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeChrome } from './helpers/fake-chrome.js';
import * as bm from '../src/lib/bookmarks.js';
import { decode } from '../src/lib/codec.js';
import { zipFiles } from '../src/lib/zip.js';
import { importFiles } from '../src/app/app.js';

beforeEach(() => installFakeChrome());

const md = (fm, body) => `---\n${fm}\n---\n\n${body}`;

async function zipFile(name, files) {
  const blob = await zipFiles(files.map((f) => ({ path: f.path, data: new TextEncoder().encode(f.text) })));
  const buf = await blob.arrayBuffer();
  return { name, arrayBuffer: async () => buf, text: async () => '' };
}
function textFile(name, text) {
  return { name, text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
}
async function notesByTitle(root) {
  const out = {};
  for (const r of await bm.allNotes(root)) { const n = await decode(r.payload); out[n.title] = { ...n, folderId: r.folderId }; }
  return out;
}

describe('importFiles', () => {
  it('imports a zip, recreating notebooks from folders (Inbox -> root)', async () => {
    const root = await bm.ensureRoot();
    const file = await zipFile('export.zip', [
      { path: 'Recipes/Soup.md', text: md('title: "Soup"\nnotebook: "Recipes"\nid: "s1"', '# Soup\nyum') },
      { path: 'Inbox/Quick.md', text: md('title: "Quick"\nnotebook: "Inbox"\nid: "q1"', 'note') },
    ]);
    const tally = await importFiles([file]);
    expect(tally.created).toBe(2);
    const recipes = (await bm.listNotebooks(root)).find((n) => n.title === 'Recipes');
    expect(recipes).toBeTruthy();
    const byTitle = await notesByTitle(root);
    expect(byTitle['Soup'].folderId).toBe(recipes.id);
    expect(byTitle['Soup'].body).toBe('# Soup\nyum');
    expect(byTitle['Quick'].folderId).toBe(root);
  });

  it('is idempotent: re-importing updates by id with no duplicates', async () => {
    const v1 = await zipFile('export.zip', [{ path: 'Recipes/Soup.md', text: md('title: "Soup"\nnotebook: "Recipes"\nid: "s1"', 'v1') }]);
    await importFiles([v1]);
    const v2 = await zipFile('export.zip', [{ path: 'Recipes/Soup.md', text: md('title: "Soup"\nnotebook: "Recipes"\nid: "s1"', 'v2') }]);
    const tally = await importFiles([v2]);
    expect(tally.created).toBe(0);
    expect(tally.updated).toBe(1);
    const root = await bm.ensureRoot();
    const all = await bm.allNotes(root);
    expect(all.length).toBe(1);
    expect((await decode(all[0].payload)).body).toBe('v2');
  });

  it('places a loose .md by its notebook frontmatter and gives it a fresh id', async () => {
    const root = await bm.ensureRoot();
    await importFiles([textFile('Idea.md', md('notebook: "Work"', '# Idea\ndetails'))]);
    const work = (await bm.listNotebooks(root)).find((n) => n.title === 'Work');
    expect(work).toBeTruthy();
    const byTitle = await notesByTitle(root);
    expect(byTitle['Idea'].folderId).toBe(work.id);
    expect(typeof byTitle['Idea'].id).toBe('string');
  });

  it('imports a JSON backup into root as real bookmarks (fixes the old no-op)', async () => {
    const root = await bm.ensureRoot();
    const json = JSON.stringify({ version: 1, notes: [{ id: 'j1', title: 'FromJson', body: 'hi', attachments: [], version: 1, hash: 'h' }] });
    const tally = await importFiles([textFile('backup.json', json)]);
    expect(tally.created).toBe(1);
    expect((await notesByTitle(root))['FromJson'].folderId).toBe(root);
  });
});
