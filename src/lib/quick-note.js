// src/lib/quick-note.js
// Build a quick-add note from captured page context. Rich Markdown comes from a
// page-side selection capture; restricted pages fall back to a readable quote.
function quotedSelection(value) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return '';
  return text.replace(/\n{3,}/g, '\n\n').split('\n').map((line) => line ? `> ${line}` : '>').join('\n');
}

function sourceLine(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return `Source: <${url.href}>`;
  } catch {
    return '';
  }
}

export function buildQuickNote({ title = '', url = '', selection = '', selectionMarkdown = '' } = {}) {
  const rich = String(selectionMarkdown ?? '').trim();
  const content = rich || quotedSelection(selection);
  const body = [content, sourceLine(url)].filter(Boolean).join('\n\n');
  return { title: String(title ?? '').replace(/\s+/g, ' ').trim(), body };
}
