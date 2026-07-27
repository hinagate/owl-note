// src/app/format-bar.js
// The editor's formatting row, as DATA (the ask-actions.js idiom): one
// descriptor per button; renderFormatBar draws exactly what it is handed.
// Adding a button = appending a descriptor. The bar knows nothing about the
// textarea — the host supplies apply(run), which routes the pure edit from
// src/lib/format.js through the editor's undo-preserving insertText.
import { toggleInline, cycleHeading, toggleLinePrefix, toggleOrderedList, insertLink, insertTable } from '../lib/format.js';

export function formatActions() {
  return [
    { id: 'bold', label: 'B', title: 'Bold (Ctrl+B)', shortcut: 'b', run: (b, s, e) => toggleInline(b, s, e, { left: '**', right: '**' }) },
    { id: 'italic', label: 'I', title: 'Italic (Ctrl+I)', shortcut: 'i', run: (b, s, e) => toggleInline(b, s, e, { left: '*', right: '*' }) },
    { id: 'underline', label: 'U', title: 'Underline (Ctrl+U)', shortcut: 'u', run: (b, s, e) => toggleInline(b, s, e, { left: '<u>', right: '</u>' }) },
    { id: 'strike', label: 'S', title: 'Strikethrough', run: (b, s, e) => toggleInline(b, s, e, { left: '~~', right: '~~' }) },
    { id: 'highlight', label: '🖍', title: 'Highlight', run: (b, s, e) => toggleInline(b, s, e, { left: '<mark>', right: '</mark>' }) },
    { divider: true },
    { id: 'heading', label: 'H', title: 'Heading — cycles # · ## · ###', run: (b, s) => cycleHeading(b, s) },
    { id: 'bullet-list', label: '•', title: 'Bullet list', run: (b, s, e) => toggleLinePrefix(b, s, e, 'bullet') },
    { id: 'ordered-list', label: '1.', title: 'Numbered list', run: (b, s, e) => toggleOrderedList(b, s, e) },
    { id: 'quote', label: '❝', title: 'Quote', run: (b, s, e) => toggleLinePrefix(b, s, e, 'quote') },
    { id: 'link', label: '🔗', title: 'Link (Ctrl+K)', shortcut: 'k', run: (b, s, e) => insertLink(b, s, e) },
    { id: 'table', label: '▦', title: 'Table — build one from the selected lines, or add a column / repair the table you are in', run: (b, s, e) => insertTable(b, s, e) },
  ];
}

export function renderFormatBar(container, { apply, actions = formatActions() }) {
  container.innerHTML = '';
  for (const a of actions) {
    if (a.divider) {
      const d = document.createElement('span');
      d.className = 'format-divider';
      container.appendChild(d);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `format-btn format-${a.id}`;
    btn.textContent = a.label;
    btn.title = a.title;
    btn.setAttribute('aria-label', a.title);
    // mousedown + preventDefault (NOT click): the textarea keeps focus and its
    // selection, and no blur-autosave fires mid-format.
    btn.addEventListener('mousedown', (ev) => { ev.preventDefault(); apply(a.run); });
    container.appendChild(btn);
  }
}
