// src/lib/markdown-export.js
// Pure transform: decoded notes + folder tree -> [{ path, text }] for the zip.
// No chrome/DOM dependencies.

export function slug(name) {
  const cleaned = String(name ?? '')
    .replace(/[/\\:*?"<>|]/g, '') // path-illegal characters
    .replace(/[\u0000-\u001f]/g, '') // control characters
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // Windows disallows a trailing dot or space
  return cleaned || 'untitled';
}

function yamlString(s) {
  return JSON.stringify(String(s ?? ''));
}

function folderPath(folderId, folderById, rootId) {
  if (folderId === rootId) return 'Inbox';
  const segments = [];
  const guard = new Set();
  let cur = folderById.get(folderId);
  while (cur && cur.id !== rootId && !guard.has(cur.id)) {
    guard.add(cur.id);
    segments.unshift(slug(cur.title));
    cur = folderById.get(cur.parentId);
  }
  return segments.length ? segments.join('/') : 'Inbox';
}

function uniqueName(dir, base, used) {
  let set = used.get(dir);
  if (!set) { set = new Set(); used.set(dir, set); }
  let name = base;
  if (set.has(name.toLowerCase())) {
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    let i = 2;
    do { name = `${stem} ${i}${ext}`; i++; } while (set.has(name.toLowerCase()));
  }
  set.add(name.toLowerCase());
  return name;
}

export function buildMarkdownExport(notes, folders, rootId) {
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const used = new Map();
  const out = [];
  for (const note of notes) {
    const dir = folderPath(note.folderId, folderById, rootId);
    const folder = folderById.get(note.folderId);
    const notebook = note.folderId === rootId || !folder ? 'Inbox' : folder.title;
    const filename = uniqueName(dir, `${slug(note.title)}.md`, used);
    const fm = `---\ntitle: ${yamlString(note.title)}\nnotebook: ${yamlString(notebook)}\nid: ${yamlString(note.id)}\n---\n\n`;
    out.push({ path: `${dir}/${filename}`, text: fm + (note.body ?? '') });
  }
  return out;
}
