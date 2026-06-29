// src/lib/docx-import.js
// Convert a Word .docx (ArrayBuffer) to Markdown: mammoth -> HTML -> turndown.
// mammoth is NOT bundled — it ships as a separate vendored <script> (window.mammoth),
// so it stays an official, hash-matchable library and its bluebird `new Function` code
// never gets minified together with our app. See app.html + esbuild.config.mjs.
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

// mammoth emits tables as <td><p>…</p></td> with no <th> header row, which turndown-gfm
// leaves as raw <table> HTML. Unwrap a single <p> inside each cell, and promote the first
// row's <td>s to <th> when the table has no header — then turndown-gfm yields a GFM table.
function gfmFriendlyTables(html) {
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

export async function docxToMarkdown(arrayBuffer) {
  const mammoth = globalThis.mammoth; // vendored separately (browser) / test global (node)
  if (!mammoth) throw new Error('mammoth library is not loaded');
  // Browser build (extension) accepts { arrayBuffer }; node build (Vitest) accepts { buffer }.
  const input = typeof Buffer !== 'undefined'
    ? { buffer: Buffer.from(arrayBuffer) }   // Node/Vitest: mammoth's node build wants buffer
    : { arrayBuffer };                        // extension: mammoth's browser build wants arrayBuffer
  const html = (await mammoth.convertToHtml(input)).value;
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);
  return td.turndown(gfmFriendlyTables(html)).trim();
}
