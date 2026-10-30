const fs = require('fs');
const path = require('path');

const REQUIRED_KOMLA_ARTIFACTS = [
  ['x86_64-unknown-linux-musl', 'komla'],
  ['aarch64-unknown-linux-musl', 'komla'],
  ['x86_64-apple-darwin', 'komla'],
  ['aarch64-apple-darwin', 'komla'],
  ['x86_64-pc-windows-msvc', 'komla.exe'],
  ['aarch64-pc-windows-msvc', 'komla.exe'],
];

/** Fail before packaging rather than silently shipping without the CLI. */
module.exports = async function beforePack(context) {
  const projectDir = context.packager.projectDir;
  const missing = REQUIRED_KOMLA_ARTIFACTS.map(([target, executable]) =>
    path.join(projectDir, 'native', 'artifacts', target, executable)
  ).filter((artifact) => !fs.existsSync(artifact));

  if (missing.length > 0) {
    throw new Error(
      `beforePack: Komla CLI artifacts are missing:\n${missing.join('\n')}\n` +
        'Run npm run build:native:matrix before electron-builder.'
    );
  }

  const devBuilds = REQUIRED_KOMLA_ARTIFACTS.map(([target]) =>
    path.join(projectDir, 'native', 'artifacts', target)
  ).filter((directory) => fs.existsSync(path.join(directory, '.dev-build')));

  if (devBuilds.length > 0) {
    throw new Error(
      `beforePack: these Komla CLI artifacts are development builds:\n${devBuilds.join('\n')}\n` +
        'Run npm run build:native:matrix before electron-builder.'
    );
  }
};
