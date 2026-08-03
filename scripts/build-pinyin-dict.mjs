// Bakes CC-CEDICT into the compact hanzi→pinyin table the extension loads at runtime.
//
// Runs at BUILD time only: cedict-json is a devDependency, so its ~16 MB JSON never enters
// the shipped bundle — only the generated table does.
//
// The table is small (~175 KB gzipped) because it stores exceptions, not readings. Each
// character gets one default reading, chosen by how often that reading wins across the
// whole phrase corpus; a phrase is stored ONLY when its actual pinyin differs from what
// those defaults would produce. Picking defaults by frequency rather than by dictionary
// order shrinks the phrase half from 394 KB to 114 KB, because it leaves only the genuine
// 多音字 exceptions — 銀行/yín háng is stored, 行走/xíng zǒu is not.
//
// Pronunciation data comes from CC-CEDICT via cedict-json, which is CC-BY-SA-4.0 — see
// node_modules/cedict-json/LICENSE. ShareAlike carries to the generated table, so both the
// source and the table's own licence are credited in the README's "Pronunciation data"
// section. This is DATA, not code: no URLs and no executable content, so it passes the
// release audit's remote-code scan, and it sits alongside the GPL source as an aggregate.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { MAX_PHRASE } from '../src/lib/segment.js';

const require = createRequire(import.meta.url);

const HAN_ONLY = /^[一-鿿㐀-䶿]+$/;
// Tone 5 (neutral) is last in each row, i.e. it takes no mark.
const VOWELS = { a: 'āáǎàa', o: 'ōóǒòo', e: 'ēéěèe', i: 'īíǐìi', u: 'ūúǔùu', 'ü': 'ǖǘǚǜü' };

/**
 * Convert one numbered CC-CEDICT syllable to its tone-marked form: `hang2` → `háng`.
 * CC-CEDICT spells ü as `u:`.
 */
export function toneMark(syllable) {
  const normalized = String(syllable || '').replaceAll('u:', 'ü').toLowerCase();
  const match = /^([a-zü]+)([1-5])$/.exec(normalized);
  if (!match) return normalized;
  const [, body, tone] = match;
  const slot = Number(tone) - 1;
  // Standard placement: a or o takes it; else e; else the LAST vowel, which puts it on the
  // u of `iu` and the i of `ui` exactly as the orthography requires.
  let at = -1;
  if (/[ao]/.test(body)) at = body.search(/[ao]/);
  else if (body.includes('e')) at = body.indexOf('e');
  else {
    const vowels = body.match(/[iuü]/g);
    if (vowels) at = body.lastIndexOf(vowels[vowels.length - 1]);
  }
  if (at < 0) return body;
  return body.slice(0, at) + (VOWELS[body[at]]?.[slot] ?? body[at]) + body.slice(at + 1);
}

const syllables = (pinyin) => String(pinyin || '').split(/\s+/).filter(Boolean).map(toneMark);

/**
 * @param {{traditional: string, simplified: string, pinyin: string}[]} entries
 * @returns {{ text: string, chars: number, phrases: number }}
 */
export function buildPinyinTable(entries = require('cedict-json/cedict.json')) {
  // Both script forms are read the same way, so index every distinct surface once. First
  // spelling wins, matching how the IPA table keeps CMUdict's primary entry.
  const surfaces = new Map();
  for (const entry of entries) {
    const reading = syllables(entry.pinyin);
    if (!reading.length) continue;
    for (const surface of [entry.traditional, entry.simplified]) {
      if (HAN_ONLY.test(surface) && !surfaces.has(surface)) surfaces.set(surface, reading);
    }
  }

  // Tally how often each character is read each way. A single-character entry is the
  // citation reading, so weight it enough to win ties against incidental phrase usage.
  const tally = new Map();
  for (const [surface, reading] of surfaces) {
    if (reading.length !== surface.length) continue; // can't align; contributes nothing
    const weight = surface.length === 1 ? 3 : 1;
    [...surface].forEach((char, i) => {
      const counts = tally.get(char) ?? new Map();
      counts.set(reading[i], (counts.get(reading[i]) ?? 0) + weight);
      tally.set(char, counts);
    });
  }
  const defaults = new Map();
  for (const [char, counts] of tally) {
    defaults.set(char, [...counts].sort((a, b) => b[1] - a[1])[0][0]);
  }

  const rows = [...defaults].map(([char, reading]) => `${char}\t${reading}`);
  const chars = rows.length;

  for (const [surface, reading] of surfaces) {
    if (surface.length < 2 || surface.length > MAX_PHRASE) continue;
    if (reading.length !== surface.length) continue;
    // Nothing to store when reading it character by character already gets it right.
    if ([...surface].every((char, i) => defaults.get(char) === reading[i])) continue;
    rows.push(`${surface}\t${reading.join(' ')}`);
  }

  return { text: `${rows.join('\n')}\n`, chars, phrases: rows.length - chars };
}

export function writePinyinTable(outPath) {
  const { text, chars, phrases } = buildPinyinTable();
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  writeFileSync(outPath, gz);
  const kb = Math.round(gz.length / 1024);
  const rawKb = Math.round(Buffer.byteLength(text, 'utf8') / 1024);
  console.log(`pinyin table -> ${outPath} (${chars} chars + ${phrases} exceptions, ${kb} KB gzipped from ${rawKb} KB)`);
  return { chars, phrases, bytes: gz.length };
}

// Allow `node scripts/build-pinyin-dict.mjs dist/pinyin-zh.tsv.gz` standalone as well as via esbuild.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  writePinyinTable(process.argv[2] || 'dist/pinyin-zh.tsv.gz');
}
