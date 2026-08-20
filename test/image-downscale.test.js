import { describe, it, expect } from 'vitest';
import { downscaleImagesInBody, downscaleDataUri, fitWithin } from '../src/lib/image-downscale.js';

describe('downscaleImagesInBody (orchestration)', () => {
  const fake = async () => 'data:image/webp;base64,SCALED';

  it('rewrites every inline base64 image via the transform', async () => {
    const body = 'before ![a](data:image/png;base64,AAAA) mid ![b](data:image/jpeg;base64,/9j/9w==) end';
    const out = await downscaleImagesInBody(body, { transform: fake });
    expect(out).toBe('before ![a](data:image/webp;base64,SCALED) mid ![b](data:image/webp;base64,SCALED) end');
  });

  it('leaves non-image data URIs, http images, attachment markers and plain text untouched', async () => {
    const body = '[attachment: doc.pdf]\n\n![remote](https://x/y.png)\n\nplain text';
    const out = await downscaleImagesInBody(body, { transform: fake });
    expect(out).toBe(body);
  });

  it('handles a linked image (image nested in a link)', async () => {
    const body = '[![icon](data:image/webp;base64,UklGRg==) label](https://site)';
    const out = await downscaleImagesInBody(body, { transform: fake });
    expect(out).toBe('[![icon](data:image/webp;base64,SCALED) label](https://site)');
  });

  it('returns the body unchanged when there are no inline images', async () => {
    const body = '# Title\n\n```\nSELECT 1\n```';
    expect(await downscaleImagesInBody(body, { transform: fake })).toBe(body);
  });

  it('default transform is a no-op outside a browser (no createImageBitmap)', async () => {
    // jsdom/node has no createImageBitmap/OffscreenCanvas, so the body is preserved.
    const body = '![big](data:image/png;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=)';
    expect(await downscaleImagesInBody(body)).toBe(body);
  });
});

describe('downscaleDataUri', () => {
  it('is a no-op outside a browser', async () => {
    const uri = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    expect(await downscaleDataUri(uri)).toBe(uri);
  });
});


// A single longest-side cap scales a portrait image by its HEIGHT, leaving its width
// far under the cap. That is what made shared photos look soft: the PDF renders a
// full-width image at 666 CSS px * the capture scale, so an under-wide photo is
// upscaled to reach it. Capping each axis keeps the width these images need.
describe('fitWithin (the sizing rule behind stored photo sharpness)', () => {
  const widthOf = (w, h) => fitWithin(w, h).width;

  it('keeps the full width for tall images, where a longest-side cap lost it', () => {
    expect(widthOf(1170, 2532)).toBe(946); // phone screenshot: was 591 under maxDim 1280
    expect(widthOf(3000, 4000)).toBe(1280); // portrait 3:4: was 960
  });

  it('leaves landscape, square and wide images exactly as they were', () => {
    expect(fitWithin(4000, 3000)).toMatchObject({ width: 1280, height: 960 });
    expect(fitWithin(3000, 3000)).toMatchObject({ width: 1280, height: 1280 });
    expect(fitWithin(3840, 2160)).toMatchObject({ width: 1280, height: 720 });
  });

  it('never enlarges an image that is already small', () => {
    expect(fitWithin(400, 300)).toMatchObject({ width: 400, height: 300, scale: 1 });
    expect(fitWithin(1280, 2048).scale).toBe(1);
  });

  it('still bounds a very long capture, so height cannot grow without limit', () => {
    const tall = fitWithin(1000, 20000);
    expect(tall.height).toBe(2048);
    expect(tall.width).toBe(102);
  });

  it('honours explicit caps and keeps both axes within them', () => {
    for (const [w, h] of [[4000, 3000], [1170, 2532], [800, 600], [5000, 40000]]) {
      const out = fitWithin(w, h, 1280, 2048);
      expect(out.width).toBeLessThanOrEqual(1280);
      expect(out.height).toBeLessThanOrEqual(2048);
      expect(out.width).toBeGreaterThanOrEqual(1);
    }
  });
});
