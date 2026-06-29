// src/lib/quick-note.js
// Build a quick-add note from captured page context. Pure.
export function buildQuickNote({ title = '', url = '', selection = '' } = {}) {
  const sel = String(selection ?? '').trim();
  const link = url ? `[${(title || url).trim()}](${url})` : '';
  const body = [sel, link].filter(Boolean).join('\n\n');
  return { title: String(title ?? '').trim(), body };
}
