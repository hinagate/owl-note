// Smart selection capture keeps the fast formatted-text path, but when the selected
// range contains rendered objects it reuses the full-page compositor and crops only
// those objects into ordinary OWL-Note attachments.

import { captureFullPage } from './full-page-capture.js';
import { captureSelectionMarkdown } from './selection-capture.js';
import { assembleSmartPage, cropSmartPageImages } from './smart-page-capture.js';

function injectionResult(results) {
  return results?.[0]?.result;
}

function normalizedDocument(value) {
  if (!value || typeof value.markdown !== 'string' || typeof value.title !== 'string') return null;
  return { ...value, images: Array.isArray(value.images) ? value.images : [] };
}

export async function captureSmartSelection(info, tab, deps = {}) {
  if (!Number.isInteger(tab?.id)) throw new Error('The page tab is no longer available');
  const executeScript = deps.executeScript || ((options) => chrome.scripting.executeScript(options));
  const inspectPage = deps.inspectPage || captureSelectionMarkdown;
  const frameId = Number.isInteger(info?.frameId) ? info.frameId : null;
  const target = frameId === null ? { tabId: tab.id } : { tabId: tab.id, frameIds: [frameId] };
  const initial = normalizedDocument(injectionResult(await executeScript({
    target,
    func: inspectPage,
    args: ['smart-selection'],
  })));
  if (!initial) throw new Error('OWL-Note could not read the selected content');

  if (!initial.images.length) {
    return { title: initial.title, ...assembleSmartPage(initial), totalImages: 0 };
  }

  // Coordinates inside a child frame are relative to that frame, while Chrome's page
  // screenshot is relative to the top document. Preserve safe links rather than crop
  // the wrong pixels until a top-frame offset can be measured without extra permission.
  if (frameId !== null && frameId !== 0) {
    return { title: initial.title, ...assembleSmartPage(initial), totalImages: initial.images.length };
  }

  let inspected = initial;
  let copied = [];
  try {
    const takeFullPage = deps.captureFullPage || captureFullPage;
    const capture = await takeFullPage(tab, {
      executeScript: deps.executeScript,
      captureVisibleTab: deps.captureVisibleTab,
      queryTabs: deps.queryTabs,
      createCompositor: deps.createCompositor,
      sleep: deps.sleep,
      clock: deps.clock,
      onProgress: deps.onProgress,
      inspectPage,
      inspectArgs: ['smart-selection'],
      suppressSelectionHighlight: true,
    });
    const preparedInspection = normalizedDocument(capture.inspection);
    if (!preparedInspection?.images.length) throw new Error('The selected objects are no longer available');
    inspected = preparedInspection;
    const cropImages = deps.cropImages || cropSmartPageImages;
    copied = await cropImages(capture, inspected.images);
  } catch {
    // Keep selected text and safe source links even when screenshotting is unavailable.
  }

  return {
    title: inspected.title,
    ...assembleSmartPage(inspected, copied),
    totalImages: inspected.images.length,
  };
}
