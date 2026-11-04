export function searchNotes(notes, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [...notes];
  const scored = [];
  for (const n of notes) {
    const inTitle = (n.title || '').toLowerCase().includes(q);
    const inBody = (n.body || '').toLowerCase().includes(q);
    if (inTitle || inBody) scored.push({ n, score: inTitle ? 0 : 1 });
  }
  return scored.sort((a, b) => a.score - b.score).map((s) => s.n);
}

// Where the keyword first occurs in `text`, ignoring case, as real offsets into it. A
// regular expression rather than comparing lowercased copies: lowercasing can change a
// string's length ('İ' becomes two characters), which would shift every later offset.
export function findKeyword(text, query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu');
  const match = pattern.exec(String(text ?? ''));
  return match ? { start: match.index, end: match.index + match[0].length } : null;
}
