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

function enmlToMarkdown(enml, resByHash) {
  const td = newTurndown();
  td.use(gfm);
  addCodeBlockRule(td);
  if (resByHash) addMediaRule(td, resByHash);
  return td.turndown(preprocessMedia(enmlInner(enml))).trim();
}

export function parseEnexNotes(xmlText) {
  const doc = new DOMParser().parseFromString(String(xmlText ?? ''), 'text/xml');
  const out = [];
  for (const noteEl of Array.from(doc.getElementsByTagName('note'))) {
    const title = (text(noteEl, 'title') || 'Untitled').trim() || 'Untitled';
    const created = (text(noteEl, 'created') || '').trim();
    const resByHash = buildResourceMap(noteEl);
    const body = enmlToMarkdown(text(noteEl, 'content'), resByHash);
    const id = 'enex-' + contentHash(created + ' ' + title + ' ' + String(body.length));
    out.push({ meta: { title, id }, title, body });
  }
  return out;
}
