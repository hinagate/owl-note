import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';

// Clean dist first so stale files (e.g. dropped .ttf/.woff fonts) never linger.
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

// Production builds (Chrome Web Store) minify; local dev builds stay readable.
const PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';

let creds = { clientId: '', clientSecret: '' };
try { creds = JSON.parse(readFileSync('.drive-credentials.json', 'utf8')); } catch { /* contributors without creds: Drive sync simply stays unconfigured */ }

// @huggingface/transformers' web build statically imports `onnxruntime-node` (it
// picks node vs web at runtime via apis.IS_NODE_ENV, which is false in our
// worker). Left alone, esbuild would try to bundle that native Node addon and
// fail. It's dead code in the browser, so we resolve it to an empty module. Only
// the embed-worker entry ever reaches this import; app.js never imports
// transformers, so this plugin is a no-op for the app bundle.
const stubOnnxNode = {
  name: 'stub-onnxruntime-node',
  setup(b) {
    b.onResolve({ filter: /^onnxruntime-node$/ }, () => ({ path: 'onnxruntime-node', namespace: 'stub-onnx-node' }));
    b.onLoad({ filter: /.*/, namespace: 'stub-onnx-node' }, () => ({ contents: 'export default {};', loader: 'js' }));
  },
};

await build({
  // embed-worker.js is a SECOND, self-contained iife entry (M9): only it imports
  // @huggingface/transformers, keeping the ~1MB lib out of app.js. iife format
  // means no code-splitting, so each entry stays a single standalone file.
  entryPoints: {
    app: 'src/app/app.js',
    'service-worker': 'src/background/service-worker.js',
    'embed-worker': 'src/workers/embed-worker.js',
  },
  bundle: true,
  format: 'iife',
  outdir: 'dist',
  target: 'chrome120',
  define: {
    __OWL_DRIVE_CLIENT_ID__: JSON.stringify(creds.clientId || ''),
    __OWL_DRIVE_CLIENT_SECRET__: JSON.stringify(creds.clientSecret || ''),
  },
  plugins: [stubOnnxNode],
  minify: PROD,
  logLevel: 'info',
});

// Ship the ONE ONNX Runtime WASM binary the embed worker requests at runtime.
// onnxruntime-web@1.26 (via @huggingface/transformers' `onnxruntime-web/webgpu`
// import -> ort.webgpu.bundle.min.mjs) hardcodes locateFile('ort-wasm-simd-
// threaded.asyncify.wasm', ...), so that exact single-threaded SIMD (Asyncify)
// artifact must live at the extension root where env...wasm.wasmPaths points.
// The threaded/jsep/jspi variants need COOP/COEP or WebGPU we don't ship.
const ortWasm = 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm';
if (existsSync(ortWasm)) cpSync(ortWasm, 'dist/ort-wasm-simd-threaded.asyncify.wasm');
else throw new Error(`Missing ORT WASM artifact: ${ortWasm}`);

cpSync('src/app/app.html', 'dist/app.html');
cpSync('src/app/app.css', 'dist/app.css');
cpSync('manifest.json', 'dist/manifest.json');
const theme = 'node_modules/highlight.js/styles/github.css';
if (existsSync(theme)) cpSync(theme, 'dist/github.css');

// KaTeX stylesheet + web fonts must ship locally — a Chrome extension can't pull
// them from a CDN, and the math glyphs won't render without the bundled fonts.
const katexCss = 'node_modules/katex/dist/katex.min.css';
if (existsSync(katexCss)) cpSync(katexCss, 'dist/katex.css');
const katexFonts = 'node_modules/katex/dist/fonts';
// Ship only WOFF2 — every modern Chromium supports it, so the .ttf/.woff copies are
// dead weight (~800 KB). KaTeX's @font-face lists woff2 first, so the browser never
// requests the omitted fallbacks.
if (existsSync(katexFonts)) cpSync(katexFonts, 'dist/fonts', { recursive: true, filter: (src) => !/\.(ttf|woff)$/.test(src) });

// mammoth (DOCX import) ships as a separate OFFICIAL file, NOT bundled into app.js —
// keeps it a hash-matchable library for review and isolates its bluebird `new Function`
// from our minified business logic. app.html loads it (window.mammoth) before app.js.
const mammothBrowser = 'node_modules/mammoth/mammoth.browser.min.js';
if (existsSync(mammothBrowser)) cpSync(mammothBrowser, 'dist/mammoth.browser.min.js');

console.log('Build complete -> dist/');
