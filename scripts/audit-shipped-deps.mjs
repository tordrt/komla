#!/usr/bin/env node

/**
 * Release audit gate: fails on high or critical advisories in packages Komla ships.
 *
 * `npm audit --omit=dev` misses the renderer libraries, which are devDependencies
 * because Vite bundles them into out/. A full `npm audit` also fails on build
 * tooling that never ships. Shipped here means what `--omit=dev` covers
 * (dependencies, optionalDependencies, workspace packages), plus devDependencies
 * that src/ imports as values (`import type` does not ship), and everything those
 * resolve to in package-lock.json, except workspaces' devDependencies.
 *
 * Usage: node scripts/audit-shipped-deps.mjs
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
// The Electron runtime ships, but its npm package's dependencies only download it.
const RUNTIME_PROVIDED = new Set(['node_modules/electron']);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|css)$/;
const SKIPPED_SOURCE_FILE = /\.test\.|\.d\.ts$/;
// Strings come first so that comment markers inside them, as in URLs, survive.
const STRING_OR_COMMENT =
  /('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
// Imports and re-exports (multi-line too), side-effect imports, import() and
// require(), and CSS @import. A statement may follow another on the same line.
const SPECIFIER_PATTERNS = [
  /(?:^|;)\s*(?:import|export)\s+(?!type\b)[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/gm,
  /(?:^|;)\s*import\s*['"]([^'"]+)['"]/gm,
  /\b(?:import|require)\s*\(\s*['"`]([^'"`$]+)['"`]\s*\)/g,
  /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g,
];
export const NPM_AUDIT_ARGS = ['audit', '--json', '--include=dev'];

function packageName(specifier) {
  // Relative and absolute paths, and protocols such as node: or virtual:.
  if (/^[./]|^[a-z][a-z0-9+.-]*:/i.test(specifier)) return null;
  const parts = specifier.split('?')[0].split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function importedPackages(sources) {
  const names = new Set();
  for (const { content } of sources) {
    const code = content.replace(STRING_OR_COMMENT, (match, string) => string ?? ' ');
    for (const pattern of SPECIFIER_PATTERNS) {
      for (const match of code.matchAll(pattern)) {
        const name = packageName(match[1]);
        if (name) names.add(name);
      }
    }
  }
  return names;
}

/** Node's lookup: the package's own node_modules first, then each parent's. */
function resolveInLockfile(packages, fromPath, name) {
  let base = fromPath;
  for (;;) {
    const candidate = base ? `${base}/node_modules/${name}` : `node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const index = base.lastIndexOf('node_modules/');
    base = index > 0 ? base.slice(0, index - 1) : '';
  }
}

function shippedLockfilePaths(lockfile, roots) {
  const packages = lockfile.packages ?? {};
  const shipped = new Set();
  const queue = [];
  const visit = (fromPath, name) => {
    let location = resolveInLockfile(packages, fromPath, name);
    // Uninstalled optional dependencies and peers have no entry.
    if (!location) return;
    const entry = packages[location];
    if (entry.link && entry.resolved) {
      shipped.add(location);
      location = entry.resolved;
    }
    if (shipped.has(location)) return;
    shipped.add(location);
    queue.push(location);
  };
  for (const name of roots) visit('', name);
  while (queue.length > 0) {
    const location = queue.pop();
    if (RUNTIME_PROVIDED.has(location)) continue;
    const entry = packages[location] ?? {};
    const names = Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
    });
    for (const name of names) visit(location, name);
  }
  return shipped;
}

export function findShippedVulnerabilities({ packageJson, lockfile, sources, auditReport }) {
  const vulnerabilities = auditReport?.vulnerabilities;
  if (typeof vulnerabilities !== 'object' || vulnerabilities === null) {
    const reason = auditReport?.message || auditReport?.error?.summary || auditReport?.error?.code;
    throw new Error(`npm audit did not return a report${reason ? `: ${reason}` : ''}`);
  }

  const imported = importedPackages(sources);
  const workspaces = Object.entries(lockfile.packages ?? {})
    .filter(
      ([location, entry]) => entry.link && /^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(location)
    )
    .map(([location]) => location.slice('node_modules/'.length));
  const roots = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
    ...workspaces,
    ...Object.keys(packageJson.devDependencies ?? {}).filter((name) => imported.has(name)),
  ];
  const shipped = shippedLockfilePaths(lockfile, roots);

  const blocking = [];
  const ignored = [];
  for (const vulnerability of Object.values(vulnerabilities)) {
    // Judge each package by its own advisories; string entries in `via` only
    // name the dependency it inherits one from, which has its own entry.
    const advisories = (vulnerability.via ?? [])
      .filter((via) => typeof via === 'object' && BLOCKING_SEVERITIES.has(via.severity))
      .map(({ title, severity, url }) => ({ title, severity, url }));
    if (advisories.length === 0) continue;
    const shippedNodes = (vulnerability.nodes ?? []).filter((node) => shipped.has(node));
    const finding = {
      name: vulnerability.name,
      nodes: shippedNodes.length > 0 ? shippedNodes : (vulnerability.nodes ?? []),
      advisories,
    };
    (shippedNodes.length > 0 ? blocking : ignored).push(finding);
  }
  return { blocking, ignored, shippedPackageCount: shipped.size };
}

function readSources(sourceDir) {
  return fs
    .readdirSync(sourceDir, { recursive: true })
    .filter((file) => SOURCE_FILE.test(file) && !SKIPPED_SOURCE_FILE.test(file))
    .map((file) => ({ path: file, content: fs.readFileSync(path.join(sourceDir, file), 'utf8') }));
}

function runNpmAudit(root) {
  // --include=dev overrides an `omit=dev` npm setting (or NODE_ENV=production),
  // which would drop the bundled renderer libraries from the report.
  const result = spawnSync('npm', NPM_AUDIT_ARGS, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `npm audit did not return JSON (exit ${result.status}): ${result.stderr.trim()}`
    );
  }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const { blocking, ignored, shippedPackageCount } = findShippedVulnerabilities({
    packageJson: readJson('package.json'),
    lockfile: readJson('package-lock.json'),
    sources: readSources(path.join(root, 'src')),
    auditReport: runNpmAudit(root),
  });

  if (ignored.length > 0) {
    const names = [...new Set(ignored.map((finding) => finding.name))].sort().join(', ');
    console.log(`Ignoring high/critical advisories in packages Komla does not ship: ${names}`);
  }
  if (blocking.length === 0) {
    console.log(
      `No high or critical advisories in the ${shippedPackageCount} packages Komla ships.`
    );
    return 0;
  }
  for (const { name, nodes, advisories } of blocking) {
    for (const { title, severity, url } of advisories) {
      console.error(
        `${name} (${severity}): ${title}\n  ${url}\n  installed at ${nodes.join(', ')}`
      );
    }
  }
  console.error(`${blocking.length} shipped package(s) have high or critical advisories.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
