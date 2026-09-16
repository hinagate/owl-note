// src/lib/office-clipboard.js
// Turn Word/Excel clipboard HTML into Markdown.
//
// Copying a range in Excel, or a table in Word, puts THREE things on the clipboard: the
// real HTML, a tab-separated text/plain rendering, and a BITMAP of the selection. Chrome
// exposes that bitmap as an `image/png` clipboard file, so a paste handler that looks for
// files first turns a spreadsheet into a picture nobody can edit. The HTML is the only
// flavour that still knows where the rows and columns were, so it wins whenever it holds
// anything writable as Markdown.
//
// Deliberately narrow: this runs only on clipboard HTML that Office actually wrote. Every
// other paste — a web page, another editor, OWL-Note itself — keeps the browser's normal
// behaviour, because converting arbitrary HTML to Markdown would mangle text that was
// already Markdown.
import { htmlToMarkdown } from './html-to-markdown.js';

// Word and Excel (and the WPS/LibreOffice builds that copy in their format) always stamp
// the clipboard with at least one of these: the Office XML namespaces on <html>, a ProgId
// or Generator <meta>, or their layout class names (MsoNormal, xl65).
const OFFICE_MARKERS = /urn:schemas-microsoft-com:office|schemas-microsoft-com:vml|(?:Excel\.Sheet|Word\.Document)|Microsoft (?:Excel|Word)|class=["']?Mso|class=["']?xl\d/i;

/** @param {string} html raw `text/html` clipboard flavour */
export function isOfficeClipboardHtml(html) {
  return OFFICE_MARKERS.test(String(html || ''));
}

/**
 * @param {string} html raw `text/html` clipboard flavour
 * @returns {string} Markdown, or '' when this is not Office HTML or holds nothing to write
 *   — both cases mean the caller should fall back to its normal paste path.
 */
export function officeClipboardMarkdown(html) {
  const raw = String(html || '');
  if (!isOfficeClipboardHtml(raw)) return '';
  try {
    const doc = new DOMParser().parseFromString(raw, 'text/html');
    // Office ships its entire stylesheet inline. Left in the body it would turndown into
    // pages of CSS; <col>/<colgroup> carry only pixel widths and confuse the GFM table rule.
    for (const el of doc.querySelectorAll('style, script, link, meta, title, xml, col, colgroup')) el.remove();
    // Namespaced tags (o:p, w:sdt, st1:place, v:shape) are layout and revision bookkeeping.
    // Unwrap rather than remove: some of them do wrap real text.
    for (const el of [...doc.querySelectorAll('*')]) {
      if (el.tagName.includes(':')) el.replaceWith(...el.childNodes);
    }
    // Every picture points at a temp file Office wrote next to the clipboard
    // (file:///…/clip_image001.png), which this extension can never read. Dropping them
    // beats a body full of broken images — and a copied chart or picture, whose HTML is
    // nothing BUT such an <img>, then converts to '' and correctly falls back to the bitmap.
    for (const img of [...doc.querySelectorAll('img')]) {
      if (!/^(?:https?:|data:)/i.test(img.getAttribute('src') || '')) img.remove();
    }
    return htmlToMarkdown(doc.body.innerHTML)
      .replace(/ /g, ' ')   // Office pads cells with non-breaking spaces
      .replace(/[ \t]+$/gm, '')
      .trim();
  } catch {
    return ''; // malformed clipboard HTML falls back to the normal paste path
  }
}
