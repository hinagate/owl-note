// src/lib/enex-import.js
// Pure parser: an Evernote .enex (XML) -> [{ meta:{title,id}, title, body }].
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import SparkMD5 from 'spark-md5';
import { contentHash } from './note.js';

function text(parent, tag) {
  const el = parent.getElementsByTagName(tag)[0];
  return el ? el.textContent : '';
}

// Evernote Web Clipper exports both an offline ENML snapshot and the page it
// came from. Import the useful article text and source link, but not the cached
// page furniture (icons, avatars, tracking images, and other resources).
function webClipSourceUrl(noteEl) {
  const attrs = noteEl.getElementsByTagName('note-attributes')[0];
  if (!attrs) return '';
  const source = text(attrs, 'source').trim().toLowerCase();
  const app = text(attrs, 'source-application').trim().toLowerCase();
  if (!source.startsWith('web.clip') && !app.includes('webclipper')) return '';
  const raw = text(attrs, 'source-url').trim();
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function newTurndown() {
  return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
}

function enmlInner(enml) {
  const m = /<en-note[^>]*>([\s\S]*?)<\/en-note>/i.exec(String(enml || ''));
  return m ? m[1] : String(enml || '');
}

function b64ToBytes(b64) {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function buildResourceMap(noteEl) {
  const map = new Map();
  for (const res of Array.from(noteEl.getElementsByTagName('resource'))) {
    const data = text(res, 'data');
    if (!data) continue;
    const mime = (text(res, 'mime') || 'application/octet-stream').trim();
    const filename = (text(res, 'file-name') || '').trim();
    const hash = SparkMD5.ArrayBuffer.hash(b64ToBytes(data).buffer).toLowerCase();
    map.set(hash, { mime, base64: data.replace(/\s+/g, ''), filename });
  }
  return map;
}

function preprocessMedia(html) {
  return html.replace(/<en-media\b([^>]*?)\/?>/gi, (_m, attrs) => {
    const hash = (/hash\s*=\s*"([^"]*)"/i.exec(attrs) || [])[1] || '';
    return `<img data-enex-hash="${hash}">`;
  });
}

function addMediaRule(td, resByHash) {
  td.addRule('enexMedia', {
    filter: (node) => node.nodeName === 'IMG' && node.hasAttribute('data-enex-hash'),
    replacement: (_content, node) => {
      const res = resByHash.get((node.getAttribute('data-enex-hash') || '').toLowerCase());
      if (!res) return '';
      const name = res.filename || 'attachment';
      if (res.mime.startsWith('image/')) {
        return `![${name}](data:${res.mime};base64,${res.base64})`;
      }
      return `[attachment: ${name}]`;
    },
  });
}

function addCodeBlockRule(td) {
  td.addRule('enexCodeBlock', {
    filter: (node) =>
      node.nodeName === 'DIV' && /en-codeblock\s*:\s*true/i.test(node.getAttribute('style') || ''),
    replacement: (_content, node) => {
      const blocks = Array.from(node.children).filter((c) => /^(DIV|P)$/.test(c.nodeName));
      let lines;
      if (blocks.length) {
        lines = blocks.map((c) => c.textContent.replace(/\u00a0/g, ' '));
      } else {
        let text = '';
        for (const child of node.childNodes) {
          if (child.nodeName === 'BR') text += '\n';
          else text += child.textContent;
        }
        lines = text.replace(/\u00a0/g, ' ').split('\n');
      }
      const code = lines.join('\n').replace(/\n+$/, '');
      return '\n\n```\n' + code + '\n```\n\n';
    },
  });
}

function enmlToMarkdown(enml, resByHash, { dropImages = false } = {}) {
  const td = newTurndown();
  td.use(gfm);
  addCodeBlockRule(td);
  if (dropImages) {
    // Full-page clips also contain ordinary <img src="data:..."> elements in
    // addition to en-media resources. Neither should become an attachment.
    td.addRule('webClipImages', { filter: 'img', replacement: () => '' });
  } else if (resByHash) addMediaRule(td, resByHash);
  return td.turndown(preprocessMedia(enmlInner(enml))).trim();
}

export function parseEnexNotes(xmlText) {
  const doc = new DOMParser().parseFromString(String(xmlText ?? ''), 'text/xml');
  const out = [];
  for (const noteEl of Array.from(doc.getElementsByTagName('note'))) {
    const title = (text(noteEl, 'title') || 'Untitled').trim() || 'Untitled';
    const created = (text(noteEl, 'created') || '').trim();
    const sourceUrl = webClipSourceUrl(noteEl);
    // A web clip's resources are a browser-page cache, not user attachments.
    // Avoid even decoding/hashing them; unmatched en-media nodes drop out while
    // Turndown preserves the snapshot's readable text and ordinary links.
    const resByHash = sourceUrl ? null : buildResourceMap(noteEl);
    const converted = enmlToMarkdown(text(noteEl, 'content'), resByHash, { dropImages: !!sourceUrl });
    const body = sourceUrl
      ? [`Source: <${sourceUrl}>`, converted].filter(Boolean).join('\n\n')
      : converted;
    const id = 'enex-' + contentHash(created + ' ' + title + ' ' + String(body.length));
    out.push({ meta: { title, id }, title, body });
  }
  return out;
}
