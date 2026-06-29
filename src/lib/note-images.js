// src/lib/note-images.js
// Inline base64 images bloat the editable note body. These pure helpers move the
// image bytes into the note's `attachments` array and leave a short reference
// (`owl-img:<id>`) in the body, so the editor shows a single readable line instead
// of a wall of base64. The preview and the Markdown export inline the bytes back.
import { contentHash } from './note.js';

// `![alt](data:image/...;base64,XXXX)` — a Markdown image whose URL is a base64 data: URI.
const INLINE_IMG = /(!\[[^\]]*\]\()(data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+)(\))/g;
// `![alt](owl-img:ID)` — the short reference we substitute for an extracted image.
const REF_IMG = /(!\[[^\]]*\]\()owl-img:([A-Za-z0-9]+)(\))/g;

function altOf(prefix) {
  const m = /^!\[([^\]]*)\]/.exec(prefix);
  return (m && m[1]) || '';
}

// Move every inline base64 image out of `body` into attachments (merging with any
// existing ones), replacing each with an `owl-img:<id>` reference. Identical images
// share one attachment (id is a content hash). Returns { body, attachments }.
export function extractImages(body, attachments = []) {
  const src = String(body ?? '');
  const byId = new Map((attachments || []).map((a) => [a.id, a]));
  let out = '';
  let last = 0;
  for (const m of src.matchAll(INLINE_IMG)) {
    const dataUri = m[2];
    const id = contentHash(dataUri);
    if (!byId.has(id)) byId.set(id, { id, name: altOf(m[1]) || 'image', dataUri });
    out += src.slice(last, m.index) + m[1] + 'owl-img:' + id + m[3];
    last = m.index + m[0].length;
  }
  out += src.slice(last);
  return { body: out, attachments: [...byId.values()] };
}

// Replace each `owl-img:<id>` reference with its data: URI (for preview + export).
// Unknown ids are left as-is. Returns the inlined body string.
export function inlineImages(body, attachments = []) {
  const byId = new Map((attachments || []).map((a) => [a.id, a]));
  return String(body ?? '').replace(REF_IMG, (whole, pre, id, post) => {
    const a = byId.get(id);
    return a ? pre + a.dataUri + post : whole;
  });
}

// Drop attachments whose `owl-img:<id>` reference no longer appears in the body.
export function pruneAttachments(body, attachments = []) {
  const used = new Set();
  for (const m of String(body ?? '').matchAll(REF_IMG)) used.add(m[2]);
  return (attachments || []).filter((a) => used.has(a.id));
}
