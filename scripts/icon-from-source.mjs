// Copy the designer-supplied, size-specific icons into the extension build.
// The 16 px and 32 px renders use the head-only artwork so it stays legible in
// Chrome's toolbar. Larger extension and store icons keep the full owl.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';

const sizes = [16, 32, 48, 128];

function assertPngSize(path, expected) {
  const bytes = readFileSync(path);
  const isPng = bytes.length >= 24
    && bytes[0] === 0x89
    && bytes.toString('ascii', 1, 4) === 'PNG';
  const width = isPng ? bytes.readUInt32BE(16) : 0;
  const height = isPng ? bytes.readUInt32BE(20) : 0;
  if (!isPng || width !== expected || height !== expected) {
    throw new Error(`Expected ${path} to be a ${expected}x${expected} PNG`);
  }
}

mkdirSync('dist/icons', { recursive: true });
for (const size of sizes) {
  const source = `assets/icons/icon-${size}.png`;
  const destination = `dist/icons/icon-${size}.png`;
  assertPngSize(source, size);
  copyFileSync(source, destination);
}

console.log('Designer icons copied to dist/icons/');
