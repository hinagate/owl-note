import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync, rmSync } from 'node:fs';

// Clean dist first so stale files (e.g. dropped .ttf/.woff fonts) never linger.
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

// Production builds (Chrome Web Store) minify; local dev builds stay readable.
const PROD = process.argv.includes('--prod') || process.env.NODE_ENV === 'production';

await build({
  entryPoints: { app: 'src/app/app.js', 'service-worker': 'src/background/service-worker.js' },
  bundle: true,
  format: 'iife',
  outdir: 'dist',
  target: 'chrome120',
  minify: PROD,
  logLevel: 'info',
});

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
