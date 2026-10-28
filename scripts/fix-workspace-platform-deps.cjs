#!/usr/bin/env node

// npm installs version-pinned workspace dependencies inside the workspace
// source directory. In Komla's shared multi-platform worktrees that directory
// can therefore contain (for example) a Linux esbuild package while the root
// node_modules symlink points at the macOS dependency tree. Repair only the
// native esbuild package, preserving the workspace's pinned JS dependencies.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const platformPackage = `${process.platform}-${process.arch}`;

function readVersion(packagePath) {
  try {
    return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version;
  } catch {
    return undefined;
  }
}

function packageDirectories(nodeModulesPath) {
  const directories = [];
  for (const entry of fs.readdirSync(nodeModulesPath, { withFileTypes: true })) {
    const entryPath = path.join(nodeModulesPath, entry.name);
    if (!entry.name.startsWith('@')) {
      directories.push(entryPath);
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    try {
      for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        directories.push(path.join(entryPath, scopedEntry.name));
      }
    } catch {
      // Ignore broken optional dependency links.
    }
  }
  return directories;
}

function findMatchingPlatformPackage(nodeModulesPath, expectedVersion) {
  const candidates = [
    path.join(nodeModulesPath, '@esbuild', platformPackage),
    ...packageDirectories(nodeModulesPath).map((packagePath) =>
      path.join(packagePath, 'node_modules', '@esbuild', platformPackage)
    ),
  ];
  return candidates.find(
    (candidate) =>
      readVersion(path.join(candidate, 'package.json')) === expectedVersion &&
      fs.existsSync(path.join(candidate, 'bin', 'esbuild'))
  );
}

function repairWorkspace(workspacePath) {
  const nodeModulesPath = path.join(workspacePath, 'node_modules');
  const esbuildVersion = readVersion(path.join(nodeModulesPath, 'esbuild', 'package.json'));
  if (!esbuildVersion) return;

  const platformPath = path.join(nodeModulesPath, '@esbuild', platformPackage);
  if (
    readVersion(path.join(platformPath, 'package.json')) === esbuildVersion &&
    fs.existsSync(path.join(platformPath, 'bin', 'esbuild'))
  ) {
    return;
  }

  const source = findMatchingPlatformPackage(path.join(root, 'node_modules'), esbuildVersion);
  if (!source) {
    console.warn(
      `[fix-workspace-platform-deps] Missing @esbuild/${platformPackage}@${esbuildVersion}; run npm install on this platform`
    );
    return;
  }

  fs.mkdirSync(path.dirname(platformPath), { recursive: true });
  fs.rmSync(platformPath, { recursive: true, force: true });
  const platformSpecificSource = fs.realpathSync(source);
  fs.symlinkSync(
    platformSpecificSource,
    platformPath,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  console.log(
    `[fix-workspace-platform-deps] ${path.relative(root, platformPath)} → ${platformSpecificSource}`
  );
}

const rootPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const workspace of rootPackage.workspaces ?? []) {
  if (typeof workspace === 'string' && !workspace.includes('*')) {
    repairWorkspace(path.join(root, workspace));
  }
}
