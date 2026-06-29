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
