// The zoom bar pinned to the bottom of the preview: [🔍−] [100%] [🔍+].
//
// Scales the rendered note the way browser zoom does — via CSS `zoom`, so the text reflows
// inside the reading column and images scale with it. A `transform: scale()` would leave
// the layout box its original size and push half the note out of view sideways, and a bare
// font-size change would leave images behind at their old size.
//
// The chosen level is the reader's, not the note's: it persists across sessions, so someone
// who needs 150% gets it on every note without asking twice.

// The familiar browser ladder rather than fixed 10% increments: the steps get coarser as
// they get bigger, which is how zooming actually feels right.
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
export const DEFAULT_ZOOM = 1;
const MIN = ZOOM_STEPS[0];
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** A stored preference is untrusted input: fall back rather than apply a broken zoom. */
export function normalizeZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom) || zoom <= 0) return DEFAULT_ZOOM;
  return Math.min(MAX, Math.max(MIN, zoom));
}

/**
 * Next rung up or down. Snaps a value that fell between rungs (an older build's step, or a
 * hand-edited preference) onto the ladder rather than stepping off it by a fixed amount.
 * @param {number} current
 * @param {1|-1} direction
 */
export function stepZoom(current, direction) {
  const zoom = normalizeZoom(current);
  if (direction > 0) return ZOOM_STEPS.find((step) => step > zoom + 1e-9) ?? MAX;
  return [...ZOOM_STEPS].reverse().find((step) => step < zoom - 1e-9) ?? MIN;
}

export const formatZoom = (value) => `${Math.round(normalizeZoom(value) * 100)}%`;

/**
 * @param {HTMLElement} pane the .preview element the bar is pinned inside
 * @param {HTMLElement} content the .preview-content the zoom is applied to
 * @param {{ value?: number, onChange?: (zoom: number) => void }} [options]
 * @returns {{ getZoom: () => number, setZoom: (z: number) => void, destroy: () => void }}
 */
export function createZoomBar(pane, content, { value = DEFAULT_ZOOM, onChange = () => {} } = {}) {
  let zoom = normalizeZoom(value);

  const bar = document.createElement('div');
  bar.className = 'preview-zoom';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Preview zoom');

  const out = document.createElement('button');
  out.className = 'preview-zoom-out';
  out.type = 'button';
  out.textContent = '🔍−';
  out.title = 'Zoom out';
  out.setAttribute('aria-label', 'Zoom out');

  const level = document.createElement('button');
  level.className = 'preview-zoom-level';
  level.type = 'button';
  level.title = 'Reset to 100%';

  const into = document.createElement('button');
  into.className = 'preview-zoom-in';
  into.type = 'button';
  into.textContent = '🔍+';
  into.title = 'Zoom in';
  into.setAttribute('aria-label', 'Zoom in');

  bar.append(out, level, into);
  pane.appendChild(bar);

  function apply({ notify = true } = {}) {
    // Inline on the element, which survives a preview refresh — refresh() empties the
    // node's children but never replaces the node itself.
    content.style.zoom = zoom === 1 ? '' : String(zoom);
    level.textContent = formatZoom(zoom);
    level.setAttribute('aria-label', `Zoom ${formatZoom(zoom)}, reset to 100%`);
    out.disabled = zoom <= MIN;
    into.disabled = zoom >= MAX;
    if (notify) onChange(zoom);
  }

  const set = (next, options) => {
    const normalized = normalizeZoom(next);
    if (normalized === zoom) return;
    zoom = normalized;
    apply(options);
  };

  out.addEventListener('click', () => set(stepZoom(zoom, -1)));
  into.addEventListener('click', () => set(stepZoom(zoom, 1)));
  level.addEventListener('click', () => set(DEFAULT_ZOOM));

  apply({ notify: false }); // restoring a saved level is not a change worth writing back

  return {
    getZoom: () => zoom,
    setZoom: (next) => set(next, { notify: false }),
    destroy() {
      content.style.zoom = '';
      bar.remove();
    },
  };
}
