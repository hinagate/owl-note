export const A4_PAGE_WIDTH = 595.28;
export const A4_PAGE_HEIGHT = 841.89;

const encoder = new TextEncoder();

function ascii(value) {
  return encoder.encode(value);
}

function decodeJpegDataUrl(dataUrl) {
  const match = /^data:image\/jpe?g;base64,([a-z0-9+/=\r\n]+)$/i.exec(dataUrl || '');
  if (!match) throw new Error('PDF page is not a JPEG data URL');
  const binary = atob(match[1].replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pdfNumber(value) {
  return Number(value.toFixed(3)).toString();
}

// This intentionally implements only the PDF subset OWL-Note needs: one JPEG
// XObject per page. Keeping the writer local and purpose-built avoids shipping
// dormant output modes from a general PDF library (including remote script
// loaders that Manifest V3 reviewers correctly reject).
export function createRasterPdf(pages, options = {}) {
  if (!Array.isArray(pages) || pages.length === 0) throw new Error('PDF has no pages');
  const pageWidth = options.pageWidth || A4_PAGE_WIDTH;
  const pageHeight = options.pageHeight || A4_PAGE_HEIGHT;
  if (!(pageWidth > 0) || !(pageHeight > 0)) throw new Error('Invalid PDF page size');

  const prepared = pages.map((page) => {
    if (!(page.pixelWidth > 0) || !(page.pixelHeight > 0)) throw new Error('Invalid PDF image size');
    const drawHeight = Math.min(pageHeight, pageWidth * page.pixelHeight / page.pixelWidth);
    return {
      jpeg: decodeJpegDataUrl(page.dataUrl),
      pixelWidth: Math.round(page.pixelWidth),
      pixelHeight: Math.round(page.pixelHeight),
      drawHeight,
    };
  });

  const chunks = [];
  const offsets = [];
  let byteLength = 0;
  const append = (value) => {
    const bytes = typeof value === 'string' ? ascii(value) : value;
    chunks.push(bytes);
    byteLength += bytes.byteLength;
  };
  const beginObject = (id) => {
    offsets[id] = byteLength;
    append(`${id} 0 obj\n`);
  };
  const endObject = () => append('\nendobj\n');
  const pageObjectId = (index) => 3 + index * 3;
  const imageObjectId = (index) => 4 + index * 3;
  const contentObjectId = (index) => 5 + index * 3;

  append(new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,
    0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a,
  ]));

  beginObject(1);
  append('<< /Type /Catalog /Pages 2 0 R >>');
  endObject();

  beginObject(2);
  append(`<< /Type /Pages /Count ${prepared.length} /Kids [${prepared.map((_, index) => `${pageObjectId(index)} 0 R`).join(' ')}] >>`);
  endObject();

  prepared.forEach((page, index) => {
    const pageId = pageObjectId(index);
    const imageId = imageObjectId(index);
    const contentId = contentObjectId(index);
    const imageName = `Im${index + 1}`;

    beginObject(pageId);
    append(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pdfNumber(pageWidth)} ${pdfNumber(pageHeight)}] /Resources << /XObject << /${imageName} ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    endObject();

    beginObject(imageId);
    append(`<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.byteLength} >>\nstream\n`);
    append(page.jpeg);
    append('\nendstream');
    endObject();

    const y = pageHeight - page.drawHeight;
    const commands = `q\n${pdfNumber(pageWidth)} 0 0 ${pdfNumber(page.drawHeight)} 0 ${pdfNumber(y)} cm\n/${imageName} Do\nQ\n`;
    const commandBytes = ascii(commands);
    beginObject(contentId);
    append(`<< /Length ${commandBytes.byteLength} >>\nstream\n`);
    append(commandBytes);
    append('endstream');
    endObject();
  });

  const xrefOffset = byteLength;
  const objectCount = 2 + prepared.length * 3;
  append(`xref\n0 ${objectCount + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= objectCount; id += 1) {
    append(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  append(`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return new Blob(chunks, { type: 'application/pdf' });
}
