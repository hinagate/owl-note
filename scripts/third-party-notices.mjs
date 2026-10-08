// Collect the licence notices for a vendored package and everything it depends on.
//
// Mermaid's build bundles code from its dependencies (d3, chevrotain, cytoscape, KaTeX
// and more) under MIT, ISC, BSD-3-Clause and Apache-2.0, all of which require their
// notice or licence text to travel with redistributed copies. The list is read from the
// installed dependency tree, not written by hand, so it stays complete across upgrades.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const LICENCE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-][^/]*)?$/i;

// Node's lookup: each ancestor's node_modules, nearest first.
function resolvePackage(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (basename(dir) !== 'node_modules') {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return candidate;
    }
    if (dirname(dir) === dir) return null;
  }
}

function licenceName(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type || l).join(' OR ');
  return 'not stated';
}

export function thirdPartyNotices(projectRoot, entryPackage) {
  const found = new Map();
  const missing = [];
  const stack = [[entryPackage, projectRoot]];
  while (stack.length) {
    const [name, from] = stack.pop();
    const dir = resolvePackage(name, from);
    if (!dir) { missing.push(name); continue; }
    if (found.has(dir)) continue;
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const texts = readdirSync(dir)
      .filter((file) => LICENCE_FILE.test(file))
      .sort()
      .map((file) => readFileSync(join(dir, file), 'utf8').trim());
    found.set(dir, { name: pkg.name || name, version: pkg.version || '?', licence: licenceName(pkg), texts });
    for (const dep of Object.keys(pkg.dependencies || {})) stack.push([dep, dir]);
  }
  if (missing.length) throw new Error(`Cannot find installed dependencies of ${entryPackage}: ${[...new Set(missing)].join(', ')}`);

  const entries = [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const rule = '='.repeat(78);
  const body = entries.map((e) => [
    rule,
    `${e.name} ${e.version} — ${e.licence}`,
    rule,
    e.texts.length ? e.texts.join('\n\n') : `(The package ships no licence file; its package.json declares: ${e.licence}.)`,
  ].join('\n')).join('\n\n');
  return {
    text: `Third-party software notices for ${entryPackage}, as packaged in OWL-Note.\n`
      + `${entries.length} packages: ${entryPackage} and everything it depends on.\n\n${body}\n`,
    count: entries.length,
  };
}
