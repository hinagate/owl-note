// src/lib/citation.js
//
// APA 7th-edition reference strings, built from the fields the Reference popup
// collects. Pure formatting: no lookup, no network, nothing leaves the device.

// APA lists up to 20 authors. From 21 it lists the first 19, an ellipsis, then the
// FINAL author — the 20th is deliberately dropped, which is easy to get wrong.
const MAX_LISTED_AUTHORS = 20;
const HEAD_BEFORE_ELLIPSIS = 19;

/**
 * "Vaswani, Ashish" -> "Vaswani, A."   "Aidan N. Gomez" -> "Gomez, A. N."
 * Accepts either order: with a comma the family name comes first, without one it is
 * the last token. Already-initialised input ("Vaswani, A.") passes through unchanged.
 */
export function formatAuthor(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!name) return '';
  let family;
  let givens;
  if (name.includes(',')) {
    const [last, rest = ''] = name.split(',');
    family = last.trim();
    givens = rest.trim();
  } else {
    const parts = name.split(' ');
    family = parts.pop();
    givens = parts.join(' ');
  }
  if (!family) return '';
  const initials = givens
    .split(/[\s.]+/)
    .filter(Boolean)
    // Hyphenated given names keep both initials: "Jean-Luc" -> "J.-L."
    .map((part) => part.split('-').filter(Boolean).map((bit) => `${bit[0].toUpperCase()}.`).join('-'))
    .join(' ');
  return initials ? `${family}, ${initials}` : family;
}

/**
 * Split what the user typed into one author per entry. Semicolons and newlines
 * separate people; a comma cannot, because "Vaswani, Ashish" contains one.
 */
export function parseAuthorList(raw) {
  return String(raw ?? '')
    .split(/[;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The author segment of an APA reference, with APA's 1 / 2 / 3-20 / 21+ rules. */
export function formatAuthors(authors = []) {
  const names = authors.map(formatAuthor).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]}, & ${names[1]}`;
  if (names.length <= MAX_LISTED_AUTHORS) {
    return `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  }
  // 21+: first 19, ellipsis, last. APA drops the ampersand in this form.
  return `${names.slice(0, HEAD_BEFORE_ELLIPSIS).join(', ')}, ... ${names[names.length - 1]}`;
}

/** The year out of anything year-shaped; blank stays blank so the caller can say n.d. */
export function citationYear(value) {
  const match = /(\d{4})/.exec(String(value ?? ''));
  return match ? match[1] : '';
}

function normaliseUrl(url, doi) {
  const cleanDoi = String(doi ?? '').trim().replace(/^https?:\/\/doi\.org\//i, '');
  if (cleanDoi) return `https://doi.org/${cleanDoi}`;
  return String(url ?? '').trim();
}

/**
 * The stand-in for a field the user has not filled in. Missing parts stay visible as
 * placeholders rather than collapsing the line, so typing an author and a year shows
 * progress immediately and the rest can be finished in the note. An earlier version
 * returned nothing at all without a title, which meant a half-filled form silently
 * threw away what had been typed.
 */
export const APA_PLACEHOLDERS = {
  authors: 'Author, A. A.',
  year: 'Year',
  title: 'Title',
  source: 'Source',
  url: 'URL',
};

/**
 * An APA 7 reference from the popup's fields, with placeholders for whatever is
 * missing. Passing nothing yields the blank skeleton, so EMPTY_REFERENCE below and a
 * fully-typed citation come from the same code path and can never drift apart.
 *
 * NOTE ON TITLE CASE: APA wants sentence case, but people paste the published title
 * and lowercasing mechanically destroys acronyms and proper nouns ("BLEU" -> "bleu",
 * "English" -> "english"). The title is kept exactly as typed — the same choice
 * Zotero makes — because a wrong title is worse than a wrongly-cased one.
 *
 * The SOURCE is italicised, not the title: that is the journal-article form, which is
 * what most citations here will be. (APA italicises the title instead for a
 * standalone work; that distinction is left to the user to adjust.)
 */
export function formatApa({ authors = [], year = '', title = '', source = '', url = '', doi = '' } = {}) {
  const who = formatAuthors(authors) || APA_PLACEHOLDERS.authors;
  const when = citationYear(year) || APA_PLACEHOLDERS.year;
  const what = String(title).trim() || APA_PLACEHOLDERS.title;
  const where = String(source).trim() || APA_PLACEHOLDERS.source;
  const link = normaliseUrl(url, doi) || APA_PLACEHOLDERS.url;
  return `${who} (${when}). ${what}. *${where}*. ${link}`.replace(/\s+/g, ' ').trim();
}

/** The all-placeholder reference: what an untouched form inserts. */
export const EMPTY_REFERENCE = formatApa({});

/** True when the user has actually typed something into any field. */
export function hasCitationContent({ authors = [], year = '', title = '', source = '', url = '', doi = '' } = {}) {
  return Boolean(
    authors.length
    || String(year).trim()
    || String(title).trim()
    || String(source).trim()
    || String(url).trim()
    || String(doi).trim(),
  );
}
