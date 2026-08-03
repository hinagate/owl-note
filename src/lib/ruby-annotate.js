// Wraps words in the rendered preview with <ruby> so a reading sits above each one.
// Runs as a post-render DOM decorator, alongside decorateCodeBlocks and friends — i.e.
// AFTER DOMPurify. It builds nodes with DOM APIs and never assigns innerHTML, so it
// needs no change to the sanitizer's allowlist and can introduce no injection.
//
// Language-agnostic on purpose: the caller supplies a segmenter and this walker never
// learns which language it is annotating. English IPA, Japanese furigana and Mandarin
// pinyin all arrive here as the same {text, reading} runs.
//
// Segmenting is the caller's job rather than this file's because CJK word boundaries come
// from the dictionary, not from the text — see makeSegmenter in ./segment.js.

// Regions where an overhead reading is wrong, not merely unhelpful:
//   code/pre/kbd/samp — source text, where a pronunciation is meaningless
//   .katex            — math; annotating its glyphs would wreck the layout
//   ruby              — already annotated; nesting ruby renders unpredictably
const SKIP = 'code, pre, kbd, samp, .katex, ruby';

/**
 * @param {Element} root subtree to annotate, mutated in place
 * @param {(text: string) => { text: string, reading: string|null, lang?: string }[]} segment
 *   splits text into runs, each carrying its reading or null and optionally the BCP-47
 *   language of that reading; the runs must rebuild the text exactly
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
    const runs = segment(node.nodeValue);
    // Leaving an untouched node alone keeps the DOM (and the user's selection) stable
    // across the many re-renders that typing causes.
    if (!runs.some((run) => run.reading)) continue;

    const fragment = document.createDocumentFragment();
    for (const run of runs) {
      if (!run.reading) {
        fragment.append(run.text);
        continue;
      }
      const ruby = document.createElement('ruby');
      // Tagging the language lets the stylesheet size furigana and pinyin differently from
      // IPA, and tells the font matcher and screen readers which script they are in.
      if (run.lang) ruby.lang = run.lang;
      ruby.append(run.text);
      const rt = document.createElement('rt');
      rt.textContent = run.reading;
      ruby.append(rt);
      fragment.append(ruby);
      annotated += 1;
    }
    node.parentNode?.replaceChild(fragment, node);
  }
  return annotated;
}
