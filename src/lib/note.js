export function contentHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

export function extractTitle(body) {
  for (const line of String(body).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    return t.replace(/^#+\s*/, '').slice(0, 120) || 'Untitled';
  }
  return 'Untitled';
}

export function createNote({ title, body = '', attachments = [] } = {}) {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: (typeof title === 'string' && title.trim()) ? title : extractTitle(body),
    body,
    attachments,
    created: now, // stable creation time and recency key (survives reloads)
    updated: now,
    version: 1,
    hash: contentHash(body),
  };
}

export function withUpdatedBody(note, body, attachments) {
  return {
    ...note,
    body,
    attachments,
    title: extractTitle(body),
    updated: Date.now(),
    version: note.version + 1,
    hash: contentHash(body),
  };
}

// Like withUpdatedBody but the title is explicit (user-edited) rather than
// derived from the body. A blank title falls back to the extracted heading.
export function withUpdatedContent(note, { title, body, attachments }) {
  return {
    ...note,
    body,
    attachments: attachments ?? note.attachments,
    title: (typeof title === 'string' && title.trim()) ? title : extractTitle(body),
    updated: Date.now(),
    version: note.version + 1,
    hash: contentHash(body),
  };
}

// Flip pin without touching content — version/hash unchanged (pinning is not an edit).
export function withPinned(note, pinned) {
  return { ...note, pinned: !!pinned };
}

// Two-tier order for the note list: pinned first, then every unpinned note.
// Both groups are newest-first by note.created, falling back to the bookmark's
// dateAdded for older notes. Creation source (editor, context menu, or sync)
// deliberately has no effect, so a fresh capture becomes the top unpinned note.
export function orderNotes(notes) {
  const rank = (n) => (n.pinned ? 0 : 1);
  const recency = (n) => n.created ?? n.dateAdded ?? 0; // newest first
  return notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => {
      const ra = rank(a.n);
      const rb = rank(b.n);
      if (ra !== rb) return ra - rb;
      const byRecency = recency(b.n) - recency(a.n);
      return byRecency !== 0 ? byRecency : a.i - b.i; // stable tiebreak when equal
    })
    .map((x) => x.n);
}
