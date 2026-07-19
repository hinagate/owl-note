// Audit the exact compiled directory submitted to the Chrome Web Store.
// Manifest V3 permits remote data, but all executable logic (including WASM)
// must be packaged with the extension.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = resolve(projectRoot, process.argv[2] || 'dist');
const failures = [];

function fail(message) {
  failures.push(message);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} is missing or invalid JSON: ${error.message}`);
    return null;
  }
}

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function relativeReleasePath(path) {
  return relative(releaseDir, path).split(sep).join('/');
}

function assertPackaged(path, label) {
  if (!path) return;
  const normalized = String(path).replaceAll('/', sep);
  if (!existsSync(join(releaseDir, normalized))) fail(`${label} points to missing file: ${path}`);
}

function assertRelativeResource(fromPath, reference, label) {
  const value = String(reference || '').trim();
  if (!value || value.startsWith('#') || /^(?:data|blob):/i.test(value)) return;
  if (/^(?:https?:)?\/\//i.test(value)) {
    fail(`${label} loads a remote resource: ${value}`);
    return;
  }
  const clean = value.split(/[?#]/, 1)[0];
  const target = resolve(value.startsWith('/') ? releaseDir : dirname(fromPath), clean.replace(/^\//, ''));
  if (target !== releaseDir && !target.startsWith(`${releaseDir}${sep}`)) {
    fail(`${label} escapes the release directory: ${value}`);
  } else if (!existsSync(target)) {
    fail(`${label} points to missing file: ${relativeReleasePath(fromPath)} -> ${value}`);
  }
}

if (!existsSync(releaseDir) || !statSync(releaseDir).isDirectory()) {
  throw new Error(`Release directory does not exist: ${releaseDir}`);
}

const files = walk(releaseDir);
if (files.length === 0) fail('Release directory is empty');

const sourceManifestPath = join(projectRoot, 'manifest.json');
const releaseManifestPath = join(releaseDir, 'manifest.json');
const packagePath = join(projectRoot, 'package.json');
const lockPath = join(projectRoot, 'package-lock.json');
const sourceManifest = readJson(sourceManifestPath, 'Source manifest');
const releaseManifest = readJson(releaseManifestPath, 'Release manifest');
const packageJson = readJson(packagePath, 'package.json');
const packageLock = readJson(lockPath, 'package-lock.json');

if (sourceManifest && releaseManifest) {
  if (readFileSync(sourceManifestPath).compare(readFileSync(releaseManifestPath)) !== 0) {
    fail('dist/manifest.json is stale; rebuild before packaging');
  }
  if (sourceManifest.manifest_version !== 3) fail('manifest_version must be 3');
  const csp = sourceManifest.content_security_policy?.extension_pages || '';
  if (!csp.includes("script-src 'self'")) fail("Extension CSP must restrict scripts to 'self'");
  if (/https?:|\*|['"]unsafe-(?:eval|inline)['"]|\b(?:data|blob):|\bnonce-|\bsha(?:256|384|512)-/i.test(csp)) {
    fail(`Extension CSP permits remote, inline, or evaluated JavaScript: ${csp}`);
  }

  assertPackaged(sourceManifest.background?.service_worker, 'background.service_worker');
  assertPackaged(sourceManifest.action?.default_popup, 'action.default_popup');
  for (const [size, path] of Object.entries(sourceManifest.action?.default_icon || {})) {
    assertPackaged(path, `action.default_icon[${size}]`);
  }
  for (const [size, path] of Object.entries(sourceManifest.icons || {})) {
    assertPackaged(path, `icons[${size}]`);
  }
  for (const [name, path] of Object.entries(sourceManifest.chrome_url_overrides || {})) {
    assertPackaged(path, `chrome_url_overrides.${name}`);
  }
  const hostPermissions = [
    ...(sourceManifest.host_permissions || []),
    ...(sourceManifest.optional_host_permissions || []),
  ];
  for (const permission of hostPermissions) {
    if (permission === '<all_urls>' || /:\/\/\*\//.test(permission)) {
      fail(`Manifest contains an unnecessarily broad host permission: ${permission}`);
    }
  }
}

for (const path of [
  'app.html',
  'app.css',
  'app.js',
  'service-worker.js',
  'embed-worker.js',
  'mammoth.browser.min.js',
  'html2canvas.min.js',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
]) assertPackaged(path, 'Required runtime file');

const exactVendorCopies = [
  ['mammoth.browser.min.js', 'node_modules/mammoth/mammoth.browser.min.js'],
  ['html2canvas.min.js', 'node_modules/html2canvas/dist/html2canvas.min.js'],
  ['ort-wasm-simd-threaded.asyncify.mjs', 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs'],
  ['ort-wasm-simd-threaded.asyncify.wasm', 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm'],
];
for (const [releasePath, sourcePath] of exactVendorCopies) {
  const packagedPath = join(releaseDir, releasePath);
  const installedPath = join(projectRoot, sourcePath);
  if (!existsSync(packagedPath) || !existsSync(installedPath)) continue;
  if (readFileSync(packagedPath).compare(readFileSync(installedPath)) !== 0) {
    fail(`${releasePath} is not an exact copy of ${sourcePath}`);
  }
}

const versions = [
  ['manifest.json', sourceManifest?.version],
  ['package.json', packageJson?.version],
  ['package-lock.json', packageLock?.version],
  ['package-lock root package', packageLock?.packages?.['']?.version],
];
const expectedVersion = versions[0][1];
for (const [label, version] of versions) {
  if (!version || version !== expectedVersion) fail(`Version mismatch: ${label} has ${version || '(missing)'}, expected ${expectedVersion}`);
}

const forbiddenFilePatterns = [
  [/\.map$/i, 'source map'],
  [/(?:^|\/)(?:\.env|\.drive-credentials\.json)$/i, 'credential file'],
  [/\.(?:pem|p12|pfx|key)$/i, 'private key'],
];
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.mjs', '.txt']);
const remoteExecutableUrl = /https?:\/\/[^\s"'`<>()\\]+\.(?:c?js|mjs|wasm)(?:[?#][^\s"'`<>()\\]*)?/gi;
const knownDocumentationUrls = new Set([
  'https://github.com/highlightjs/highlight.js',
  'https://github.com/huggingface/transformers.js',
  'https://huggingface.co/docs/transformers.js',
]);
const remoteLoaderPatterns = [
  /\b(?:import|importScripts)\s*\(\s*["'`]https?:\/\//i,
  /\bnew\s+(?:Shared)?Worker\s*\(\s*["'`]https?:\/\//i,
  /<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i,
  /\.src\s*=\s*["'`]https?:\/\//i,
];
const knownRemoteCodeMarkers = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net/npm',
  'cdn.skypack.dev',
  'esm.sh',
  'unpkg.com',
  'ajax.googleapis.com/ajax/libs',
  'apis.google.com/js',
  'pdfobjectnewwindow',
  'pdfObjectUrl',
];

// No OWL-authored module may manufacture executable JavaScript from strings or
// inject script elements. Exact third-party artifacts are checked separately
// below because some contain CSP-blocked compatibility/code-generation paths.
const sourceDir = join(projectRoot, 'src');
const authoredCodePatterns = [
  [/\beval\s*\(/, 'eval'],
  [/\bnew\s+Function\s*\(/, 'new Function'],
  [/\bimportScripts\s*\(/, 'importScripts'],
  [/createElement(?:NS)?\s*\([^)]*["'`]script["'`]/, 'dynamic script element'],
  [/\bset(?:Timeout|Interval)\s*\(\s*["'`]/, 'string-based timer'],
];
for (const path of walk(sourceDir).filter((entry) => extname(entry).toLowerCase() === '.js')) {
  const contents = readFileSync(path, 'utf8');
  for (const [pattern, label] of authoredCodePatterns) {
    if (pattern.test(contents)) fail(`${relative(projectRoot, path)} contains forbidden authored-code pattern: ${label}`);
  }
}

for (const path of files) {
  const relativePath = relativeReleasePath(path);
  for (const [pattern, label] of forbiddenFilePatterns) {
    if (pattern.test(relativePath)) fail(`Release contains ${label}: ${relativePath}`);
  }
  if (!textExtensions.has(extname(path).toLowerCase())) continue;
  const contents = readFileSync(path, 'utf8');
  for (const marker of knownRemoteCodeMarkers) {
    if (contents.toLowerCase().includes(marker.toLowerCase())) {
      fail(`${relativePath} contains forbidden remote-code marker: ${marker}`);
    }
  }
  const executableUrls = [...contents.matchAll(remoteExecutableUrl)].map((match) => match[0]);
  for (const url of new Set(executableUrls)) {
    if (!knownDocumentationUrls.has(url)) fail(`${relativePath} references remote executable code: ${url}`);
  }
  for (const pattern of remoteLoaderPatterns) {
    if (pattern.test(contents)) fail(`${relativePath} contains a remote code loader matching ${pattern}`);
  }
  if (relativePath !== 'mammoth.browser.min.js'
      && /createElement(?:NS)?\s*\([^)]*["'`]script["'`]/i.test(contents)) {
    fail(`${relativePath} dynamically creates a script element`);
  }

  if (extname(path).toLowerCase() === '.html') {
    if (/\son[a-z]+\s*=/i.test(contents) || /javascript\s*:/i.test(contents)) {
      fail(`${relativePath} contains inline executable HTML`);
    }
    for (const match of contents.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
      const src = match[1].match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
      if (!src) {
        if (match[2].trim()) fail(`${relativePath} contains an inline script`);
      } else {
        assertRelativeResource(path, src, `${relativePath} script`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`Release audit failed with ${failures.length} problem(s):`);
  for (const problem of failures) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log(`Release audit passed: ${basename(releaseDir)}/ has ${files.length} packaged files, version ${expectedVersion}, and no remote executable code.`);
}
