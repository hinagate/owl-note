// src/lib/markdown.js
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedKatex from 'marked-katex-extension';
import hljs from 'highlight.js';
import DOMPurify from 'dompurify';

const marked = new Marked(
  markedHighlight({
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language }).value;
    },
  }),
);

// Math support: `$$...$$` renders as a display block, `$...$` inline. KaTeX turns
// each into self-contained HTML + MathML (no runtime needed in the page), which
// is then sanitized like the rest of the markdown below.
//
// Delimiter caveat: with single-`$` inline math, a currency amount written *before*
// an equation in the same paragraph ("costs $5, and $P=P_0e^{rt}$") gets greedily
// paired with the equation's opening `$`, producing invalid TeX. `throwOnError:false`
// keeps that from crashing the preview, and softenKatexErrors() below turns the
// resulting error span back into plain text so the note is never visually mangled —
// the user recovers the equation by escaping the literal dollar as `\$`.
marked.use(
  markedKatex({
    throwOnError: false, // invalid/mis-paired TeX renders as an error span, never throws
    nonStandard: false,  // strict $-delimiters (lookahead) so "$5 and $10" alone stays text
    strict: false,       // don't spam the console on e.g. CJK inside math mode
    output: 'htmlAndMathml',
  }),
);

// KaTeX output is MathML + spans carrying inline `style` (heights, kerning). DOMPurify
// keeps presentation MathML and styled spans by default, but NOT <semantics>/<annotation>
// (the branch holding KaTeX's copyable/screen-reader TeX source) — allowlist those so the
// math survives intact. Everything else is still sanitized, so a <script> smuggled next to
// the math is stripped as usual.
const SANITIZE_OPTS = {
  ADD_TAGS: ['semantics', 'annotation'],
  ADD_ATTR: ['encoding'],
};

// The preview lives inside the extension page, so clicking a normal link would navigate the
// whole app away. Open external (http/https) links in a new tab instead. owl-file: links use
// href="#" and are handled in JS, so they're left alone. (Guarded: DOMPurify only binds
// addHook when a DOM is present, so this no-ops in the pure-node test env.)
if (typeof DOMPurify.addHook === 'function') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && /^https?:\/\//i.test(node.getAttribute('href') || '')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

export function renderMarkdown(body) {
  const clean = DOMPurify.sanitize(marked.parse(String(body ?? '')), SANITIZE_OPTS);
  return softenKatexErrors(clean);
}

// KaTeX (throwOnError:false) emits `<span class="katex-error" style="color:#cc0000">`
// for invalid or mis-paired TeX. Left alone, a stray `$` (e.g. currency followed by an
// equation) swallows the prose between them into a red error box. Replace each error
// span with its own text content so the worst case degrades to plain, readable text.
// No-op for the common case (valid math has no error span), and re-serialization via
// textContent -> innerHTML re-escapes, so this introduces no sanitization hole.
function softenKatexErrors(html) {
  if (!html.includes('katex-error')) return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const el of doc.querySelectorAll('.katex-error')) {
    el.replaceWith(doc.createTextNode(el.textContent));
  }
  return doc.body.innerHTML;
}
