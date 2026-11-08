import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  it('labels Gemini share-page turns and drops its hidden prompt heading', () => {
    document.title = 'Gemini';
    document.body.innerHTML = `
      <main>
        <h1>Vanilla JS audio</h1>
        <share-turn-viewer>
          <user-query>
            <h5 class="cdk-visually-hidden screen-reader-user-query-label">You said Read this post…</h5>
            <p>Read this post and show me the code.</p>
          </user-query>
          <response-container><message-content><p>Here is the code.</p></message-content></response-container>
        </share-turn-viewer>
      </main>`;

    const { markdown } = captureSelectionMarkdown(true);
    expect(markdown).toBe('# Vanilla JS audio\n\n## You\n\nRead this post and show me the code.\n\n## Gemini\n\nHere is the code.');
  });

  it('labels a Gemini app reply once, though its container is nested in the reply', () => {
    document.body.innerHTML = `
      <main>
        <user-query><p>Hello</p></user-query>
        <model-response><response-container><p>Hi there.</p></response-container></model-response>
      </main>`;

    const { markdown } = captureSelectionMarkdown(true);
    expect(markdown.match(/^## Gemini$/gm)).toHaveLength(1);
    expect(markdown).toBe('## You\n\nHello\n\n## Gemini\n\nHi there.');
  });

  it('roots a chat at the main element holding its turns, however much surrounds it', () => {
    const sidebar = '<p>Another conversation</p>'.repeat(50);
    document.body.innerHTML = `
      <a href="#main">Skip to content</a>
      <div><h2>Chat history</h2>${sidebar}</div>
      <main id="main"><div data-message-author-role="user"><p>A short question</p></div></main>`;

    const { markdown } = captureSelectionMarkdown(true);
    expect(markdown).toBe('## You\n\nA short question');
  });

  it('rebuilds a signed-in ChatGPT chat, which has no role markers, <pre>, or <code> wrappers', () => {
    const sidebar = '<p>Another conversation</p>'.repeat(50);
    document.body.innerHTML = `
      <div>${sidebar}</div>
      <main>
        <div role="separator" data-markdown-copy="exclude"><time>Sat, Oct 10</time></div>
        <div>
          <h4 data-conversation-role="user" class="sr-only m-0"><span>You said:</span><span aria-hidden="true">You</span></h4>
          <div><p>Sort this</p></div>
        </div>
        <div>
          <h4 data-conversation-role="assistant" class="sr-only m-0"><span>ChatGPT said:</span><span aria-hidden="true">ChatGPT</span></h4>
          <div>
            <p>Use <span data-markdown-copy="inline-code">sorted()</span>:</p>
            <div data-code-block="true" data-markdown-copy="code-block">
              <div data-markdown-copy="exclude" contenteditable="false"><div>Python</div></div>
              <div data-code-block-source="true"><div><code class="whitespace-pre! block"><span>a = [2, 1]
print(sorted(a))</span></code></div></div>
            </div>
            <div data-code-block="true" data-markdown-copy="code-block">
              <div data-markdown-copy="exclude" contenteditable="false"></div>
              <div data-code-block-source="true"><code>no language</code></div>
            </div>
          </div>
        </div>
      </main>`;

    expect(captureSelectionMarkdown(true).markdown).toBe([
      '## You', 'Sort this',
      '## ChatGPT', 'Use `sorted()`:',
      '```python\na = [2, 1]\nprint(sorted(a))\n```',
      '```\nno language\n```',
    ].join('\n\n'));
  });

  it('labels a turn once when both ChatGPT markups are present', () => {
    document.body.innerHTML = `
      <main><div>
        <h4 data-conversation-role="user" class="sr-only">You said:</h4>
        <div data-message-author-role="user"><p>Hello</p></div>
      </div></main>`;
    expect(captureSelectionMarkdown(true).markdown).toBe('## You\n\nHello');
  });

  it('names the assistant by the site, not by words in the chat title', () => {
    vi.stubGlobal('location', { hostname: 'chatgpt.com', href: 'https://chatgpt.com/c/1' });
    try {
      document.title = 'Add Overlay Next To Gemini';
      document.body.innerHTML = '<main><div data-message-author-role="assistant"><p>Done.</p></div></main>';
      expect(captureSelectionMarkdown(true).markdown).toBe('## ChatGPT\n\nDone.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fences a Gemini code block with its language and without the header label', () => {
    document.body.innerHTML = `
      <main><response-container>
        <code-block><div class="code-block">
          <div class="code-block-decoration"><span>HTML</span><div class="buttons"><button aria-label="Copy code">content_copy</button></div></div>
          <div><pre><code class="code-container">&lt;p&gt;Hi&lt;/p&gt;</code></pre></div>
        </div></code-block>
      </response-container></main>`;
    expect(captureSelectionMarkdown(true).markdown).toBe('## Gemini\n\n```html\n<p>Hi</p>\n```');
  });

  describe('Google AI Studio', () => {
    // Markup as AI Studio served it on 2026-11-08. A turn keeps its frame but is filled in
    // only while it is near the screen, and empties again once scrolled away.
    const label = (role, time) => `<div class="author-label" role="heading">${role}<span class="timestamp">${time}</span></div>`;
    const prompt = (html) => `<ms-prompt-chunk class="text-chunk"><ms-text-chunk><div><ms-cmark-node class="cmark-node">${html}</ms-cmark-node></div></ms-text-chunk></ms-prompt-chunk>`;
    const cell = (text) => `<ms-cmark-node><td><ms-cmark-node><span>${text}</span></ms-cmark-node></td></ms-cmark-node>`;
    const fillings = [
      ['User', label('User', '10:41 PM') + prompt('<p><ms-cmark-node>How do I sort a list?</ms-cmark-node></p>')],
      ['Model', label('Model', '10:41 PM') + `<ms-prompt-chunk class="text-chunk"><ms-thought-chunk><mat-accordion>
        <mat-expansion-panel class="thought-panel"><mat-expansion-panel-header role="button" aria-expanded="false">Thoughts</mat-expansion-panel-header>
        <div class="mat-expansion-panel-content-wrapper">Private reasoning that is not part of the chat.</div></mat-expansion-panel>
      </mat-accordion></ms-thought-chunk></ms-prompt-chunk>`],
      ['Model', prompt(`<p>Use <strong>sorted</strong>:</p>
        <ms-code-block><div class="container"><mat-expansion-panel>
          <mat-expansion-panel-header role="button" aria-expanded="true"><span class="mat-content"><mat-panel-title>
            <div class="header-content"><span class="title-icon">code</span><span class="title-text">Python</span></div>
            <div class="actions-container"><button aria-label="Copy to clipboard"><span>content_copy</span></button></div>
          </mat-panel-title></span></mat-expansion-panel-header>
          <div class="mat-expansion-panel-content-wrapper"><div class="mat-expansion-panel-body"><pre><code><span class="hljs-built_in">sorted</span>(items)</code></pre></div></div>
        </mat-expansion-panel></div></ms-code-block>
        <div class="table-container"><table><ms-cmark-node>
          <tr class="table-header"><ms-cmark-node>${cell('Call')}${cell('Returns')}</ms-cmark-node></tr>
          <tr><ms-cmark-node>${cell('sorted(items)')}${cell('a new list')}</ms-cmark-node></tr>
        </ms-cmark-node></table></div>`)],
      ['User', label('User', '10:42 PM') + prompt('<p><ms-cmark-node>Thanks</ms-cmark-node></p>')],
    ];

    function studioPage() {
      document.title = 'Sorting help | Google AI Studio';
      document.body.innerHTML = `<h1 class="mode-title">Sorting help</h1><ms-autoscroll-container>${fillings.map(([role]) => `
        <ms-chat-turn><div class="chat-turn-container ${role.toLowerCase()}">
          <div class="actions-container"><button aria-label="Edit"><span>edit</span></button><ms-chat-turn-options><button aria-label="Open options"><span>more_vert</span></button></ms-chat-turn-options></div>
          <div class="virtual-scroll-container" data-turn-role="${role}"><div></div><div class="turn-content"></div></div>
        </div></ms-chat-turn>`).join('')}</ms-autoscroll-container>`;
      const turns = [...document.querySelectorAll('ms-chat-turn')];
      const show = (index) => turns.forEach((turn, i) => {
        turn.querySelector('.turn-content').innerHTML = i === index ? fillings[i][1] : '';
      });
      turns.forEach((turn, i) => { turn.scrollIntoView = () => setTimeout(() => show(i), 10); });
      show(turns.length - 1);

      let top = 300;
      const scroller = document.querySelector('ms-autoscroll-container');
      Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: (value) => { top = value; } });
      Object.defineProperty(scroller, 'scrollHeight', { value: 2000 });
      Object.defineProperty(scroller, 'clientHeight', { value: 700 });
      return scroller;
    }

    it('reads every turn, though only the one on screen is filled in', async () => {
      const scroller = studioPage();
      // As Chrome injects it: the function's own source, with nothing from this module.
      const injected = (0, eval)(`(${captureSelectionMarkdown.toString()})`);

      const captured = await injected(true);
      expect(captured).toEqual({
        title: 'Sorting help',
        images: [],
        markdown: [
          '## You', 'How do I sort a list?',
          '## Gemini', 'Use **sorted**:', '```python\nsorted(items)\n```',
          '| Call | Returns |\n| --- | --- |\n| sorted(items) | a new list |',
          '## You', 'Thanks',
        ].join('\n\n'),
      });
      expect(scroller.scrollTop).toBe(300);
    });

    it('labels the turns in a selection, without their thinking or times', () => {
      document.body.innerHTML = `<div id="selection">
        <div data-turn-role="User"><div class="turn-content">${fillings[0][1]}</div></div>
        <div data-turn-role="Model"><div class="turn-content">${fillings[1][1]}<p>Use sorted.</p></div></div>
      </div>`;
      selectContents(document.getElementById('selection'));

      expect(captureSelectionMarkdown('smart-selection').markdown)
        .toBe('## You\n\nHow do I sort a list?\n\n## Gemini\n\nUse sorted.');
    });
  });

  it('drops a heading with nothing left in it instead of leaving a bare marker', () => {
    document.body.innerHTML = '<main><h4><span class="sr-only">You said:</span></h4><p>The question</p></main>';
    expect(captureSelectionMarkdown(true).markdown).toBe('The question');
  });

  it('still scores the page when nothing on it is a chat turn', () => {
    const article = '<p>A long paragraph of the real article.</p>'.repeat(50);
    document.body.innerHTML = `<main><p>Short teaser</p></main><section>${article}</section>`;

    expect(captureSelectionMarkdown(true).markdown).toContain('A long paragraph of the real article.');
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
