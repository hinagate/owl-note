// Wraps words in the rendered preview with <ruby> so a reading sits above each one.
// Runs as a post-render DOM decorator, alongside decorateCodeBlocks and friends — i.e.
// AFTER DOMPurify. It builds nodes with DOM APIs and never assigns innerHTML, so it
// needs no change to the sanitizer's allowlist and can introduce no injection.
//
// Language-agnostic on purpose: the caller supplies a segmenter and this walker never
// learns which language it is annotating. English IPA, Japanese furigana and Cantonese
// Jyutping all arrive here as the same {text, reading} runs.
//
// Segmenting is the caller's job rather than this file's because CJK word boundaries come
// from the dictionary, not from the text — see makeSegmenter in ./segment.js.

// Regions where an overhead reading is wrong, not merely unhelpful:
//   code/pre/kbd/samp — source text, where a pronunciation is meaningless
//   .katex            — math; annotating its glyphs would wreck the layout
//   ruby              — already annotated; nesting ruby renders unpredictably
//   .mermaid-diagram  — SVG text laid out to the pixel; HTML ruby inside it is invalid
const SKIP = 'code, pre, kbd, samp, .katex, ruby, .mermaid-diagram';

// Every ruby is white-space: nowrap (app.css), so Chrome cannot break a word and its reading
// across two lines. The cost: Chrome stops treating the space between two such rubies as a
// place to break. Lines still wrapped, but only through the preview's emergency
// overflow-wrap — until a comma or full stop offered a real break, which Chrome then took
// however early it came: "Second," alone on a line, the rest of the sentence on the next.
// An explicit <wbr> after each space, and between two rubies that touch, gives back every
// break the plain text had. It adds no text, so copying the preview is unchanged.

// Where a line of speech ends: at the end of one of these, or where one begins.
const BLOCK = 'p, li, h1, h2, h3, h4, h5, h6, td, th, dt, dd, blockquote, div, section, article, summary, figcaption, caption, pre, ul, ol, dl, table, details, hr, br';

/**
 * Whether nothing more is said after this text in its paragraph: the last text of a
 * heading, a list item or a table cell, or the text before a line break. The segmenter
 * cannot see past its own text node, and "Who is it for" ends differently from "for you".
 */
function endsItsBlock(node, root) {
  for (let at = node; at && at !== root; at = at.parentNode) {
    for (let next = at.nextSibling; next; next = next.nextSibling) {
      if (next.nodeType === Node.TEXT_NODE) {
        if (next.nodeValue.trim()) return false;
      } else if (next.nodeType === Node.ELEMENT_NODE) {
        if (next.matches(BLOCK)) return true;
        if (next.textContent.trim() || next.matches('img') || next.querySelector('img')) return false;
      }
    }
    if (at.parentNode?.nodeType === Node.ELEMENT_NODE && at.parentNode.matches(BLOCK)) return true;
  }
  return true;
}

/**
 * A gap's text. Two kinds stay in the text but go in an element of their own, so that the
 * stylesheet can draw a mark there and what a reader copies is unchanged: the spaces
 * between two words said as one (run.link), and a bar the writer typed to mark a pause
 * (run.pause).
 */
function appendGap(fragment, run) {
  if (run.link) {
    // The spaces between two words said as one: the stylesheet draws an arc under them.
    const link = document.createElement('span');
    link.className = 'word-link';
    link.textContent = run.text;
    fragment.append(link);
    return;
  }
  const at = run.pause ? run.text.indexOf('|') : -1;
  if (at < 0) { fragment.append(run.text); return; }
  const bar = document.createElement('span');
  bar.className = 'pause-bar';
  bar.textContent = '|';
  if (at > 0) fragment.append(run.text.slice(0, at));
  fragment.append(bar);
  if (at < run.text.length - 1) fragment.append(run.text.slice(at + 1));
}

/**
 * @param {Element} root subtree to annotate, mutated in place
 * @param {(text: string, context: { endsBlock: boolean }) => { text: string, reading: string|null, lang?: string, pause?: boolean, link?: boolean, parts?: { text: string, cue: string|null, stressed?: boolean, held?: boolean, fall?: boolean }[] }[]} segment
 *   splits text into runs, each carrying its reading or null and optionally the BCP-47
 *   language of that reading; the runs must rebuild the text exactly. A run may also
 *   split its reading into `parts`; each part with a `cue`, `stressed`, `held` or `fall`
 *   is wrapped in <span class="cue-… stressed held fall"> so the stylesheet can mark it. Parts that do not
 *   rebuild the reading are ignored rather than trusted. A run without a reading may carry
 *   `pause`: the writer typed a bar there, and <span class="pause-bar"> holds it. Or
 *   `link`: the words either side are said as one, and <span class="word-link"> holds
 *   the spaces between them.
 *   `context.endsBlock` tells the segmenter that nothing follows the text in its paragraph.
 * @returns {number} how many runs were annotated
 */
export function annotateRuby(root, segment) {
  if (!root || typeof segment !== 'function') return 0;

  // Collect first, mutate second: replacing nodes while the TreeWalker is live
  // invalidates its position and silently skips siblings.
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      return node.parentElement?.closest(SKIP)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) targets.push(node);

  let annotated = 0;
  for (const node of targets) {
    const runs = segment(node.nodeValue, { endsBlock: endsItsBlock(node, root) });
    // Leaving an untouched node alone keeps the DOM (and the user's selection) stable
    // across the many re-renders that typing causes.
    if (!runs.some((run) => run.reading)) continue;

    const fragment = document.createDocumentFragment();
    runs.forEach((run, i) => {
      if (!run.reading) {
        appendGap(fragment, run);
        if (/\s$/.test(run.text)) fragment.append(document.createElement('wbr'));
        return;
      }
      const ruby = document.createElement('ruby');
      // Tagging the language lets the stylesheet size furigana and Jyutping differently from
      // IPA, and tells the font matcher and screen readers which script they are in.
      if (run.lang) ruby.lang = run.lang;
      ruby.append(run.text);
      const rt = document.createElement('rt');
      if (Array.isArray(run.parts) && run.parts.map((p) => p.text).join('') === run.reading) {
        // Cued or stressed pieces of the reading become spans the stylesheet can mark; the
        // rest stays text. The check above guarantees the rt still says exactly the reading.
        for (const part of run.parts) {
          if (!part.cue && !part.stressed && !part.held && !part.fall) { rt.append(part.text); continue; }
          const span = document.createElement('span');
          span.className = [part.cue && `cue-${part.cue}`, part.stressed && 'stressed', part.held && 'held', part.fall && 'fall']
            .filter(Boolean).join(' ');
          span.textContent = part.text;
          rt.append(span);
        }
      } else {
        rt.textContent = run.reading;
      }
      ruby.append(rt);
      fragment.append(ruby);
      // Two readings side by side — a hyphenated part (high-) and the next, or two Chinese
      // characters — may break between them, as the text would without the readings.
      if (runs[i + 1]?.reading) fragment.append(document.createElement('wbr'));
      annotated += 1;
    });
    node.parentNode?.replaceChild(fragment, node);
  }
  return annotated;
}
