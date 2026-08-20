// src/lib/image-downscale.js
// Inline base64 images from an import are kept at full resolution, but Chrome
// will not render multi-MB data: URIs as <img> (they're meant for small icons),
// so a real photo shows blank. This re-encodes each large inline image to a
// modest-sized WebP data: URI that the browser renders fine. WebP because Chrome
// renders it well and it is markedly smaller than JPEG/PNG at the same quality.
//
// The canvas/bitmap work is browser-only (createImageBitmap + OffscreenCanvas);
// outside a browser (Node/jsdom tests) it is a no-op, returning the original URI.
// The body-rewrite orchestration is pure and accepts an injectable transform, so
// it is unit-testable without a real canvas.

// Matches a Markdown image whose URL is a base64 image data: URI. Captures the
// `![alt](` prefix, the data: URI itself, and the closing `)`.
const IMG_DATA_URI = /(!\[[^\]]*\]\()(data:image\/[\w.+-]+;base64,[A-Za-z0-9+/=]+)(\))/g;

function approxBytes(dataUri) {
  const i = dataUri.indexOf(',');
  return i < 0 ? 0 : Math.floor((dataUri.length - i - 1) * 0.75);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// The target pixel size for an image, capped on EACH AXIS. Pure, so the sizing rule
// is testable without a canvas — the encode path around it is browser-only.
export function fitWithin(width, height, maxWidth = 1280, maxHeight = 2048) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)), scale };
}

// Re-encode one image data: URI to a downscaled WebP data: URI. Browser-only;
// returns the input unchanged when the browser APIs are absent, when the image
// is already small enough to render, or on any decode/encode failure.
// The cap is per-AXIS, not on the longest side. A single maxDim scales a portrait
// image by its HEIGHT, so its width lands far below the cap — a 9:19.5 phone
// screenshot was stored 591px wide and then stretched 2.25x to reach the 1332px
// the PDF renders a full-width image at, which is what made shared photos look
// soft. Capping width and height independently keeps the full 1280px of width for
// tall images while still bounding how much a very long capture can grow.
// Landscape, square and wide images are unaffected: their width hits maxWidth
// first, exactly as maxDim did, so they re-encode to byte-identical output.
export async function downscaleDataUri(dataUri, { maxWidth = 1280, maxHeight = 2048, quality = 0.82, skipUnderBytes = 60000 } = {}) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') return dataUri;
  if (approxBytes(dataUri) < skipUnderBytes) return dataUri; // small images already render fine
  try {
    const blob = await (await fetch(dataUri)).blob();
    const bmp = await createImageBitmap(blob);
    const { width: w, height: h } = fitWithin(bmp.width, bmp.height, maxWidth, maxHeight);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const out = await canvas.convertToBlob({ type: 'image/webp', quality });
    // Only adopt the re-encode if it actually shrank the image.
    if (out.size >= blob.size) return dataUri;
    return await blobToDataURL(out);
  } catch {
    return dataUri; // unreadable/unsupported image — keep the original
  }
}

// Read a user-picked image File/Blob into a data: URI for inserting into a note,
// downscaling it the same way an import does (small images keep their original
// bytes/format; large photos become a modest WebP).
export async function imageFileToDataUri(file, opts = {}) {
  return downscaleDataUri(await blobToDataURL(file), opts);
}

// Rewrite every inline base64 image in a Markdown body via `transform` (async).
// Pure orchestration: non-image links, plain text, and `[attachment: …]` markers
// are left untouched. `opts.transform` is injectable for testing; by default each
// image is run through downscaleDataUri with the remaining opts.
export async function downscaleImagesInBody(body, opts = {}) {
  const src = String(body ?? '');
  const transform = opts.transform || ((uri) => downscaleDataUri(uri, opts));
  const matches = [...src.matchAll(IMG_DATA_URI)];
  if (!matches.length) return src;
  let out = '';
  let last = 0;
  for (const m of matches) {
    out += src.slice(last, m.index) + m[1] + (await transform(m[2])) + m[3];
    last = m.index + m[0].length;
  }
  return out + src.slice(last);
}
