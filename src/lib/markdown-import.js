// src/lib/markdown-import.js
// Pure parser: a markdown file's text + filename -> { meta, title, body }.

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let val = kv[2].trim();
    if (val.startsWith('"')) {
      try { val = JSON.parse(val); } catch { /* keep raw on malformed quotes */ }
    }
    meta[kv[1]] = val;
  }
  const body = text.slice(m[0].length).replace(/^\r?\n/, ''); // drop the single blank line the exporter writes
  return { meta, body };
}

function firstHeading(body) {
  for (const line of body.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (h) return h[1];
  }
  return null;
}

export function parseMarkdownNote(text, filename) {
  const { meta, body } = parseFrontmatter(String(text ?? ''));
  const stem = String(filename ?? '').replace(/^.*[\\/]/, '').replace(/\.md$/i, '');
  const title =
    (meta.title && String(meta.title).trim()) ||
    firstHeading(body) ||
    stem ||
    'Untitled';
  return { meta: { title: meta.title, notebook: meta.notebook, id: meta.id }, title, body };
}
