// scripts/pack.mjs
// Package dist/ into owl-note-<version>.zip for the Chrome Web Store.
//
// Why a custom packer instead of `Compress-Archive`/`zip`: on Windows,
// PowerShell 5.1's Compress-Archive and .NET's ZipFile write entry paths with
// BACKSLASHES (icons\icon-16.png). Chrome treats those as literal filenames, so
// the manifest's "icons/icon-16.png" lookups fail and the packed extension is
// broken. We reuse the project's own zip writer and feed it forward-slash paths.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { zipFiles } from '../src/lib/zip.js';

const DIST = 'dist';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const version = JSON.parse(readFileSync('manifest.json', 'utf8')).version;
const files = walk(DIST);
if (!files.length) throw new Error('dist/ is empty — run `npm run build:prod` first');

const entries = files.map((full) => ({
  // Path relative to dist/, with forward slashes so Chrome resolves subfolders.
  path: relative(DIST, full).split(sep).join('/'),
  data: new Uint8Array(readFileSync(full)),
}));

const blob = await zipFiles(entries);
const outName = `owl-note-${version}.zip`;
writeFileSync(outName, Buffer.from(await blob.arrayBuffer()));

console.log(`Packed ${entries.length} files -> ${outName}`);
for (const e of entries) console.log(`  ${e.path}`);
