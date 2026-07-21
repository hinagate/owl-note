// Convert a page into structured Markdown and copy its rendered content images into
// ordinary OWL-Note attachments. Text-only pages stay fast; pages with images reuse the
// browser-native full-page compositor so cross-origin and expiring image URLs are not a
// dependency of the saved note.

import { captureFullPage } from './full-page-capture.js';
import { captureSelectionMarkdown } from './selection-capture.js';
import { contentHash } from './note.js';

function injectionResult(results) {
  return results?.[0]?.result;
}

function validDocument(value) {
  return value && typeof value.markdown === 'string' && typeof value.title === 'string'
    && Array.isArray(value.images);
}

async function decodeImage(dataUri) {
  const response = await fetch(dataUri);
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

function imageFilename(image) {
  const stem = String(image?.alt || 'Page image')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 80) || 'Page image';
  return /\.[a-z0-9]{2,5}$/i.test(stem) ? stem.replace(/\.[^.]+$/, '.jpg') : `${stem}.jpg`;
}

function safeRemoteImage(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.href.replace(/</g, '%3C').replace(/>/g, '%3E')
      : '';
  } catch {
    return '';
  }
}

function markdownLabel(value) {
  return String(value || 'Image').replace(/\\/g, '\\\\').replace(/([`*_[\]])/g, '\\$1');
}

/** Crop page-image rectangles from the already stitched full-page JPEG. */
export async function cropSmartPageImages(capture, images, deps = {}) {
  const decode = deps.decode || decodeImage;
  const Canvas = deps.OffscreenCanvas || globalThis.OffscreenCanvas;
  if (!Canvas) throw new Error('This browser cannot copy page images');
  const bitmap = await decode(capture?.dataUri);
  const documentHeight = Number(capture?.captureMeta?.documentHeight);
  const captureWidth = Number(capture?.captureMeta?.captureWidth);
  if (!bitmap || !(documentHeight > 0) || !(captureWidth > 0)) {
    bitmap?.close?.();
    throw new Error('The page image coordinate map is unavailable');
  }

  const scaleX = bitmap.width / captureWidth;
  const scaleY = bitmap.height / documentHeight;
  const copied = [];
  try {
    for (const image of images || []) {
      const left = Math.max(0, Math.floor((Number(image.x) || 0) * scaleX));
      const top = Math.max(0, Math.floor((Number(image.y) || 0) * scaleY));
      const right = Math.min(bitmap.width, Math.ceil(((Number(image.x) || 0) + (Number(image.width) || 0)) * scaleX));
      const bottom = Math.min(bitmap.height, Math.ceil(((Number(image.y) || 0) + (Number(image.height) || 0)) * scaleY));
      const width = right - left;
      const height = bottom - top;
      if (width < 2 || height < 2) continue;

      const canvas = new Canvas(width, height);
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) continue;
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.90 });
      const dataUri = await blobToDataUri(blob);
      copied.push({
        index: image.index,
        id: contentHash(dataUri),
        name: imageFilename(image),
        mime: 'image/jpeg',
        dataUri,
        width,
        height,
      });
    }
  } finally {
    bitmap.close?.();
  }
  return copied;
}

export function assembleSmartPage(documentCapture, copiedImages = []) {
  let markdown = String(documentCapture?.markdown || '').trim();
  const copiedByIndex = new Map(copiedImages.map((image) => [image.index, image]));
  let missed = 0;
  for (const image of documentCapture?.images || []) {
    const token = `owl-smart-img:${image.index}`;
    const copied = copiedByIndex.get(image.index);
    if (copied) {
      markdown = markdown.replaceAll(token, `owl-img:${copied.id}`);
      continue;
    }
    const remote = safeRemoteImage(image.src);
    const placeholder = image.placeholder || `![${markdownLabel(image.alt)}](${token})`;
    if (remote) markdown = markdown.replaceAll(placeholder, `[Image: ${markdownLabel(image.alt)}](<${remote}>)`);
    else markdown = markdown.replaceAll(placeholder, `*Image could not be copied: ${markdownLabel(image.alt)}*`);
    missed++;
  }

  if (missed) {
    markdown = [markdown, `> OWL-Note could not copy ${missed} image${missed === 1 ? '' : 's'}; original links were preserved when available.`]
      .filter(Boolean).join('\n\n');
  }
  const unique = [];
  const seen = new Set();
  for (const image of copiedImages) {
    if (!seen.has(image.id)) { seen.add(image.id); unique.push(image); }
  }
  return { markdown, attachments: unique, copiedImages: copiedImages.length, missedImages: missed };
}

export async function captureSmartPage(tab, deps = {}) {
  if (!Number.isInteger(tab?.id)) throw new Error('The page tab is no longer available');
  const executeScript = deps.executeScript || ((options) => chrome.scripting.executeScript(options));
  const inspectPage = deps.inspectPage || captureSelectionMarkdown;
  const initial = injectionResult(await executeScript({
    target: { tabId: tab.id },
    func: inspectPage,
    args: [true],
  }));
  if (!validDocument(initial) || !initial.markdown.trim()) {
    throw new Error('OWL-Note could not find readable page content');
  }

  if (!initial.images.length) {
    return { title: initial.title, ...assembleSmartPage(initial), totalImages: 0 };
  }

  const takeFullPage = deps.captureFullPage || captureFullPage;
  let inspected = initial;
  let copied = [];
  try {
    const capture = await takeFullPage(tab, {
      executeScript: deps.executeScript,
      captureVisibleTab: deps.captureVisibleTab,
      queryTabs: deps.queryTabs,
      createCompositor: deps.createCompositor,
      sleep: deps.sleep,
      clock: deps.clock,
      onProgress: deps.onProgress,
      inspectPage,
      inspectArgs: [true],
    });
    if (validDocument(capture.inspection)) inspected = capture.inspection;
    const cropImages = deps.cropImages || cropSmartPageImages;
    copied = await cropImages(capture, inspected.images);
  } catch {
    // Preserve the semantic note even when a page is too long/restricted to screenshot.
    // assembleSmartPage keeps safe original URLs and adds a visible partial-copy warning.
  }

  return {
    title: inspected.title,
    ...assembleSmartPage(inspected, copied),
    totalImages: inspected.images.length,
  };
}
