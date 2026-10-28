#!/usr/bin/env node
// Points npm workspace symlinks in <wt_root>/node_modules at THIS worktree's
// source.
//
// scripts/worktree-deps.cjs clones node_modules from a store entry that
// another worktree published. Relative links (`@komla/remote-protocol ->
// ../../packages/remote-protocol`) survive the clone, but Windows junctions
// are absolute and still name the publishing worktree. A node_modules
// symlink left from the old shared layout also resolves these links outside
// the worktree.
//
// Idempotent and safe to invoke by hand. No-op outside a git worktree, when
// node_modules is missing, or when there are no workspaces.

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

require('./fix-workspace-platform-deps.cjs');

function sh(cmd) {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function detectWorktreeRoot() {
  let gitDir;
  let gitCommon;
  let wtRoot;
  try {
    gitDir = sh('git rev-parse --git-dir');
    gitCommon = sh('git rev-parse --git-common-dir');
    wtRoot = sh('git rev-parse --show-toplevel');
  } catch {
    return null;
  }
  if (!gitDir || !gitCommon || !wtRoot) return null;
  // git_dir resolved != git_common resolved means this is a linked worktree,
  // not the primary.
  const gitDirAbs = fs.realpathSync(gitDir);
  const gitCommonAbs = fs.realpathSync(gitCommon);
  if (gitDirAbs === gitCommonAbs) return null;
  return wtRoot;
}

function collectWorkspacePackages(wtRoot) {
  const rootPkgPath = path.join(wtRoot, 'package.json');
  if (!fs.existsSync(rootPkgPath)) return [];
  let rootPkg;
  try {
    rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'));
  } catch {
    return [];
  }
  const raw = rootPkg.workspaces;
  const patterns = Array.isArray(raw) ? raw : (raw && raw.packages) || [];
  if (patterns.length === 0) return [];

  const out = [];
  const tryAdd = (wsDir) => {
    const pkgPath = path.join(wsDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return;
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      return;
    }
    if (!pkg.name) return;
    out.push({ name: pkg.name, absSrc: wsDir });
  };

  for (const pat of patterns) {
    if (pat.includes('*')) {
      // Only `dir/*` is supported here (matches the patterns Komla uses).
      if (!pat.endsWith('/*')) continue;
      const baseDir = path.join(wtRoot, pat.slice(0, -2));
      if (!fs.existsSync(baseDir)) continue;
      for (const entry of fs.readdirSync(baseDir)) {
        tryAdd(path.join(baseDir, entry));
      }
    } else {
      tryAdd(path.join(wtRoot, pat));
    }
  }
  return out;
}

function linkWorkspacePackages(wtRoot) {
  const nodeModules = path.join(wtRoot, 'node_modules');
  if (!fs.existsSync(nodeModules)) return;

  for (const { name, absSrc } of collectWorkspacePackages(wtRoot)) {
    if (!fs.existsSync(absSrc)) continue;
    const linkPath = path.join(nodeModules, name);

    let isLink = false;
    try {
      const st = fs.lstatSync(linkPath);
      // Don't overwrite a real directory: that's a manual install we
      // shouldn't clobber.
      if (!st.isSymbolicLink()) continue;
      isLink = true;
      if (fs.realpathSync(linkPath) === fs.realpathSync(absSrc)) continue;
    } catch {
      // Missing or dangling — we'll (re)create the symlink below.
    }

    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    if (isLink) fs.unlinkSync(linkPath);
    if (process.platform === 'win32') {
      fs.symlinkSync(absSrc, linkPath, 'junction');
    } else {
      // Relative to where the link really lives, which is outside the
      // worktree when node_modules is a symlink from the old shared layout.
      const linkDir = fs.realpathSync(path.dirname(linkPath));
      fs.symlinkSync(path.relative(linkDir, absSrc), linkPath);
    }
    console.log(`[fix-workspace-symlinks] ${name} → ${absSrc}`);
  }
}

function main() {
  const wtRoot = detectWorktreeRoot();
  if (wtRoot) linkWorkspacePackages(wtRoot);
}

module.exports = { collectWorkspacePackages, detectWorktreeRoot, linkWorkspacePackages };

if (require.main === module) main();
