// src/lib/mermaid-render.js
// Turn ```mermaid code blocks into diagrams in the preview and in exported PDFs.
//
// Mermaid is large (about 3.5 MB), so it is not bundled into app.js and not loaded at
// boot. Its official ES-module build is vendored under mermaid/ — an entry point plus
// one chunk per diagram type — and imported the first time a note actually contains a
// diagram, pulling in only the chunks that diagram type needs. A dynamic import of a
// file packaged with the extension is allowed by MV3's `script-src 'self'`; nothing is
// fetched from the network and no script element is created.
import DOMPurify from 'dompurify';

export const MERMAID_ENTRY = 'mermaid/mermaid.esm.min.mjs';

// Rendered diagrams by source text. The preview is rebuilt on every keystroke, and a
// diagram whose text did not change must reappear at once, not flash "Rendering…".
const CACHE_LIMIT = 64;

const CONFIG = {
  startOnLoad: false,
  // Labels are always text, never HTML, and click/link directives are disabled.
  securityLevel: 'strict',
  theme: 'default',
  // Plain SVG text instead of HTML inside <foreignObject>: the sanitizer below would
  // strip foreignObject, and html2canvas does not draw it reliably into a PDF.
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  // We show our own error message; Mermaid must not paint its own into the page.
  suppressErrorRendering: true,
  // Settings a diagram's own %%{init}%% or frontmatter may not change. Passing this list
  // replaces Mermaid's default, so it restates those, then adds htmlLabels: a diagram
  // copied from elsewhere that turns HTML labels back on would otherwise lose every
  // label to the sanitizer below, and briefly put that HTML in the page while drawing.
  secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'dompurifyConfig'],
  // Text is measured in this font to lay the diagram out, so it must be the font the
  // preview actually uses (see body in app.css).
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
};

const defaultImporter = (url) => import(/* @vite-ignore */ url);
let importer = defaultImporter;
let loading = null;
let queue = Promise.resolve();
let renderSeq = 0;
const pending = new Map(); // source -> Promise<result>
const settled = new Map(); // source -> result, in least-recently-used order

function entryUrl() {
  return globalThis.chrome?.runtime?.getURL?.(MERMAID_ENTRY)
    || new URL(MERMAID_ENTRY, globalThis.location?.href).href;
}

// Load and configure Mermaid once. A failed load is not remembered, so a later diagram
// can try again.
export function loadMermaid() {
  if (!loading) {
    loading = importer(entryUrl())
      .then((mod) => {
        const mermaid = mod?.default || mod;
        mermaid.initialize(CONFIG);
        return mermaid;
      })
      .catch((err) => { loading = null; throw err; });
  }
  return loading;
}

function message(err) {
  const text = String(err?.message || err || 'Unknown error').trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

// Mermaid's own output is already escaped in strict mode; this is a second, independent
// pass so that nothing a note says can turn into markup the preview would run.
function sanitizeSvg(svg) {
  const holder = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    ADD_ATTR: ['role', 'target'],
    RETURN_DOM: true,
  });
  // A diagram's `click … href` link opens in a new tab, as a Markdown link does;
  // following it in place would replace OWL-Note itself. (markdown.js's link hook only
  // sees HTML <a>; these are SVG.)
  for (const link of holder.querySelectorAll('a')) {
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
  return holder.innerHTML;
}

// Renders run one at a time, so one that never finishes would stall every later diagram,
// and any PDF export waiting on them. Mermaid waits for each image in a diagram to load,
// and a host that accepts the request but never answers holds it open indefinitely.
export const RENDER_TIMEOUT_MS = 15_000;
let renderTimeoutMs = RENDER_TIMEOUT_MS;

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('This diagram took too long to draw. An image in it may not be loading.')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function renderNow(source) {
  const id = `owl-mermaid-${++renderSeq}`;
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch (err) {
    return { error: `The diagram renderer could not load: ${message(err)}`, transient: true };
  }
  try {
    const { svg } = await withDeadline(mermaid.render(id, source), renderTimeoutMs);
    return { svg: sanitizeSvg(svg) };
  } catch (err) {
    // Remembered like any other failure: retrying on every keystroke would stall the
    // queue again each time. Editing the diagram, or reopening OWL-Note, tries again.
    return { error: message(err) };
  } finally {
    // A failed or abandoned render can leave Mermaid's scratch element in the document.
    globalThis.document?.getElementById?.(`d${id}`)?.remove();
  }
}

function remember(source, result) {
  if (result.transient) return; // the renderer may load next time
  settled.delete(source);
  settled.set(source, result);
  while (settled.size > CACHE_LIMIT) settled.delete(settled.keys().next().value);
}

// Render one diagram. Renders run one at a time — Mermaid keeps global state while it
// lays a diagram out — and the same text is only ever rendered once.
export function renderMermaid(source) {
  const done = settled.get(source);
  if (done) return Promise.resolve(done);
  if (pending.has(source)) return pending.get(source);
  const job = queue.then(() => renderNow(source)).then((result) => {
    pending.delete(source);
    remember(source, result);
    return result;
  });
  queue = job.catch(() => {});
  pending.set(source, job);
  return job;
}

function errorNote(error) {
  const note = document.createElement('div');
  note.className = 'mermaid-error-message';
  note.textContent = `Diagram error: ${error}`;
  return note;
}

function paint(box, source, result, { enlargeable = false, stale = null } = {}) {
  box.classList.remove('mermaid-pending', 'mermaid-stale');
  if (!result.svg && stale) {
    // Mid-edit a diagram is usually just incomplete. Keep its last good drawing, faded,
    // under the error, rather than swap in a tall block of source that shoves the rest
    // of the note down on every keystroke.
    box.classList.add('mermaid-stale');
    box.innerHTML = stale;
    box.prepend(errorNote(result.error));
    return;
  }
  if (result.svg) {
    box.innerHTML = result.svg;
    if (enlargeable) {
      // Opens in the full-window viewer, the same way a photo does (see the editor).
      box.tabIndex = 0;
      box.title = 'Click to enlarge';
      box.setAttribute('role', 'button');
      box.setAttribute('aria-label', 'Enlarge diagram');
    }
    return;
  }
  box.classList.add('mermaid-error');
  box.textContent = '';
  const code = document.createElement('pre');
  code.textContent = source; // the user's text, shown as text
  box.append(errorNote(result.error), code);
}

// Replace every ```mermaid block under `root` with its diagram. Each block becomes a
// div in the same place, so the preview keeps one element per Markdown block (the
// click-to-source mapping counts them). Diagrams rendered before appear immediately;
// new ones show a placeholder until they are ready. Resolves once every diagram under
// `root` is painted, which is what a PDF export waits for.
//   enlargeable — mark drawn diagrams as buttons that open the full-window viewer
//   previous    — the SVG markup each diagram showed before this rebuild, in order; a
//                 diagram being edited keeps that drawing on screen, faded, until its
//                 new one is ready, instead of flashing a placeholder per keystroke
export function decorateMermaid(root, { enlargeable = false, previous = [] } = {}) {
  const blocks = [...root.querySelectorAll('pre > code.language-mermaid')];
  // Positions only line up while the count is unchanged: a diagram added or removed
  // above would hand every later one its neighbour's old drawing.
  const usePrevious = previous.length === blocks.length;
  return Promise.all(blocks.map((code, i) => {
    const pre = code.parentElement;
    const source = code.textContent;
    const box = document.createElement('div');
    box.className = 'mermaid-diagram';
    pre.replaceWith(box);
    const done = settled.get(source);
    if (done) {
      paint(box, source, done, { enlargeable });
      return Promise.resolve();
    }
    const stale = usePrevious ? previous[i] : null;
    if (stale) {
      box.classList.add('mermaid-stale');
      box.innerHTML = stale;
    } else {
      box.classList.add('mermaid-pending');
      box.textContent = 'Rendering diagram…';
    }
    return renderMermaid(source).then((result) => paint(box, source, result, { enlargeable, stale }));
  }));
}

// Enlarging never magnifies a diagram more than this past its natural size, so a
// two-box diagram does not open as two boxes the size of the screen.
const MAX_ENLARGE = 3;

// A drawn diagram as a standalone image, for the viewer photos use. Mermaid draws at
// width="100%", which has no size of its own once it leaves the page, so the copy gets
// an explicit one: as large as fits `maxWidth` x `maxHeight`. It is vector, so the
// viewer can enlarge it without losing sharpness. Returns null if it cannot be measured.
export function diagramImageUrl(svg, maxWidth, maxHeight) {
  const box = String(svg?.getAttribute?.('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  let [width, height] = box.length === 4 ? box.slice(2) : [];
  if (!(width > 0 && height > 0)) {
    const rect = svg?.getBoundingClientRect?.() || {};
    [width, height] = [rect.width, rect.height];
  }
  if (!(width > 0 && height > 0 && maxWidth > 0 && maxHeight > 0)) return null;
  const scale = Math.min(MAX_ENLARGE, maxWidth / width, maxHeight / height);
  const copy = svg.cloneNode(true);
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  copy.setAttribute('width', String(Math.round(width * scale)));
  copy.setAttribute('height', String(Math.round(height * scale)));
  copy.style?.removeProperty?.('max-width');
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
}

// Tests swap in a fake Mermaid; the real one needs a browser to lay text out.
export function _setMermaidImporter(fn, { timeoutMs = RENDER_TIMEOUT_MS } = {}) {
  importer = fn || defaultImporter;
  renderTimeoutMs = timeoutMs;
  _resetMermaid();
}

export function _resetMermaid() {
  loading = null;
  queue = Promise.resolve();
  pending.clear();
  settled.clear();
}
