// src/lib/docx-import.js
// Convert a Word .docx (ArrayBuffer) to Markdown: mammoth -> HTML -> turndown.
// mammoth is NOT bundled — it ships as a separate vendored <script> (window.mammoth),
// so it stays an official, hash-matchable library and its bluebird `new Function` code
// never gets minified together with our app. See app.html + esbuild.config.mjs.
import { htmlToMarkdown } from './html-to-markdown.js';

export async function docxToMarkdown(arrayBuffer) {
  const mammoth = globalThis.mammoth; // vendored separately (browser) / test global (node)
  if (!mammoth) throw new Error('mammoth library is not loaded');
  // Browser build (extension) accepts { arrayBuffer }; node build (Vitest) accepts { buffer }.
  const input = typeof Buffer !== 'undefined'
    ? { buffer: Buffer.from(arrayBuffer) }   // Node/Vitest: mammoth's node build wants buffer
    : { arrayBuffer };                        // extension: mammoth's browser build wants arrayBuffer
  const html = (await mammoth.convertToHtml(input)).value;
  return htmlToMarkdown(html);
}
