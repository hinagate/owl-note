// Browser-native full-page capture for a user-invoked context-menu action.
//
// The page functions below are serialized by chrome.scripting.executeScript, so
// each one must stay self-contained (no imports or closed-over module values).

export const CAPTURE_INTERVAL_MS = 550; // Chrome permits at most 2 captureVisibleTab calls/second.
export const MAX_CAPTURE_TILES = 100;
export const MAX_OUTPUT_HEIGHT = 32_000;
export const MAX_OUTPUT_PIXELS = 48_000_000;

export const FULL_PAGE_CAPTURE_STATE_KEY = '__owlNoteFullPageCaptureV1';

export function preparePageForCapture() {
  const key = '__owlNoteFullPageCaptureV1';
  const previous = globalThis[key];
  if (previous?.restore) previous.restore();

  const root = document.documentElement;
  const body = document.body;
  const scrollingElement = document.scrollingElement || root;
  const rememberStyle = (element, property) => element ? {
    element,
    property,
    value: element.style.getPropertyValue(property),
    priority: element.style.getPropertyPriority(property),
  } : null;
  const restoreStyle = (entry) => {
    if (!entry) return;
    if (entry.value) entry.element.style.setProperty(entry.property, entry.value, entry.priority);
    else entry.element.style.removeProperty(entry.property);
  };

  const rootWidths = [root?.scrollWidth, root?.offsetWidth, root?.clientWidth, body?.scrollWidth, body?.offsetWidth, body?.clientWidth];
  const rootHeights = [root?.scrollHeight, root?.offsetHeight, root?.clientHeight, body?.scrollHeight, body?.offsetHeight, body?.clientHeight];
  const rootWidth = Math.max(innerWidth, ...rootWidths.filter(Number.isFinite));
  const rootHeight = Math.max(innerHeight, ...rootHeights.filter(Number.isFinite));

  // Many web apps keep the document itself exactly one viewport tall and put
  // their real content in an overflow:auto container. Pick the large visible
  // vertical scroller with the strongest combination of coverage, width, and
  // scroll range; narrow chat lists and sidebars are intentionally penalized.
  const viewportArea = Math.max(1, innerWidth * innerHeight);
  const rootRatio = Math.max(1, rootHeight / Math.max(1, innerHeight));
  let scrollTarget = scrollingElement;
  let bestScore = rootHeight > innerHeight + 2 ? (1 + Math.log2(rootRatio)) : 0.25;
  for (const element of document.querySelectorAll('body *')) {
    if (element === scrollingElement || element === body) continue;
    const clientHeight = Number(element.clientHeight) || 0;
    const clientWidth = Number(element.clientWidth) || 0;
    const scrollHeight = Number(element.scrollHeight) || 0;
    if (clientHeight < 120 || clientWidth < 160 || scrollHeight <= clientHeight + 2) continue;
    const overflowY = getComputedStyle(element).overflowY;
    if (!/(?:auto|scroll|overlay)/.test(overflowY)) continue;
    const rect = element.getBoundingClientRect();
    const visibleLeft = Math.max(0, rect.left);
    const visibleTop = Math.max(0, rect.top);
    const visibleRight = Math.min(innerWidth, rect.right);
    const visibleBottom = Math.min(innerHeight, rect.bottom);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const coverage = (visibleWidth * visibleHeight) / viewportArea;
    if (coverage < 0.18) continue;
    const widthShare = visibleWidth / Math.max(1, innerWidth);
    const ratio = Math.max(1, scrollHeight / clientHeight);
    const score = coverage * widthShare * (1 + Math.log2(ratio));
    if (score > bestScore) {
      bestScore = score;
      scrollTarget = element;
    }
  }

  const nestedScroller = scrollTarget !== scrollingElement;
  const targetRect = nestedScroller ? scrollTarget.getBoundingClientRect() : {
    left: 0, top: 0, right: innerWidth, bottom: innerHeight,
  };
  const captureLeft = Math.max(0, targetRect.left);
  const captureTop = Math.max(0, targetRect.top);
  const captureRight = Math.min(innerWidth, targetRect.right);
  const captureBottom = Math.min(innerHeight, targetRect.bottom);
  const captureWidth = Math.max(1, captureRight - captureLeft);
  const captureHeight = Math.max(1, captureBottom - captureTop);

  const scrollStyleElements = [...new Set([root, body, scrollTarget].filter(Boolean))];
  const scrollStyles = scrollStyleElements.map((element) => rememberStyle(element, 'scroll-behavior'));
  root.style.setProperty('scroll-behavior', 'auto', 'important');
  if (body) body.style.setProperty('scroll-behavior', 'auto', 'important');
  if (nestedScroller) scrollTarget.style.setProperty('scroll-behavior', 'auto', 'important');

  // Sample the viewport for common fixed/sticky headers, sidebars, and overlays.
  // Hiding these after the first tile prevents them from repeating down the image
  // without walking every node on very large pages.
  const fixed = [];
  const seen = new Set();
  const xs = [1, innerWidth * 0.25, innerWidth * 0.5, innerWidth * 0.75, innerWidth - 2];
  const ys = [1, 40, innerHeight * 0.25, innerHeight * 0.5, innerHeight * 0.75, innerHeight - 2];
  for (const x of xs) {
    for (const y of ys) {
      for (const hit of document.elementsFromPoint(Math.max(0, x), Math.max(0, y))) {
        for (let element = hit; element && element !== root; element = element.parentElement) {
          if (seen.has(element)) continue;
          seen.add(element);
          const position = getComputedStyle(element).position;
          if (position !== 'fixed' && position !== 'sticky') continue;
          // Never hide the chosen scroller or one of its ancestors: many app
          // shells make the entire main content pane position:fixed.
          if (element === scrollTarget || element.contains(scrollTarget)) continue;
          fixed.push({
            element,
            value: element.style.getPropertyValue('visibility'),
            priority: element.style.getPropertyPriority('visibility'),
          });
        }
      }
    }
  }

  const originalX = scrollX;
  const originalY = scrollY;
  const originalTargetX = nestedScroller ? scrollTarget.scrollLeft : 0;
  const originalTargetY = nestedScroller ? scrollTarget.scrollTop : 0;
  const restore = () => {
    for (const entry of fixed) {
      if (entry.value) entry.element.style.setProperty('visibility', entry.value, entry.priority);
      else entry.element.style.removeProperty('visibility');
    }
    for (const entry of scrollStyles) restoreStyle(entry);
    if (nestedScroller && scrollTarget.isConnected) {
      scrollTarget.scrollLeft = originalTargetX;
      scrollTarget.scrollTop = originalTargetY;
    }
    globalThis.scrollTo(originalX, originalY);
    if (globalThis[key]?.restore === restore) delete globalThis[key];
  };
  globalThis[key] = { fixed, nestedScroller, restore, scrollTarget };

  return {
    documentWidth: nestedScroller ? scrollTarget.scrollWidth : rootWidth,
    documentHeight: nestedScroller ? scrollTarget.scrollHeight : rootHeight,
    viewportWidth: captureWidth,
    viewportHeight: captureHeight,
    browserViewportWidth: innerWidth,
    browserViewportHeight: innerHeight,
    captureLeft,
    captureTop,
    captureWidth,
    captureHeight,
    scrollTarget: nestedScroller ? 'element' : 'document',
    devicePixelRatio: devicePixelRatio || 1,
  };
}

export function scrollPageForCapture(x, y, firstTile) {
  const state = globalThis.__owlNoteFullPageCaptureV1;
  if (!state) throw new Error('OWL-Note capture state was lost');
  for (const entry of state.fixed) {
    if (firstTile) {
      if (entry.value) entry.element.style.setProperty('visibility', entry.value, entry.priority);
      else entry.element.style.removeProperty('visibility');
    } else {
      entry.element.style.setProperty('visibility', 'hidden', 'important');
    }
  }
  if (state.nestedScroller) {
    if (!state.scrollTarget?.isConnected) throw new Error('The page replaced its scroll container during capture');
    state.scrollTarget.scrollLeft = x;
    state.scrollTarget.scrollTop = y;
  } else {
    globalThis.scrollTo(x, y);
  }
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
      resolve(state.nestedScroller
        ? { x: state.scrollTarget.scrollLeft, y: state.scrollTarget.scrollTop }
        : { x: scrollX, y: scrollY });
    }, 120)));
  });
}

export function restorePageAfterCapture() {
  globalThis.__owlNoteFullPageCaptureV1?.restore?.();
}

export function captureOffsets(documentHeight, viewportHeight) {
  const height = Number(documentHeight);
  const viewport = Number(viewportHeight);
  if (!Number.isFinite(height) || !Number.isFinite(viewport) || height <= 0 || viewport <= 0) {
    throw new Error('This page does not expose a capturable viewport');
  }
  const maxScroll = Math.max(0, height - viewport);
  const offsets = [];
  for (let y = 0; y < maxScroll; y += viewport) offsets.push(y);
  if (!offsets.length || offsets[offsets.length - 1] !== maxScroll) offsets.push(maxScroll);
  return offsets;
}

export function captureCanvasSize(meta, bitmapWidth, bitmapHeight) {
  const browserCssWidth = Math.max(1, Number(meta.browserViewportWidth || meta.viewportWidth));
  const browserCssHeight = Math.max(1, Number(meta.browserViewportHeight || meta.viewportHeight));
  const captureCssWidth = Math.max(1, Number(meta.captureWidth || meta.viewportWidth));
  const pixelsPerCssX = bitmapWidth / browserCssWidth;
  const pixelsPerCssY = bitmapHeight / browserCssHeight;
  const rawWidth = Math.max(1, Math.round(captureCssWidth * pixelsPerCssX));
  const rawHeight = Math.max(1, Math.ceil(Number(meta.documentHeight) * pixelsPerCssY));
  const scale = Math.min(
    1,
    MAX_OUTPUT_HEIGHT / rawHeight,
    Math.sqrt(MAX_OUTPUT_PIXELS / (rawWidth * rawHeight)),
  );
  return {
    width: Math.max(1, Math.floor(rawWidth * scale)),
    height: Math.max(1, Math.floor(rawHeight * scale)),
    scale,
    pixelsPerCssX,
    pixelsPerCssY,
  };
}

async function decodeCapture(dataUrl) {
  const response = await fetch(dataUrl);
  return createImageBitmap(await response.blob());
}

async function blobToDataUri(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let start = 0; start < bytes.length; start += chunkSize) {
    const chunk = bytes.subarray(start, Math.min(start + chunkSize, bytes.length));
    for (let i = 0; i < chunk.length; i++) binary += String.fromCharCode(chunk[i]);
  }
  return `data:${blob.type || 'image/jpeg'};base64,${btoa(binary)}`;
}

export async function createPageCompositor(meta, firstDataUrl, firstPosition, deps = {}) {
  const decode = deps.decode || decodeCapture;
  const Canvas = deps.OffscreenCanvas || globalThis.OffscreenCanvas;
  if (!Canvas) throw new Error('This browser cannot stitch a full-page capture');

  const first = await decode(firstDataUrl);
  const size = captureCanvasSize(meta, first.width, first.height);
  const canvas = new Canvas(size.width, size.height);
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('This browser cannot create the capture canvas');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, size.width, size.height);

  async function draw(bitmap, position) {
    const y = Math.max(0, Number(position?.y) || 0);
    const visibleCssHeight = Math.max(0, Math.min(Number(meta.viewportHeight), Number(meta.documentHeight) - y));
    const sourceX = Math.max(0, Math.round((Number(meta.captureLeft) || 0) * size.pixelsPerCssX));
    const sourceY = Math.max(0, Math.round((Number(meta.captureTop) || 0) * size.pixelsPerCssY));
    const sourceWidth = Math.max(1, Math.min(
      bitmap.width - sourceX,
      Math.round(Number(meta.captureWidth || meta.viewportWidth) * size.pixelsPerCssX),
    ));
    const sourceHeight = Math.max(1, Math.min(
      bitmap.height - sourceY,
      Math.round(visibleCssHeight * size.pixelsPerCssY),
    ));
    const destY = Math.max(0, Math.round(y * size.pixelsPerCssY * size.scale));
    const destBottom = Math.min(size.height, Math.round((y + visibleCssHeight) * size.pixelsPerCssY * size.scale));
    const destHeight = Math.max(1, destBottom - destY);
    context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, destY, size.width, destHeight);
    bitmap.close?.();
  }

  await draw(first, firstPosition);
  return {
    async add(dataUrl, position) {
      await draw(await decode(dataUrl), position);
    },
    async finish() {
      // Retry at lower qualities for captures that would exceed Drive's 25 MB
      // attachment ceiling; local-only saving remains available if it is still large.
      let blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
      if (blob.size > 24 * 1024 * 1024) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.70 });
      if (blob.size > 24 * 1024 * 1024) blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.55 });
      return {
        dataUri: await blobToDataUri(blob),
        mime: 'image/jpeg',
        width: size.width,
        height: size.height,
        scaled: size.scale < 1,
      };
    },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function injectionResult(results) {
  return results?.[0]?.result;
}

function validMeta(meta) {
  return meta && [meta.documentHeight, meta.viewportHeight, meta.viewportWidth]
    .every((value) => Number.isFinite(value) && value > 0);
}

export async function captureFullPage(tab, deps = {}) {
  if (!Number.isInteger(tab?.id)) throw new Error('The page tab is no longer available');
  const executeScript = deps.executeScript || ((options) => chrome.scripting.executeScript(options));
  const captureVisibleTab = deps.captureVisibleTab || ((windowId, options) => chrome.tabs.captureVisibleTab(windowId, options));
  const queryTabs = deps.queryTabs || (chrome.tabs?.query ? ((options) => chrome.tabs.query(options)) : null);
  const makeCompositor = deps.createCompositor || createPageCompositor;
  const sleep = deps.sleep || delay;
  const clock = deps.clock || Date.now;
  const onProgress = deps.onProgress || (() => {});
  const target = { tabId: tab.id };
  let prepared = false;

  try {
    const meta = injectionResult(await executeScript({ target, func: preparePageForCapture }));
    prepared = true;
    if (!validMeta(meta)) throw new Error('OWL-Note could not measure this page');
    const offsets = captureOffsets(meta.documentHeight, meta.viewportHeight);
    if (offsets.length > MAX_CAPTURE_TILES) {
      throw new Error(`This page is too long to capture safely (${offsets.length} screenfuls)`);
    }

    let compositor = null;
    let lastCaptureAt = -Infinity;
    let previousY = -Infinity;
    for (let index = 0; index < offsets.length; index++) {
      const position = injectionResult(await executeScript({
        target,
        func: scrollPageForCapture,
        args: [0, offsets[index], index === 0],
      })) || { x: 0, y: offsets[index] };
      if (index > 0 && Number(position.y) <= previousY + 0.5) {
        throw new Error('The page stopped its scroll container from moving');
      }
      previousY = Number(position.y);

      const remaining = CAPTURE_INTERVAL_MS - (clock() - lastCaptureAt);
      if (remaining > 0) await sleep(remaining);
      if (queryTabs && Number.isInteger(tab.windowId)) {
        const active = await queryTabs({ active: true, windowId: tab.windowId });
        if (active?.[0]?.id !== tab.id) throw new Error('Keep this page active until OWL-Note finishes capturing it');
      }
      const dataUrl = await captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 86 });
      lastCaptureAt = clock();
      if (!compositor) compositor = await makeCompositor(meta, dataUrl, position);
      else await compositor.add(dataUrl, position);
      await onProgress({ completed: index + 1, total: offsets.length });
    }
    const result = await compositor.finish();
    return { ...result, tiles: offsets.length };
  } finally {
    if (prepared) {
      try { await executeScript({ target, func: restorePageAfterCapture }); } catch { /* navigation/restricted page */ }
    }
  }
}
