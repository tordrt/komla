/**
 * Vite plugin: writes THIRD_PARTY_LICENSES.txt next to each bundle, with the
 * license of every npm package whose code the bundle contains.
 *
 * Bundled packages are devDependencies, so their node_modules folders (and
 * LICENSE files) never ship, and Vite's minifier drops license comments. This
 * file is where their notices reach the packaged app.
 */

import fs from 'node:fs';
import path from 'node:path';

const NOTICE_FILE = /^(?:licen[cs]e|copying)|notice/i;
const RULE = '-'.repeat(80);

/** The package directory for a module inside node_modules, or null. */
function packageRootOf(moduleId) {
  // Rollup's helper modules use a \0 prefix and a query, e.g. ?commonjs-module.
  const id = moduleId.replace(/^\0/, '').split('?')[0].replace(/\\/g, '/');
  const marker = '/node_modules/';
  const index = id.lastIndexOf(marker);
  if (index === -1) return null;
  const segments = id.slice(index + marker.length).split('/');
  const nameLength = segments[0].startsWith('@') ? 2 : 1;
  if (segments.length <= nameLength) return null;
  return id.slice(0, index + marker.length) + segments.slice(0, nameLength).join('/');
}

function licenseOf(manifest) {
  const license = manifest.license ?? manifest.licenses;
  if (typeof license === 'string') return license;
  if (Array.isArray(license)) return license.map((entry) => entry.type ?? entry).join(' OR ');
  return license?.type ?? 'unknown license';
}

function describePackage(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const texts = fs
    .readdirSync(root)
    .filter((file) => NOTICE_FILE.test(file) && fs.statSync(path.join(root, file)).isFile())
    .sort()
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8').trim());
  return { name: manifest.name, version: manifest.version, license: licenseOf(manifest), texts };
}

function renderNotices(packages) {
  const sections = packages
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version))
    .map(({ name, version, license, texts }) =>
      [
        RULE,
        `${name} ${version} (${license})`,
        RULE,
        '',
        texts.length > 0 ? texts.join(`\n\n`) : 'No license file in the package.',
        '',
      ].join('\n')
    );
  return [`Third-party packages bundled into the code in this directory.`, '', ...sections].join(
    '\n'
  );
}

export function thirdPartyLicenses() {
  return {
    name: 'komla:third-party-licenses',
    apply: 'build',
    generateBundle(_options, bundle) {
      const roots = new Set();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const moduleId of Object.keys(output.modules)) {
          const root = packageRootOf(moduleId);
          if (root) roots.add(root);
        }
      }
      if (roots.size === 0) return;
      // The same version installed in two places has the same notice.
      const packages = new Map();
      for (const described of [...roots].map(describePackage)) {
        packages.set(`${described.name}@${described.version}`, described);
      }
      this.emitFile({
        type: 'asset',
        fileName: 'THIRD_PARTY_LICENSES.txt',
        source: renderNotices([...packages.values()]),
      });
    },
  };
}
