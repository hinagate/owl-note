// Wraps words in the rendered preview with <ruby> so a reading sits above each one.
// Runs as a post-render DOM decorator, alongside decorateCodeBlocks and friends — i.e.
// AFTER DOMPurify. It builds nodes with DOM APIs and never assigns innerHTML, so it
// needs no change to the sanitizer's allowlist and can introduce no injection.
//
// Language-agnostic on purpose: phase 1 supplies English IPA and phase 2 will supply
// kana for kanji. Only the `reading` function differs — this walker does not change.

import { tokenize } from './phonetics.js';

// Regions where an overhead reading is wrong, not merely unhelpful:
//   code/pre/kbd/samp — source text, where a pronunciation is meaningless
//   .katex            — math; annotating its glyphs would wreck the layout
//   ruby              — already annotated; nesting ruby renders unpredictably
const SKIP = 'code, pre, kbd, samp, .katex, ruby';

/**
 * @param {Element} root subtree to annotate, mutated in place
 * @param {(word: string) => string|null} reading returns the annotation, or null to skip
 * @returns {number} how many words were annotated
 */
export function annotateRuby(root, reading) {
  if (!root || typeof reading !== 'function') return 0;

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
    const runs = tokenize(node.nodeValue);
    const readings = runs.map((run) => (run.isWord ? reading(run.text) : null));
    // Leaving an untouched node alone keeps the DOM (and the user's selection) stable
    // across the many re-renders that typing causes.
    if (!readings.some(Boolean)) continue;

    const fragment = document.createDocumentFragment();
    runs.forEach((run, i) => {
      if (!readings[i]) {
        fragment.append(run.text);
        return;
      }
      const ruby = document.createElement('ruby');
      ruby.append(run.text);
      const rt = document.createElement('rt');
      rt.textContent = readings[i];
      ruby.append(rt);
      fragment.append(ruby);
      annotated += 1;
    });
    node.parentNode?.replaceChild(fragment, node);
  }
  return annotated;
}
