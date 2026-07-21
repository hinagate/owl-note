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

  it('maps objects in a selected clone back to live page geometry for attachment copying', () => {
    document.title = 'Selected design';
    document.body.innerHTML = `<div id="selection">
      <p>Keep this explanation.</p>
      <div data-testid="file-thumbnail"><button><h3>design.pdf</h3><p>8 pages</p></button></div>
      <img id="selected-image" src="https://images.example/design.png" alt="System design">
      <button aria-label="Copy selection">Copy</button>
    </div>`;
    const image = document.getElementById('selected-image');
    image.getBoundingClientRect = () => ({ left: 90, top: 640, width: 720, height: 480, right: 810, bottom: 1120 });
    selectContents(document.getElementById('selection'));

    const injected = (0, eval)(`(${captureSelectionMarkdown.toString()})`);
    const captured = injected('smart-selection');
    expect(captured.markdown).toContain('Keep this explanation.');
    expect(captured.markdown).toContain('design.pdf');
    expect(captured.markdown).toContain('8 pages');
    expect(captured.markdown).toContain('![System design](owl-smart-img:0)');
    expect(captured.markdown).not.toContain('Copy');
    expect(captured.images).toEqual([expect.objectContaining({
      index: 0,
      src: 'https://images.example/design.png',
      x: 90,
      y: 640,
      width: 720,
      height: 480,
    })]);
    expect(image.hasAttribute('data-owl-note-smart-selection')).toBe(false);
  });

  it('rebuilds a typical LLM conversation with roles, code, math, tables, and image placeholders', () => {
    document.title = 'ChatGPT - Debugging a chart';
    document.body.innerHTML = `
      <nav>Chat history <button>New chat</button></nav>
      <main>
        <h1>ChatGPT</h1>
        <article data-message-author-role="user">
          <h5 class="sr-only">You said:</h5>
          <p>Please explain <strong>this chart</strong> and repair the code.</p>
          <img id="chart" src="https://images.example/chart.png" alt="Latency chart">
        </article>
        <article data-message-author-role="assistant">
          <h5 class="sr-only">ChatGPT said:</h5>
          <p>The loop has an off-by-one error.</p>
          <pre><code class="language-js">for (let i = 0; i &lt; rows.length; i++) run(rows[i]);</code></pre>
          <table><tr><th>Model</th><th>Latency</th></tr><tr><td>Small</td><td>42 ms</td></tr></table>
          <div class="katex-display"><span class="katex"><math><semantics><annotation encoding="application/x-tex">x^2 + y^2</annotation></semantics></math></span></div>
          <button>Copy response</button>
        </article>
      </main>`;
    const image = document.getElementById('chart');
    image.getBoundingClientRect = () => ({ left: 120, top: 480, width: 640, height: 360, right: 760, bottom: 840 });

    const captured = captureSelectionMarkdown(true);
    expect(captured.title).toBe('Debugging a chart');
    expect(captured.markdown).toContain('## You');
    expect(captured.markdown).toContain('Please explain **this chart** and repair the code.');
    expect(captured.markdown).toContain('![Latency chart](owl-smart-img:0)');
    expect(captured.markdown).toContain('## ChatGPT');
    expect(captured.markdown).toContain('```js\nfor (let i = 0; i < rows.length; i++) run(rows[i]);\n```');
    expect(captured.markdown).toContain('| Model | Latency |\n| --- | --- |\n| Small | 42 ms |');
    expect(captured.markdown).toContain('$$\nx^2 + y^2\n$$');
    expect(captured.markdown).not.toMatch(/Chat history|New chat|Copy response|You said|ChatGPT said/);
    expect(captured.images).toEqual([expect.objectContaining({
      index: 0,
      src: 'https://images.example/chart.png',
      alt: 'Latency chart',
      x: 120,
      y: 480,
      width: 640,
      height: 360,
    })]);
  });

  it('keeps whole-page conversion self-contained for chrome.scripting.executeScript', () => {
    document.title = 'Portable chat';
    document.body.innerHTML = '<main><article data-message-author-role="assistant"><p>A portable answer.</p></article></main>';
    const injected = (0, eval)(`(${captureSelectionMarkdown.toString()})`);
    expect(injected(true)).toEqual({
      title: 'Portable chat',
      markdown: '## ChatGPT\n\nA portable answer.',
      images: [],
    });
  });

  it('preserves Claude message boundaries, attachment cards, artifacts, and rendered visual objects', () => {
    document.title = 'Claude - Architecture review';
    document.body.innerHTML = `
      <main>
        <div class="group">
          <div class="human-message-frame">
            <h2 data-find-omitted class="sr-only">You said: Review the attached design</h2>
            <div data-find-omitted>
              <div data-testid="file-thumbnail">
                <button aria-label="Open file architecture.pdf">
                  <h3>architecture.pdf</h3><p>PDF · 12 pages</p>
                </button>
              </div>
            </div>
            <div data-testid="user-message"><p>Review the attached design.</p></div>
            <button aria-label="Edit message">Edit</button>
          </div>
        </div>
        <div class="group">
          <div class="assistant-message-frame">
            <h2 data-find-omitted class="sr-only">Claude responded: Architecture findings</h2>
            <div class="font-claude-response">
              <p>The design has two important trade-offs.</p>
              <button data-testid="artifact-card"><h3>System diagram</h3><p>Interactive artifact</p></button>
              <svg id="architecture-chart" role="img" aria-label="Architecture dependency graph"><rect width="640" height="320"></rect></svg>
              <pre><code class="language-ts">const stable = true;</code></pre>
            </div>
            <button aria-label="Copy response">Copy</button>
          </div>
        </div>
      </main>`;
    const chart = document.getElementById('architecture-chart');
    chart.getBoundingClientRect = () => ({ left: 80, top: 900, width: 640, height: 320, right: 720, bottom: 1220 });

    const captured = captureSelectionMarkdown(true);
    expect(captured.title).toBe('Architecture review');
    expect(captured.markdown).toContain('## You');
    expect(captured.markdown).toContain('architecture.pdf');
    expect(captured.markdown).toContain('PDF · 12 pages');
    expect(captured.markdown).toContain('Review the attached design.');
    expect(captured.markdown).toContain('## Claude');
    expect(captured.markdown).toContain('System diagram');
    expect(captured.markdown).toContain('Interactive artifact');
    expect(captured.markdown).toContain('![Architecture dependency graph](owl-smart-img:0)');
    expect(captured.markdown).toContain('```ts\nconst stable = true;\n```');
    expect(captured.markdown).not.toMatch(/You said:|Claude responded:|Edit message|Copy response/);
    expect(captured.markdown.match(/^## You$/gm)).toHaveLength(1);
    expect(captured.markdown.match(/^## Claude$/gm)).toHaveLength(1);
    expect(captured.images).toEqual([expect.objectContaining({
      index: 0,
      src: '',
      alt: 'Architecture dependency graph',
      x: 80,
      y: 900,
      width: 640,
      height: 320,
    })]);
  });
});
