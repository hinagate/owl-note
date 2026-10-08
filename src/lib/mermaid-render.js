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

// Mermaid's own limit on diagram text. Checked here so an oversized diagram gets this
// app's error, with its source, instead of the pink box Mermaid draws for it.
const MAX_TEXT_SIZE = 50_000;

// How long typing into a diagram must pause before it is redrawn.
export const EDIT_PAUSE_MS = 250;

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
  maxTextSize: MAX_TEXT_SIZE,
  // Settings a diagram's own %%{init}%% or frontmatter may not change. Passing this list
  // replaces Mermaid's default, so it restates those, then adds htmlLabels: a diagram
  // copied from elsewhere that turns HTML labels back on would otherwise lose every
  // label to the sanitizer below, and briefly put that HTML in the page while drawing.
  secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'dompurifyConfig'],
  // Text is measured in this font to lay the diagram out, so it must be the font the
  // preview actually uses (see body in app.css).
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif',
  // Without HTML labels, a journey's section titles fall back to SVG text filled in the
  // same colour as their box. Lives in the SVG's own <style>, so it also holds in the
  // enlarged view and in PDFs, which never see app.css.
  themeCSS: 'text.journey-section { fill: #333; }',
};

const defaultImporter = (url) => import(/* @vite-ignore */ url);
let importer = defaultImporter;
let loading = null;
let loadFailure = null;
let queue = Promise.resolve();
let renderSeq = 0;
const pending = new Map(); // source -> Promise<result>
const settled = new Map(); // source -> result, least recently used first
const waiting = new Map(); // source -> Set of { wanted, width }, one per caller waiting for it
const svgSource = new WeakMap(); // a painted <svg> -> the text it was drawn from

function entryUrl() {
  return globalThis.chrome?.runtime?.getURL?.(MERMAID_ENTRY)
    || new URL(MERMAID_ENTRY, globalThis.location?.href).href;
}

// Load and configure Mermaid once. A failed load is final for this page: Chrome records
// a failed module fetch and answers every later import of the same URL with the same
// failure, so retrying on each keystroke would only flash the error again and again.
export function loadMermaid() {
  if (loadFailure) return Promise.reject(loadFailure);
  if (!loading) {
    loading = importer(entryUrl())
      .then((mod) => {
        const mermaid = mod?.default || mod;
        mermaid.initialize(CONFIG);
        return mermaid;
      })
      .catch((err) => {
        loading = null;
        loadFailure = err;
        throw err;
      });
  }
  return loading;
}

function message(err) {
  const text = String(err?.message || err || 'Unknown error').trim();
  // Mermaid's own wording here is wrong (it reports the limit as the count) and tells a
  // note's author to call an API they cannot reach.
  // One diagram type's part of Mermaid failed to load; Chrome will not load it again
  // until the page is reopened.
  if (/Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(text)) {
    return 'Part of the diagram renderer could not load. Reopen OWL-Note to try again.';
  }
  if (/^Edge limit exceeded\b/.test(text)) {
    const limit = /\bthe limit is (\d+)/.exec(text)?.[1];
    return `This diagram has too many connections to draw${limit ? ` (the limit is ${limit})` : ''}.`;
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

const LOAD_FAILED = 'The diagram renderer could not load. Reopen OWL-Note to try again.';

// Mermaid's own output is already escaped in strict mode; this is a second, independent
// pass so that nothing a note says can turn into markup the preview would run.
function sanitizeSvg(svg) {
  const holder = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    // dominant-baseline is a plain presentation attribute DOMPurify's list lacks; without
    // it titles and axis labels in ten diagram types sit half outside their box.
    ADD_ATTR: ['role', 'target', 'dominant-baseline'],
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

// Mermaid queues its own renders too, so giving up on one does not free Mermaid: every
// later render would wait behind it and time out in turn. While one is stuck, no new
// render is started; the diagrams that asked are redrawn as soon as it lets go.
let stuck = null;
const afterUnstuck = new Map(); // preview box -> its redraw
const PAUSED = 'Diagrams are paused: one is waiting for an image that is not loading. They will draw when it gives up, or when OWL-Note is reopened.';

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error('This diagram took too long to draw. An image in it may not be loading.');
      err.timedOut = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function markStuck(render) {
  stuck = render;
  render.catch(() => {}).finally(() => {
    if (stuck !== render) return;
    stuck = null;
    const retry = [...afterUnstuck.values()];
    afterUnstuck.clear();
    for (const redraw of retry) redraw();
  });
}

// Lay the diagram out in a box as wide as where it will be shown: a gantt chart sizes
// itself to its container, and without one it took the whole page width and appeared at
// a quarter size in the preview column.
function measuringBox(width) {
  if (!(width > 0) || !globalThis.document?.body) return null;
  const box = document.createElement('div');
  box.style.cssText = `position:absolute;left:-10000px;top:0;visibility:hidden;width:${Math.round(width)}px`;
  document.body.append(box);
  return box;
}

async function renderNow(source, width) {
  if (source.length > MAX_TEXT_SIZE) {
    return { error: `This diagram is too long to draw (over ${MAX_TEXT_SIZE.toLocaleString('en-US')} characters).` };
  }
  let mermaid;
  try {
    mermaid = await loadMermaid();
  } catch {
    return { error: LOAD_FAILED, transient: true };
  }
  if (stuck) return { error: PAUSED, transient: true, paused: true };
  const id = `owl-mermaid-${++renderSeq}`;
  const container = measuringBox(width);
  const render = Promise.resolve().then(() => (container ? mermaid.render(id, source, container) : mermaid.render(id, source)));
  try {
    const { svg } = await withDeadline(render, renderTimeoutMs);
    return { svg: sanitizeSvg(svg) };
  } catch (err) {
    // A diagram that timed out keeps its error until its text changes: drawing it again
    // would most likely wait on the same image and stall every diagram once more.
    if (err?.timedOut) markStuck(render);
    return { error: message(err) };
  } finally {
    // A failed or abandoned render can leave Mermaid's scratch element in the document.
    globalThis.document?.getElementById?.(`d${id}`)?.remove();
    container?.remove();
  }
}

function cached(source) {
  const result = settled.get(source);
  if (result) { settled.delete(source); settled.set(source, result); } // most recently used
  return result;
}

function remember(source, result) {
  if (result.transient || result.skipped) return result; // worth trying again later
  settled.delete(source);
  settled.set(source, result);
  while (settled.size > CACHE_LIMIT) settled.delete(settled.keys().next().value);
  return result;
}

// A queued render is only worth doing if someone still wants it. Typing into a diagram
// queues one render per keystroke; by the time most of them come up, a newer keystroke
// has replaced the box that asked, and they are skipped.
function stillWanted(source) {
  for (const caller of waiting.get(source) || []) if (caller.wanted()) return true;
  return false;
}

// How wide to lay a diagram out: as wide as the first caller still waiting for it shows
// it. Read when the render starts, not when it was asked for — reading a box's width
// forces a layout, and the preview is rebuilt on every keystroke — and not from the box
// that asked first, which a later keystroke has often replaced: one no longer in the
// page measures 0, and a gantt chart laid out at 0 spreads across the whole page.
function layoutWidth(source) {
  for (const caller of waiting.get(source) || []) {
    if (!caller.wanted()) continue;
    const width = typeof caller.width === 'function' ? caller.width() : caller.width;
    if (width > 0) return width;
  }
  return 0;
}

const ALWAYS = () => true;
const SKIPPED = Object.freeze({ skipped: true });
const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Render one diagram. Renders run one at a time — Mermaid keeps global state while it
// lays a diagram out — and the same text is only ever rendered once.
//   width   — how wide it will be shown, or a function returning that (see layoutWidth)
//   delayMs — wait this long before starting, so a burst of keystrokes into a diagram
//             costs one render rather than one each
//   wanted  — says whether the result is still needed when its turn comes; if no
//             caller still needs it, it is skipped and resolves to { skipped: true }.
//             Without it the render always happens.
export function renderMermaid(source, { width = 0, delayMs = 0, wanted = ALWAYS } = {}) {
  const done = cached(source);
  if (done) return Promise.resolve(done);
  if (!waiting.has(source)) waiting.set(source, new Set());
  waiting.get(source).add({ wanted, width });
  if (pending.has(source)) return pending.get(source);
  const takeTurn = () => {
    const turn = queue.then(() => (stillWanted(source) ? renderNow(source, layoutWidth(source)) : SKIPPED));
    queue = turn.catch(() => {});
    return turn;
  };
  // The pause is waited out before joining the queue, not while holding it: an edit that
  // changes several diagrams at once (an undo, a replace) then pauses once, not once per
  // diagram, and nothing queued behind — a PDF export's diagrams — waits on it.
  const job = (delayMs ? pause(delayMs).then(() => (stillWanted(source) ? takeTurn() : SKIPPED)) : takeTurn())
    .then((result) => {
      pending.delete(source);
      waiting.delete(source);
      remember(source, result);
      return result;
    });
  pending.set(source, job);
  return job;
}

function errorNote(result) {
  const note = document.createElement('div');
  note.className = 'mermaid-error-message';
  // A paused diagram has nothing wrong with it.
  note.textContent = result.paused ? result.error : `Diagram error: ${result.error}`;
  return note;
}

function svgFrom(markup, source) {
  const holder = document.createElement('div');
  holder.innerHTML = markup;
  const svg = holder.querySelector('svg');
  if (svg) svgSource.set(svg, source);
  return svg;
}

function paint(box, source, result, { enlargeable = false, stale = null, reuse = null } = {}) {
  if (result.skipped) return;
  // A box can be painted twice: a diagram paused behind a stuck one is drawn later.
  box.classList.remove('mermaid-pending', 'mermaid-stale', 'mermaid-error');
  if (!result.svg && stale) {
    // Mid-edit a diagram is usually just incomplete. Keep its last good drawing, faded,
    // under the error, rather than swap in a tall block of source that shoves the rest
    // of the note down on every keystroke.
    box.classList.add('mermaid-stale');
    box.replaceChildren(errorNote(result), stale);
    return;
  }
  if (result.svg) {
    // The same drawing already on screen is moved across, not parsed again: the preview
    // is rebuilt on every keystroke, and a large diagram is thousands of elements.
    const svg = reuse && svgSource.get(reuse) === source ? reuse : svgFrom(result.svg, source);
    if (svg) box.replaceChildren(svg);
    else box.innerHTML = result.svg;
    if (enlargeable) {
      // Opens in the full-window viewer, the same way a photo does (see the editor).
      box.tabIndex = 0;
      box.title = 'Click to enlarge';
      box.setAttribute('role', 'button');
      box.setAttribute('aria-label', 'Enlarge diagram');
    }
    return;
  }
  if (result.paused) {
    // Nothing is wrong with this diagram; it is waiting its turn.
    box.classList.add('mermaid-pending');
    box.textContent = result.error;
    return;
  }
  box.classList.add('mermaid-error');
  box.textContent = '';
  const code = document.createElement('pre');
  code.textContent = source; // the user's text, shown as text
  box.append(errorNote(result), code);
}

// Replace every ```mermaid block under `root` with its diagram. Each block becomes a
// div in the same place, so the preview keeps one element per Markdown block (the
// click-to-source mapping counts them). Diagrams rendered before appear immediately;
// new ones show a placeholder until they are ready. Resolves once every diagram under
// `root` is painted, which is what a PDF export waits for.
//   enlargeable — mark drawn diagrams as buttons that open the full-window viewer
//   live        — `root` is the preview on screen, rebuilt on every keystroke: renders a
//                 later rebuild made unnecessary are skipped, boxes it replaced are not
//                 painted, and diagrams paused behind a stuck one are redrawn when it
//                 lets go. Without it (a PDF) every diagram is painted exactly once.
//   previous    — the <svg> each diagram showed before this rebuild, in order. One whose
//                 text is unchanged is moved straight back in; one being edited keeps
//                 its drawing on screen, faded, until the new one is ready, instead of
//                 flashing a placeholder per keystroke.
export function decorateMermaid(root, { enlargeable = false, live = false, previous = [] } = {}) {
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
    const prior = usePrevious ? previous[i] : null;
    const stale = prior && svgSource.get(prior) !== source ? prior : null;
    if (loadFailure) {
      paint(box, source, { error: LOAD_FAILED }, { stale });
      return Promise.resolve();
    }
    // The drawing on screen is this text's, though it has dropped out of the cache (a
    // note with more diagrams than the cache holds): keep it rather than draw it again.
    const done = cached(source) || (prior && !stale ? remember(source, { svg: prior.outerHTML }) : null);
    if (done) {
      paint(box, source, done, { enlargeable, stale, reuse: prior });
      return Promise.resolve();
    }
    if (stale) {
      box.classList.add('mermaid-stale');
      box.replaceChildren(stale);
    } else {
      box.classList.add('mermaid-pending');
      box.textContent = 'Rendering diagram…';
    }
    // A preview box stops wanting its render once a later keystroke replaces it.
    const wanted = live && box.isConnected ? () => box.isConnected : undefined;
    const options = { enlargeable, stale };
    const draw = () => renderMermaid(source, { width: () => box.clientWidth, delayMs: stale ? EDIT_PAUSE_MS : 0, wanted })
      .then((result) => {
        // A box a later keystroke replaced is not shown anywhere: painting it would only
        // parse the drawing again for nothing.
        if (wanted && !box.isConnected) return;
        // Redraw this one when the stuck render lets go. Only boxes still on screen are
        // kept for that: every keystroke replaces them, and each would otherwise hold its
        // whole discarded preview in memory for as long as the render stays stuck.
        if (result.paused && wanted) {
          for (const old of afterUnstuck.keys()) if (!old.isConnected) afterUnstuck.delete(old);
          afterUnstuck.set(box, () => { if (box.isConnected) draw(); });
        }
        paint(box, source, result, options);
      });
    return draw();
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
  loadFailure = null;
  stuck = null;
  afterUnstuck.clear();
  queue = Promise.resolve();
  pending.clear();
  settled.clear();
  waiting.clear();
}
