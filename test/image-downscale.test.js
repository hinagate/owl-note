import { describe, it, expect } from 'vitest';
import { downscaleImagesInBody, downscaleDataUri } from '../src/lib/image-downscale.js';

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
