import { describe, it, expect, beforeEach } from 'vitest';
import { annotateRuby } from '../src/lib/ruby-annotate.js';

const READINGS = { phonics: 'ˈfɑnɪks', is: 'ɪz', useful: 'ˈjusfəl', cat: 'kæt' };

// A minimal stand-in for makeSegmenter: word runs carry a reading, gaps carry null. The
// annotator only cares that the runs rebuild the text, not how they were chosen.
const segment = (text) => String(text)
  .split(/([A-Za-z]+)/)
  .filter(Boolean)
  .map((piece) => ({ text: piece, reading: READINGS[piece.toLowerCase()] ?? null }));

let root;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

const html = (markup) => { root.innerHTML = markup; return root; };

describe('annotateRuby', () => {
  it('wraps known words and leaves the visible text identical', () => {
    annotateRuby(html('<p>Phonics is useful</p>'), segment);
    // textContent interleaves each word with its rt; the spacing between words survives.
    expect(root.textContent).toBe('Phonicsˈfɑnɪks isɪz usefulˈjusfəl');
    expect(root.querySelectorAll('ruby')).toHaveLength(3);
    expect(root.querySelector('ruby rt').textContent).toBe('ˈfɑnɪks');
  });

  it('leaves unknown words as bare text', () => {
    annotateRuby(html('<p>Phonics helps covid research</p>'), segment);
    expect(root.querySelectorAll('ruby')).toHaveLength(1);
    expect(root.querySelector('p').firstElementChild.tagName).toBe('RUBY');
  });

  it('preserves punctuation and spacing exactly', () => {
    annotateRuby(html('<p>  Phonics, is: useful!  </p>'), segment);
    const flat = [...root.querySelector('p').childNodes]
      .map((n) => (n.nodeName === 'RUBY' ? n.firstChild.nodeValue : n.nodeValue)).join('');
    expect(flat).toBe('  Phonics, is: useful!  ');
  });

  it('never annotates inside code, pre or math', () => {
    annotateRuby(html('<p><code>phonics</code> <pre>is useful</pre> <span class="katex">cat</span></p>'), segment);
    expect(root.querySelectorAll('ruby')).toHaveLength(0);
  });

  it('annotates around a skipped island without disturbing it', () => {
    annotateRuby(html('<p>The cat runs <code>cat</code> here</p>'), segment);
    expect(root.querySelectorAll('ruby')).toHaveLength(1);
    expect(root.querySelector('code').textContent).toBe('cat');
  });

  it('does not nest ruby when run twice over the same tree', () => {
    const el = html('<p>Phonics is useful</p>');
    annotateRuby(el, segment);
    annotateRuby(el, segment);
    expect(root.querySelectorAll('ruby')).toHaveLength(3);
    expect(root.querySelectorAll('ruby ruby')).toHaveLength(0);
  });

  it('reports how many words it annotated', () => {
    expect(annotateRuby(html('<p>Phonics is useful</p>'), segment)).toBe(3);
    expect(annotateRuby(html('<p>nothing known here</p>'), segment)).toBe(0);
  });

  it('walks into nested markup and across siblings', () => {
    annotateRuby(html('<p>Phonics <em>is <strong>useful</strong></em></p>'), segment);
    expect(root.querySelectorAll('ruby')).toHaveLength(3);
    expect(root.querySelector('strong ruby rt').textContent).toBe('ˈjusfəl');
  });

  it('leaves a paragraph with no known words structurally untouched', () => {
    const el = html('<p>zzz qqq</p>');
    const before = el.querySelector('p').firstChild;
    annotateRuby(el, segment);
    expect(el.querySelector('p').firstChild).toBe(before); // same text node, no churn
  });

  it('puts one ruby over a whole multi-character run, not one per character', () => {
    // The reason the contract is a segmenter: 日本 is a single reading spanning two
    // characters, which a per-word callback could never express.
    annotateRuby(html('<p>私は日本語</p>'), () => [
      { text: '私', reading: 'わたし' },
      { text: 'は', reading: null },
      { text: '日本語', reading: 'にほんご' },
    ]);
    const ruby = root.querySelectorAll('ruby');
    expect(ruby).toHaveLength(2);
    expect(ruby[1].firstChild.nodeValue).toBe('日本語');
    expect(ruby[1].querySelector('rt').textContent).toBe('にほんご');
    // The bare run between them stays a plain text node, not a ruby.
    expect(ruby[0].nextSibling.nodeValue).toBe('は');
  });

  it('is a no-op on bad input rather than throwing', () => {
    expect(annotateRuby(null, segment)).toBe(0);
    expect(annotateRuby(html('<p>Phonics</p>'), null)).toBe(0);
  });
});
