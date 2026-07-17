// One source of truth for the semantic embedding space. Every value that can
// change vector geometry belongs here and in EMBEDDING_FINGERPRINT. Changing any
// of them intentionally invalidates the persisted IndexedDB vectors so the app
// rebuilds documents before embedding another query.

export const EMBEDDING_MODEL_ID = 'Xenova/multilingual-e5-small';
export const EMBEDDING_MODEL_REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
export const EMBEDDING_DTYPE = 'q8';
export const EMBEDDING_DIMENSION = 384;
export const EMBEDDING_POOLING = 'mean';
export const EMBEDDING_NORMALIZE = true;
export const EMBEDDING_PASSAGE_PREFIX = 'passage: ';
export const EMBEDDING_QUERY_PREFIX = 'query: ';
export const EMBEDDING_RUNTIME = '@huggingface/transformers@4.2.0';

// Keep this readable rather than hashing it: the value is persisted only as
// local metadata, and a readable mismatch is much easier to diagnose.
export const EMBEDDING_FINGERPRINT = [
  'owl-embedding-v1',
  `${EMBEDDING_MODEL_ID}@${EMBEDDING_MODEL_REVISION}`,
  `runtime=${EMBEDDING_RUNTIME}`,
  `dtype=${EMBEDDING_DTYPE}`,
  `dim=${EMBEDDING_DIMENSION}`,
  `pooling=${EMBEDDING_POOLING}`,
  `normalize=${EMBEDDING_NORMALIZE}`,
  `passage-prefix=${JSON.stringify(EMBEDDING_PASSAGE_PREFIX)}`,
  `query-prefix=${JSON.stringify(EMBEDDING_QUERY_PREFIX)}`,
].join('|');

// Stored alongside the fingerprint for diagnostics and future migrations.
export const EMBEDDING_METADATA = Object.freeze({
  fingerprint: EMBEDDING_FINGERPRINT,
  model: EMBEDDING_MODEL_ID,
  revision: EMBEDDING_MODEL_REVISION,
  runtime: EMBEDDING_RUNTIME,
  dtype: EMBEDDING_DTYPE,
  dimension: EMBEDDING_DIMENSION,
  pooling: EMBEDDING_POOLING,
  normalize: EMBEDDING_NORMALIZE,
  passagePrefix: EMBEDDING_PASSAGE_PREFIX,
  queryPrefix: EMBEDDING_QUERY_PREFIX,
});
