// Bakes CMUdict into the compact lookup table the extension loads at runtime.
//
// Runs at BUILD time only: cmu-pronouncing-dictionary is a devDependency, so the ~3.5 MB
// ARPAbet source never enters the shipped bundle — only the generated table does, and that
// is fetched lazily the first time a reader turns phonetics on.
//
// Format is TSV (`word\tipa\n`), not JSON: same data, no quoting overhead, and it streams
// into a Map without building an intermediate object for 125k keys. Shipped gzipped —
// 2.5 MB to 0.8 MB — because the browser can inflate it with DecompressionStream for free,
// and a default-off feature has no business adding 2.5 MB to everyone's download.
//
// Pronunciation data comes from the CMU Pronouncing Dictionary (Carnegie Mellon), shipped
// here via cmu-pronouncing-dictionary, which is ISC — see its licence at
// node_modules/cmu-pronouncing-dictionary/license. ISC is compatible with this repo's
// GPL-3.0-or-later. The generated table is DATA, not code: it carries no URLs and no
// executable content, so it passes the release audit's remote-code scan.
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { dictionary } from 'cmu-pronouncing-dictionary';
import { arpabetToIpa } from '../src/lib/arpabet.js';

// CMUdict lists alternate pronunciations as `word(2)`, `word(3)`. One reading per word is
// all a ruby annotation can show, so keep the primary entry and drop the variants.
const ALTERNATE = /\(\d+\)$/;
// Must contain a letter: the source also holds bare punctuation entries ("'em" is fine,
// but standalone symbol rows are noise).
const HAS_LETTER = /[a-z]/;

export function buildIpaTable(source = dictionary) {
  const rows = [];
  let skipped = 0;
  for (const [word, arpabet] of Object.entries(source)) {
    if (ALTERNATE.test(word) || !HAS_LETTER.test(word)) { skipped += 1; continue; }
    const ipa = arpabetToIpa(arpabet);
    // A word whose every symbol was unrecognised would annotate as an empty box.
    if (!ipa) { skipped += 1; continue; }
    rows.push(`${word}\t${ipa}`);
  }
  return { text: `${rows.join('\n')}\n`, count: rows.length, skipped };
}

export function writeIpaTable(outPath) {
  const { text, count, skipped } = buildIpaTable();
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  writeFileSync(outPath, gz);
  const kb = Math.round(gz.length / 1024);
  const rawKb = Math.round(Buffer.byteLength(text, 'utf8') / 1024);
  console.log(`IPA table -> ${outPath} (${count} words, ${skipped} skipped, ${kb} KB gzipped from ${rawKb} KB)`);
  return { count, skipped, bytes: gz.length };
}

// Allow `node scripts/build-ipa-dict.mjs dist/ipa-en.tsv.gz` standalone as well as via esbuild.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  writeIpaTable(process.argv[2] || 'dist/ipa-en.tsv.gz');
}
