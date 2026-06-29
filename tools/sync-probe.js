import { ensureRoot, buildNoteUrl, isNoteUrl, payloadFromUrl } from '../src/lib/bookmarks.js';

const SIZES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024]; // KB
const out = () => document.getElementById('out');

async function folder() {
  const root = await ensureRoot();
  const kids = await chrome.bookmarks.getChildren(root);
  const f = kids.find((k) => !k.url && k.title === '🧪 sync-probe');
  return f ? f.id : (await chrome.bookmarks.create({ parentId: root, title: '🧪 sync-probe' })).id;
}

document.getElementById('write').onclick = async () => {
  const f = await folder();
  for (const kb of SIZES) {
    const payload = 'A'.repeat(kb * 1024);
    await chrome.bookmarks.create({ parentId: f, title: `probe-${kb}kb`, url: buildNoteUrl(payload) });
  }
  out().textContent = `Wrote ${SIZES.length} probes. Now wait for sync, switch to the other device, and Read back.`;
};

document.getElementById('read').onclick = async () => {
  const f = await folder();
  const kids = await chrome.bookmarks.getChildren(f);
  const lines = kids.map((k) => {
    const ok = isNoteUrl(k.url) && payloadFromUrl(k.url).length > 0;
    return `${k.title}: ${ok ? payloadFromUrl(k.url).length + ' chars' : 'MISSING/EMPTY'}`;
  });
  out().textContent = lines.join('\n') + `\n\nHighest intact size = your safe threshold. Update WARN_URL_BYTES/MAX_URL_BYTES.`;
};
