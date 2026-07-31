import { describe, it, expect, beforeEach } from 'vitest';
import { annotateRuby } from '../src/lib/ruby-annotate.js';

const READINGS = { phonics: 'ˈfɑnɪks', is: 'ɪz', useful: 'ˈjusfəl', cat: 'kæt' };
const reading = (word) => READINGS[word.toLowerCase()] ?? null;

let root;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

const html = (markup) => { root.innerHTML = markup; return root; };

describe('annotateRuby', () => {
  it('wraps known words and leaves the visible text identical', () => {
    annotateRuby(html('<p>Phonics is useful</p>'), reading);
    // textContent interleaves each word with its rt; the spacing between words survives.
    expect(root.textContent).toBe('Phonicsˈfɑnɪks isɪz usefulˈjusfəl');
    expect(root.querySelectorAll('ruby')).toHaveLength(3);
    expect(root.querySelector('ruby rt').textContent).toBe('ˈfɑnɪks');
  });

  it('leaves unknown words as bare text', () => {
    annotateRuby(html('<p>Phonics helps covid research</p>'), reading);
    expect(root.querySelectorAll('ruby')).toHaveLength(1);
    expect(root.querySelector('p').firstElementChild.tagName).toBe('RUBY');
  });

  it('preserves punctuation and spacing exactly', () => {
    annotateRuby(html('<p>  Phonics, is: useful!  </p>'), reading);
    const flat = [...root.querySelector('p').childNodes]
      .map((n) => (n.nodeName === 'RUBY' ? n.firstChild.nodeValue : n.nodeValue)).join('');
    expect(flat).toBe('  Phonics, is: useful!  ');
  });

  it('never annotates inside code, pre or math', () => {
    annotateRuby(html('<p><code>phonics</code> <pre>is useful</pre> <span class="katex">cat</span></p>'), reading);
    expect(root.querySelectorAll('ruby')).toHaveLength(0);
  });

  it('annotates around a skipped island without disturbing it', () => {
    annotateRuby(html('<p>The cat runs <code>cat</code> here</p>'), reading);
    expect(root.querySelectorAll('ruby')).toHaveLength(1);
    expect(root.querySelector('code').textContent).toBe('cat');
  });

  it('does not nest ruby when run twice over the same tree', () => {
    const el = html('<p>Phonics is useful</p>');
    annotateRuby(el, reading);
    annotateRuby(el, reading);
    expect(root.querySelectorAll('ruby')).toHaveLength(3);
    expect(root.querySelectorAll('ruby ruby')).toHaveLength(0);
  });

  it('reports how many words it annotated', () => {
    expect(annotateRuby(html('<p>Phonics is useful</p>'), reading)).toBe(3);
    expect(annotateRuby(html('<p>nothing known here</p>'), reading)).toBe(0);
  });

  it('walks into nested markup and across siblings', () => {
    annotateRuby(html('<p>Phonics <em>is <strong>useful</strong></em></p>'), reading);
    expect(root.querySelectorAll('ruby')).toHaveLength(3);
    expect(root.querySelector('strong ruby rt').textContent).toBe('ˈjusfəl');
  });

  it('leaves a paragraph with no known words structurally untouched', () => {
    const el = html('<p>zzz qqq</p>');
    const before = el.querySelector('p').firstChild;
    annotateRuby(el, reading);
    expect(el.querySelector('p').firstChild).toBe(before); // same text node, no churn
  });

  it('is a no-op on bad input rather than throwing', () => {
    expect(annotateRuby(null, reading)).toBe(0);
    expect(annotateRuby(html('<p>Phonics</p>'), null)).toBe(0);
  });
});
