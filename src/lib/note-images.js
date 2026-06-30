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
// `[name](owl-file:ID)` — a non-image file attachment reference.
const REF_FILE = /\[([^\]]*)\]\(owl-file:([A-Za-z0-9]+)\)/g;

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

// Drop attachments whose reference (owl-img:<id> or owl-file:<id>) no longer appears in the body.
export function pruneAttachments(body, attachments = []) {
  const used = new Set();
  const s = String(body ?? '');
  for (const m of s.matchAll(REF_IMG)) used.add(m[2]);
  for (const m of s.matchAll(REF_FILE)) used.add(m[2]);
  return (attachments || []).filter((a) => used.has(a.id));
}

// Add a non-image file as an attachment, returning a readable `[name](owl-file:<id>)`
// reference to insert in the body. id is a content hash so identical files dedupe.
export function attachFile({ name, mime, dataUri }, attachments = []) {
  const id = contentHash(dataUri);
  const byId = new Map((attachments || []).map((a) => [a.id, a]));
  if (!byId.has(id)) byId.set(id, { id, name: name || 'file', mime: mime || 'application/octet-stream', dataUri });
  return { ref: `[${name || 'file'}](owl-file:${id})`, attachments: [...byId.values()] };
}

// All owl-file references in a body, in order.
export function listFileRefs(body) {
  const out = [];
  for (const m of String(body ?? '').matchAll(REF_FILE)) out.push({ id: m[2], name: m[1] });
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Turn each `[name](owl-file:<id>)` reference into a clickable preview anchor. A raw
// `owl-file:` href is stripped by the sanitizer (unknown scheme) — leaving a dead link —
// so we emit a safe `href="#"` anchor carrying the id in `data-owl-file`; the editor
// wires the click to open the attachment.
export function linkifyFileRefs(body) {
  return String(body ?? '').replace(REF_FILE, (whole, name, id) =>
    `<a href="#" class="owl-file-link" data-owl-file="${id}"><span class="owl-file-ico"></span>${escapeHtml(name)}</a>`);
}

// Like inlineImages but async: resolves each owl-img ref's bytes via getBytes(att)
// (which may hit the local cache or Drive). Refs whose bytes are unavailable are left
// as-is so the renderer can show a placeholder.
export async function inlineImagesAsync(body, attachments = [], getBytes) {
  const byId = new Map((attachments || []).map((a) => [a.id, a]));
  const src = String(body ?? '');
  const matches = [...src.matchAll(REF_IMG)];
  if (!matches.length) return src;
  let out = '';
  let last = 0;
  for (const m of matches) {
    const att = byId.get(m[2]);
    const uri = att ? await getBytes(att) : null;
    out += src.slice(last, m.index) + (uri ? m[1] + uri + m[3] : m[0]);
    last = m.index + m[0].length;
  }
  return out + src.slice(last);
}
