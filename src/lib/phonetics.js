// Runtime side of the phonetics reader: load the baked IPA table, and split text into
// the word/gap runs a ruby annotator rebuilds from. Pure except for loadIpaTable, which
// takes its fetch so tests never touch the network.
//
// The table is fetched, not bundled. It is ~800 KB gzipped and only ever needed by a
// reader who has switched phonetics ON, so paying for it at import time would tax every
// user for a default-off feature.

const APOSTROPHES = /[’‘＇]/g;

// A word may carry internal apostrophes and hyphens because CMUdict does too: "don't",
// "cat's" and "well-known" are all single entries. Splitting on them would turn one
// correct lookup into two misses.
const WORD = /\p{L}+(?:['-]\p{L}+)*/gu;

/** @param {string} text TSV as produced by scripts/build-ipa-dict.mjs */
export function parseIpaTable(text) {
  const table = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    table.set(line.slice(0, tab), line.slice(tab + 1));
  }
  return table;
}

/** Lookup key: CMUdict is lowercase and uses the ASCII apostrophe. */
export function normalizeWord(raw) {
  return String(raw || '').replace(APOSTROPHES, "'").toLowerCase();
}

/**
 * Split text into alternating runs so an annotator can wrap the words and leave every
 * space, digit and punctuation mark exactly where it was.
 * @returns {{ text: string, isWord: boolean }[]}
 */
export function tokenize(text) {
  const source = String(text || '');
  const out = [];
  let at = 0;
  for (const match of source.matchAll(WORD)) {
    if (match.index > at) out.push({ text: source.slice(at, match.index), isWord: false });
    out.push({ text: match[0], isWord: true });
    at = match.index + match[0].length;
  }
  if (at < source.length) out.push({ text: source.slice(at), isWord: false });
  return out;
}

/** @returns {string|null} IPA, or null when the word is not in the dictionary. */
export function lookup(table, raw) {
  if (!table) return null;
  return table.get(normalizeWord(raw)) ?? null;
}

/**
 * Fetch and inflate the baked table. Chrome inflates gzip natively, so shipping the
 * compressed file costs nothing at runtime and saves 1.8 MB in the package.
 */
export async function loadIpaTable(url, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`IPA table unavailable (${res.status})`);
  const inflated = res.body.pipeThrough(new DecompressionStream('gzip'));
  return parseIpaTable(await new Response(inflated).text());
}

let pending = null;

/**
 * Load once per page. The failure is NOT cached: a reader who toggles phonetics on while
 * offline must be able to succeed on the next try rather than be stuck until reload.
 */
export function ensureIpaTable(url, fetchImpl) {
  if (!pending) {
    pending = loadIpaTable(url, fetchImpl).catch((error) => {
      pending = null;
      throw error;
    });
  }
  return pending;
}

export function resetIpaTable() {
  pending = null;
}
