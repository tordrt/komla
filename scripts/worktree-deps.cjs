#!/usr/bin/env node
// Gives every git worktree its own node_modules, cloned from a store that
// sibling worktrees share.
//
// The store lives at <parent>/_deps/<platform>-<arch>/<key>/node_modules,
// where <key> hashes package-lock.json. An entry is a finished install with
// native modules rebuilt, published once and never changed. A worktree's
// node_modules is a real directory cloned from the entry with hardlinks
// (Linux, Windows) or copy-on-write clones (macOS), so it costs little disk,
// and npm installs, workspace links, and lockfile changes in one worktree
// never reach another. npm and the native rebuild replace files rather than
// writing into them; editing a hardlinked file in place would still change
// it everywhere. Store entries are only a cache: deleting one leaves every
// worktree cloned from it intact.
//
//   link         make node_modules match package-lock.json, cloning it from
//                the store when the store has the entry (dev/test/build)
//   setup        link, but fail unless node_modules then matches, for a
//                workspace setup step: `node scripts/worktree-deps.cjs setup ||
//                npm install`
//   postinstall  rebuild native modules and publish the install, or swap in
//                the store's copy when another worktree already published it
//   gc [--legacy]  drop store entries no sibling worktree uses; --legacy also
//                removes the old shared _<platform>/node_modules once no
//                worktree links to it
//
// Outside a git worktree, postinstall only rebuilds native modules and link
// only fixes workspace links.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  collectWorkspacePackages,
  detectWorktreeRoot,
  linkWorkspacePackages,
} = require('./fix-workspace-symlinks.cjs');

const NATIVE_MODULES = ['node-pty', 'keyboard-layout', '@parcel/watcher'];
const STAMP = '.komla-deps';
// Top-level node_modules entries a clone copies instead of linking: npm
// rewrites its hidden lockfile in place.
const COPIED = new Set(['.package-lock.json']);
// Per-worktree state and caches that never go into the store.
const SKIPPED = new Set([STAMP, '.vite', '.cache']);
const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

function log(message) {
  console.log(`[worktree-deps] ${message}`);
}

function lexists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function depsKey(wtRoot) {
  let lockfile;
  try {
    lockfile = fs.readFileSync(path.join(wtRoot, 'package-lock.json'));
  } catch {
    return null;
  }
  // Native modules are rebuilt for Electron, so the Node version running npm
  // doesn't change the tree.
  return crypto.createHash('sha256').update(lockfile).digest('hex').slice(0, 16);
}

function storeDirFor(wtRoot, platform = `${process.platform}-${process.arch}`) {
  return path.join(path.dirname(wtRoot), '_deps', platform);
}

// Only a worktree's own node_modules carries its stamp, never a symlink to
// someone else's.
function readStamp(nodeModules) {
  try {
    if (fs.lstatSync(nodeModules).isSymbolicLink()) return null;
    return fs.readFileSync(path.join(nodeModules, STAMP), 'utf8').trim();
  } catch {
    return null;
  }
}

// A volume mounted over node_modules (Docker release builds) can't be
// renamed or replaced.
function isMountpoint(nodeModules) {
  try {
    const st = fs.lstatSync(nodeModules);
    return st.isDirectory() && st.dev !== fs.statSync(path.dirname(nodeModules)).dev;
  } catch {
    return false;
  }
}

// Hardlinks unless the filesystem refuses them (e.g. a VM mount); macOS
// clones are copy-on-write, so writes never reach the source.
let hardlinks = process.platform !== 'darwin';

function cloneFile(from, to) {
  if (hardlinks) {
    try {
      fs.linkSync(from, to);
      return;
    } catch (error) {
      if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK'].includes(error.code)) throw error;
      hardlinks = false;
    }
  }
  fs.copyFileSync(from, to, fs.constants.COPYFILE_FICLONE);
}

function cloneTree(src, dest, top = false) {
  fs.mkdirSync(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (top && SKIPPED.has(entry.name)) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      let isDir = false;
      try {
        isDir = process.platform === 'win32' && fs.statSync(from).isDirectory();
      } catch {
        // Dangling: copy it as a file link.
      }
      fs.symlinkSync(fs.readlinkSync(from), to, isDir ? 'junction' : 'file');
    } else if (entry.isDirectory()) {
      cloneTree(from, to);
    } else if (top && COPIED.has(entry.name)) {
      fs.copyFileSync(from, to);
    } else {
      cloneFile(from, to);
    }
  }
}

function makeTemp(storeDir) {
  const tmpRoot = path.join(storeDir, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(tmpRoot, `${process.pid}-`));
  // mkdtemp's 0700 would carry over to published entries.
  fs.chmodSync(tmp, 0o755);
  return tmp;
}

function withLock(storeDir, wtRoot, fn) {
  const locks = path.join(storeDir, 'locks');
  fs.mkdirSync(locks, { recursive: true });
  const name = crypto.createHash('sha1').update(wtRoot).digest('hex').slice(0, 16);
  const lock = path.join(locks, name);
  const owner = `${process.pid}@${os.hostname()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let announced = false;
  while (!tryLock(lock, owner)) {
    const holder = readFileOrEmpty(lock);
    const [pid, host] = holder.split('@');
    if (host === os.hostname() && /^\d+$/.test(pid) && !processAlive(Number(pid))) {
      removeStaleLock(lock, holder);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${lock} (held by ${holder || 'unknown'})`);
    }
    if (!announced) log(`Waiting for another install in this worktree (${lock})...`);
    announced = true;
    sleep(500);
  }
  try {
    return fn();
  } finally {
    if (readFileOrEmpty(lock) === owner) fs.rmSync(lock, { force: true });
  }
}

function readFileOrEmpty(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

// Linking a file that already names its owner creates the lock in one step,
// so no lock is ever seen without an owner.
function tryLock(lock, owner) {
  const named = `${lock}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(named, owner);
  try {
    fs.linkSync(named, lock);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  } finally {
    fs.rmSync(named, { force: true });
  }
}

// Moves the lock aside before deleting it, so of several waiters that saw the
// same dead holder only one removes it. If a live holder took the lock in
// between, it goes back.
function removeStaleLock(lock, holder) {
  const aside = `${lock}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return;
  }
  if (readFileOrEmpty(aside) !== holder) {
    try {
      fs.linkSync(aside, lock);
    } catch {
      // Someone else holds it now; the holder we moved keeps running.
    }
  }
  fs.rmSync(aside, { force: true });
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// Marks node_modules as matching the lockfile. Written last, so a step that
// fails before it reruns next time.
function writeStamp(nodeModules, stamp) {
  fs.writeFileSync(path.join(nodeModules, STAMP), `${stamp}\n`);
}

function sameHiddenLockfile(nodeModules, entry) {
  try {
    const name = '.package-lock.json';
    return fs
      .readFileSync(path.join(nodeModules, name))
      .equals(fs.readFileSync(path.join(entry, 'node_modules', name)));
  } catch {
    return false;
  }
}

// Replaces <wtRoot>/node_modules with an unstamped clone of a store entry.
function installFromStore(wtRoot, storeDir, entry) {
  const target = path.join(wtRoot, 'node_modules');
  const tmp = makeTemp(storeDir);
  try {
    const fresh = path.join(tmp, 'node_modules');
    cloneTree(path.join(entry, 'node_modules'), fresh, true);
    if (lexists(target)) fs.renameSync(target, path.join(tmp, 'old'));
    fs.renameSync(fresh, target);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
  linkWorkspacePackages(wtRoot);
}

function publish(wtRoot, storeDir, entry) {
  // npm puts conflicting workspace dependencies in <workspace>/node_modules,
  // which a clone of the root node_modules would miss.
  // Dot entries there are only caches such as .vite.
  const nested = collectWorkspacePackages(wtRoot).find(({ absSrc }) => {
    try {
      return fs.readdirSync(path.join(absSrc, 'node_modules')).some((n) => !n.startsWith('.'));
    } catch {
      return false;
    }
  });
  if (nested) {
    log(`Not sharing this install: ${nested.name} has its own node_modules`);
    return;
  }
  const tmp = makeTemp(storeDir);
  try {
    cloneTree(path.join(wtRoot, 'node_modules'), path.join(tmp, 'node_modules'), true);
    try {
      fs.renameSync(tmp, entry);
    } catch (error) {
      // Another worktree published the same lockfile first.
      if (!fs.existsSync(entry)) throw error;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
  log(`Published node_modules to ${entry}`);
}

function hasSharedFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() ? hasSharedFiles(p) : entry.isFile() && fs.statSync(p).nlink > 1) {
      return true;
    }
  }
  return false;
}

// electron-rebuild writes into the native modules' directories. Copy any that
// still share files with the store so the rebuild can't change the store.
function unshareNativeModules(nodeModules) {
  for (const name of NATIVE_MODULES) {
    const dir = path.join(nodeModules, name);
    if (!fs.existsSync(dir) || !hasSharedFiles(dir)) continue;
    const copy = `${dir}.unshare-${process.pid}`;
    fs.cpSync(dir, copy, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(copy, dir);
  }
}

function rebuildNativeModules(packageRoot) {
  const cli = path.join(packageRoot, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
  execFileSync(process.execPath, [cli, '-f', '-w', NATIVE_MODULES.join(',')], {
    cwd: packageRoot,
    stdio: 'inherit',
  });
}

// npm install runs workspace `prepare` scripts (remote-protocol's dist
// types); a clone from the store has to do the same.
function runWorkspacePrepare(wtRoot) {
  const npm = process.env.npm_execpath;
  const args = ['run', 'prepare', '--workspaces', '--if-present'];
  execFileSync(npm ? process.execPath : 'npm', npm ? [npm, ...args] : args, {
    cwd: wtRoot,
    stdio: 'inherit',
    shell: !npm && process.platform === 'win32',
  });
}

// Returns whether node_modules now matches package-lock.json.
function link(wtRoot, storeDir = storeDirFor(wtRoot), prepareWorkspaces = runWorkspacePrepare) {
  const key = depsKey(wtRoot);
  const nodeModules = path.join(wtRoot, 'node_modules');
  if (!key || isMountpoint(nodeModules)) {
    linkWorkspacePackages(wtRoot);
    return false;
  }
  const stamp = `${path.basename(storeDir)}/${key}`;
  if (readStamp(nodeModules) === stamp) {
    linkWorkspacePackages(wtRoot);
    return true;
  }

  const entry = path.join(storeDir, key);
  if (fs.existsSync(entry)) {
    withLock(storeDir, wtRoot, () => {
      if (readStamp(nodeModules) === stamp) return;
      installFromStore(wtRoot, storeDir, entry);
      log(`node_modules cloned from ${entry}`);
      prepareWorkspaces(wtRoot);
      writeStamp(nodeModules, stamp);
    });
    return true;
  }
  if (!fs.existsSync(nodeModules)) {
    throw new Error('No node_modules for this package-lock.json yet. Run `npm install`.');
  }
  log('node_modules does not match package-lock.json. Run `npm install`.');
  linkWorkspacePackages(wtRoot);
  return false;
}

function postinstall(
  wtRoot,
  { worktree = true, storeDir = storeDirFor(wtRoot), rebuild = rebuildNativeModules } = {}
) {
  const nodeModules = path.join(wtRoot, 'node_modules');
  const key = worktree && depsKey(wtRoot);
  if (!key || isMountpoint(nodeModules) || fs.lstatSync(nodeModules).isSymbolicLink()) {
    rebuild(wtRoot);
    if (worktree) linkWorkspacePackages(wtRoot);
    return;
  }
  const stamp = `${path.basename(storeDir)}/${key}`;
  const entry = path.join(storeDir, key);
  let published = false;
  withLock(storeDir, wtRoot, () => {
    // Swap only an identical tree: anything npm added beyond the lockfile,
    // such as `--no-save` packages, shows up in its hidden lockfile.
    if (readStamp(nodeModules) !== stamp && sameHiddenLockfile(nodeModules, entry)) {
      installFromStore(wtRoot, storeDir, entry);
      writeStamp(nodeModules, stamp);
      log(`Using the store's install of this package-lock.json: ${entry}`);
      return;
    }
    unshareNativeModules(nodeModules);
    rebuild(wtRoot);
    linkWorkspacePackages(wtRoot);
    writeStamp(nodeModules, stamp);
    if (!fs.existsSync(entry)) {
      publish(wtRoot, storeDir, entry);
      published = true;
    }
  });
  if (published) gc(wtRoot, storeDir);
}

function siblingWorktrees(wtRoot) {
  const parent = path.dirname(wtRoot);
  return fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => path.join(parent, entry.name));
}

function gc(wtRoot, storeDir = storeDirFor(wtRoot), { legacy = false } = {}) {
  const platform = path.basename(storeDir);
  const keep = new Set();
  for (const sibling of siblingWorktrees(wtRoot)) {
    const stamp = readStamp(path.join(sibling, 'node_modules'));
    if (stamp?.startsWith(`${platform}/`)) keep.add(stamp.slice(platform.length + 1));
    const key = depsKey(sibling);
    if (key) keep.add(key);
  }
  let entries = [];
  try {
    entries = fs.readdirSync(storeDir);
  } catch {
    // No store yet.
  }
  for (const name of entries) {
    if (!/^[0-9a-f]{16}$/.test(name) || keep.has(name)) continue;
    fs.rmSync(path.join(storeDir, name), { recursive: true, force: true, maxRetries: 3 });
    log(`Removed unused store entry ${name}`);
  }
  // Leftovers from installs that crashed mid-clone.
  const tmpRoot = path.join(storeDir, 'tmp');
  for (const name of entries.includes('tmp') ? fs.readdirSync(tmpRoot) : []) {
    const [pid] = name.split('-');
    if (!processAlive(Number(pid))) {
      fs.rmSync(path.join(tmpRoot, name), { recursive: true, force: true, maxRetries: 3 });
    }
  }
  if (legacy) removeLegacySharedDir(wtRoot);
}

function removeLegacySharedDir(wtRoot) {
  const legacyRoot = path.join(path.dirname(wtRoot), `_${os.type().toLowerCase()}_${os.machine()}`);
  const legacyDir = path.join(legacyRoot, 'node_modules');
  if (!fs.existsSync(legacyDir)) return;
  const real = fs.realpathSync(legacyDir);
  const users = siblingWorktrees(wtRoot).filter((sibling) => {
    const nodeModules = path.join(sibling, 'node_modules');
    try {
      return fs.lstatSync(nodeModules).isSymbolicLink() && fs.realpathSync(nodeModules) === real;
    } catch {
      return false;
    }
  });
  if (users.length > 0) {
    log(`Keeping ${legacyDir}: still linked from ${users.map((u) => path.basename(u)).join(', ')}`);
    return;
  }
  fs.rmSync(legacyRoot, { recursive: true, force: true, maxRetries: 3 });
  log(`Removed ${legacyRoot}`);
}

module.exports = { cloneTree, depsKey, gc, link, postinstall, storeDirFor };

function main() {
  const [command, ...args] = process.argv.slice(2);
  const wtRoot = detectWorktreeRoot();
  if (command === 'link') {
    if (wtRoot) link(wtRoot);
  } else if (command === 'setup') {
    if (!wtRoot || !link(wtRoot)) process.exit(1);
  } else if (command === 'postinstall') {
    postinstall(path.resolve(__dirname, '..'), { worktree: Boolean(wtRoot) });
  } else if (command === 'gc') {
    if (wtRoot) gc(wtRoot, undefined, { legacy: args.includes('--legacy') });
  } else {
    console.error('Usage: worktree-deps.cjs {link|setup|postinstall|gc [--legacy]}');
    process.exit(1);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[worktree-deps] ${error.message}`);
    process.exit(1);
  }
}
