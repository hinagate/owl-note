// src/lib/html-to-markdown.js
// Shared HTML -> Markdown conversion (turndown + GFM), used by the .docx importer and by
// the Word/Excel clipboard paste path. Both start from HTML that was written for layout,
// not for structure, so they need the same table repair before turndown sees it.

import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// Word and Excel both emit tables as <td><p>…</p></td> with no <th> header row, which
// turndown-gfm leaves as raw <table> HTML. Unwrap a single <p> inside each cell, and
// promote the first row's <td>s to <th> when the table has no header — then turndown-gfm
// yields a GFM table.
export function gfmFriendlyTables(html) {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  for (const table of doc.querySelectorAll('table')) {
    for (const p of [...table.querySelectorAll('td > p, th > p')]) p.replaceWith(...p.childNodes);
    if (!table.querySelector('th')) {
      const firstRow = table.querySelector('tr');
      if (firstRow) {
        for (const cell of [...firstRow.children]) {
          if (cell.tagName === 'TD') {
            const th = doc.createElement('th');
            th.innerHTML = cell.innerHTML;
            cell.replaceWith(th);
          }
        }
      }
    }
  }
  return doc.body.innerHTML;
}

/** @param {string} html @returns {string} Markdown, trimmed */
export function htmlToMarkdown(html) {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  return td.turndown(gfmFriendlyTables(html)).trim();
}
