import { zipFiles } from './zip.js';
import { unzip } from './unzip.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const IMG_REF = /(!\[[^\]]*\]\()owl-img:([A-Za-z0-9]+)(\))/g;
const FILE_REF = /(\[[^\]]*\]\()owl-file:([A-Za-z0-9]+)(\))/g;

function safeName(value, fallback = 'attachment') {
  const cleaned = String(value || fallback)
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned || fallback;
}

function uniqueAttachmentName(att, used) {
  const original = safeName(att.name, att.mime?.startsWith('image/') ? 'image' : 'attachment');
  const stem = safeName(att.id, 'file').slice(0, 16);
  const base = `${stem}-${original}`;
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    const dot = base.lastIndexOf('.');
    candidate = dot > 0 ? `${base.slice(0, dot)}-${n}${base.slice(dot)}` : `${base}-${n}`;
    n += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function parseDataUri(uri) {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(uri || ''));
  if (!match) throw new Error('Attachment bytes are unavailable');
  const mime = match[1] || 'application/octet-stream';
  if (match[2]) {
    const binary = atob(match[3]);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return { mime, bytes };
  }
  return { mime, bytes: encoder.encode(decodeURIComponent(match[3])) };
}

function bytesToDataUri(bytes, mime) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`;
}

function markdownWithPortableAttachments(body, paths) {
  const replace = (whole, prefix, id, suffix) => {
    const path = paths.get(id);
    return path ? `${prefix}${encodeURI(path)}${suffix}` : whole;
  };
  return String(body || '').replace(IMG_REF, replace).replace(FILE_REF, replace);
}

export function owlNoteFilename(title) {
  return `${safeName(title, 'Untitled note')}.owl-note`;
}

// Build a portable, editable note copy. The manifest keeps OWL's compact attachment
// references; note.md is human-readable and points at the raw attachment files.
export async function buildOwlNotePackage(note, resolveAttachment) {
  const attachments = [];
  const files = [];
  const paths = new Map();
  const used = new Set();

  for (const att of note.attachments || []) {
    const uri = att.dataUri || (resolveAttachment ? await resolveAttachment(att) : null);
    const { mime, bytes } = parseDataUri(uri);
    const path = `attachments/${uniqueAttachmentName(att, used)}`;
    paths.set(att.id, path);
    attachments.push({ id: att.id, name: att.name || 'attachment', mime: att.mime || mime, path });
    files.push({ path, data: bytes });
  }

  const manifest = {
    format: 'owl-note',
    version: 1,
    note: {
      title: String(note.title || ''),
      body: String(note.body || ''),
      createdAt: note.created ?? note.createdAt ?? undefined,
      updatedAt: note.updated ?? note.updatedAt ?? undefined,
    },
    attachments,
  };
  const noteMd = `# ${String(note.title || 'Untitled note').replace(/\r?\n/g, ' ')}\n\n${markdownWithPortableAttachments(note.body, paths)}`;
  return zipFiles([
    { path: 'note.json', data: encoder.encode(JSON.stringify(manifest, null, 2)) },
    { path: 'note.md', data: encoder.encode(noteMd) },
    ...files,
  ]);
}

export async function parseOwlNotePackage(bytes) {
  const entries = await unzip(bytes);
  const byPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
  const manifestBytes = byPath.get('note.json');
  if (!manifestBytes) throw new Error('Invalid .owl-note package: note.json is missing');
  const manifest = JSON.parse(decoder.decode(manifestBytes));
  if (manifest?.format !== 'owl-note' || manifest?.version !== 1 || !manifest.note) {
    throw new Error('Unsupported .owl-note package');
  }

  const attachments = (manifest.attachments || []).map((att) => {
    if (!att?.id || !att?.path || !byPath.has(att.path)) throw new Error('Invalid .owl-note attachment');
    return {
      id: String(att.id),
      name: String(att.name || 'attachment'),
      mime: String(att.mime || 'application/octet-stream'),
      dataUri: bytesToDataUri(byPath.get(att.path), att.mime),
    };
  });
  return {
    title: String(manifest.note.title || ''),
    body: String(manifest.note.body || ''),
    created: manifest.note.createdAt,
    updated: manifest.note.updatedAt,
    attachments,
  };
}
