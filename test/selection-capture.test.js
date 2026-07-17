import { describe, it, expect, beforeEach } from 'vitest';
import { captureSelectionMarkdown } from '../src/lib/selection-capture.js';

function selectContents(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

beforeEach(() => {
  window.getSelection().removeAllRanges();
  document.title = '';
  document.body.innerHTML = '';
});

describe('captureSelectionMarkdown', () => {
  it('preserves the structures used by the NVIDIA technical-blog article', () => {
    document.title = 'Long title | NVIDIA Technical Blog';
    document.body.innerHTML = `
      <h1>Lessons From the Leaderboard: What 5,000+ Kagglers Taught Us About Improving AI Reasoning</h1>
      <div class="entry-content" id="selection">
        <p>Five practical lessons from a <strong>Kaggle community</strong> push.</p>
        <h2>Lesson 1. Make chain-of-thought data verifiable</h2>
        <p>Use <a href="/blog/checks">verifiable rewards</a> and <code>reasoning_effort</code>.</p>
        <ol><li>Check the answer</li><li>Check the trace<ul><li>Keep evidence</li></ul></li></ol>
        <pre><code class="language-python">score = verify(answer)\nprint(score)</code></pre>
        <figure><img src="/images/chart.png" alt="Leaderboard results"><figcaption>Reasoning accuracy by method</figcaption></figure>
      </div>`;
    selectContents(document.getElementById('selection'));

    const captured = captureSelectionMarkdown();
    expect(captured.title).toBe('Lessons From the Leaderboard: What 5,000+ Kagglers Taught Us About Improving AI Reasoning');
    expect(captured.markdown).toContain('Five practical lessons from a **Kaggle community** push.');
    expect(captured.markdown).toContain('## Lesson 1. Make chain-of-thought data verifiable');
    expect(captured.markdown).toContain('[verifiable rewards](<http://localhost:3000/blog/checks>)');
    expect(captured.markdown).toContain('`reasoning_effort`');
    expect(captured.markdown).toContain('1. Check the answer\n2. Check the trace\n  - Keep evidence');
    expect(captured.markdown).toContain('```python\nscore = verify(answer)\nprint(score)\n```');
    expect(captured.markdown).toContain('![Leaderboard results](<http://localhost:3000/images/chart.png>)');
    expect(captured.markdown).toContain('*Reasoning accuracy by method*');
  });

  it('converts tables and quotes while dropping hidden controls and scripts', () => {
    document.body.innerHTML = `<h1>Results</h1><div id="selection">
      <blockquote><p>Measure the tradeoff.</p></blockquote>
      <table><tr><th>Method</th><th>Score</th></tr><tr><td>Baseline</td><td>71%</td></tr></table>
      <button>Subscribe</button><script>bad()</script><span hidden>Tracking</span>
    </div>`;
    selectContents(document.getElementById('selection'));
    const { markdown } = captureSelectionMarkdown();
    expect(markdown).toContain('> Measure the tradeoff.');
    expect(markdown).toContain('| Method | Score |\n| --- | --- |\n| Baseline | 71% |');
    expect(markdown).not.toMatch(/Subscribe|bad|Tracking/);
  });

  it('is self-contained when Chrome serializes it for executeScript', () => {
    document.body.innerHTML = '<h1>Standalone</h1><p id="selection">A <b>rich</b> range.</p>';
    selectContents(document.getElementById('selection'));
    const injected = (0, eval)(`(${captureSelectionMarkdown.toString()})`);
    expect(injected()).toEqual({ title: 'Standalone', markdown: 'A **rich** range.' });
  });
});
