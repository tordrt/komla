#!/usr/bin/env node
// Points git at scripts/git-hooks during `npm install`. The setting is shared by
// every worktree of the clone, and each runs the hooks from its own checkout.
// It leaves alone a hooks path someone already set, and hooks someone put in
// .git/hooks, which the new path would stop running.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const HOOKS_PATH = 'scripts/git-hooks';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function installGitHooks(root) {
  let commonDir;
  try {
    commonDir = path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
  } catch {
    return;
  }
  let current = '';
  try {
    current = git(root, ['config', 'core.hooksPath']);
  } catch {
    // Unset.
  }
  if (current === HOOKS_PATH) return;
  if (current) {
    console.log(`[git-hooks] core.hooksPath is ${current}, so Komla's hooks are off.`);
    return;
  }
  const hooksDir = path.join(commonDir, 'hooks');
  const ownHooks = fs.existsSync(hooksDir)
    ? fs.readdirSync(hooksDir).filter((name) => !name.endsWith('.sample'))
    : [];
  if (ownHooks.length > 0) {
    console.log(`[git-hooks] Kept your hooks in ${hooksDir}, so Komla's hooks are off.`);
    return;
  }
  git(root, ['config', 'core.hooksPath', HOOKS_PATH]);
}

module.exports = { installGitHooks };

if (require.main === module) {
  try {
    installGitHooks(path.resolve(__dirname, '..'));
  } catch (error) {
    // A missing hook must never fail `npm install`.
    console.log(`[git-hooks] Not installed: ${error.message}`);
  }
}
