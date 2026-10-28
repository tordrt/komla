const path = require('path');
const fs = require('fs');

// electron-builder Arch enum: ia32 = 0, x64 = 1, armv7l = 2, arm64 = 3, universal = 4
const ARCH_MAP = { 1: 'x64', 3: 'arm64' };

/**
 * electron-builder afterPack hook.
 *
 * Windows: verify the per-arch ripgrep platform package was bundled.
 * macOS (parallel mode): swap pre-cached per-arch keyboard-layout native module
 *   (cache populated by release script).
 * macOS (all builds): remove stale build/ dirs from native modules that ship
 *   prebuilds, so the correct per-arch prebuild is always used.
 */
module.exports = async function afterPack(context) {
  const arch = ARCH_MAP[context.arch];
  if (!arch) {
    throw new Error(`afterPack: unsupported arch ${context.arch}`);
  }

  if (context.electronPlatformName === 'win32') {
    verifyRipgrep(context, arch);
  }

  if (context.electronPlatformName === 'darwin') {
    if (process.env.NATIVE_MODULES_CACHE) {
      swapKeyboardLayout(context, arch);
    }
    // Always remove build/ dirs for modules that have prebuilds —
    // whether parallel or sequential, build/Release may contain a binary
    // for the wrong arch (host arch vs target arch).
    removeStaleBuildDirs(context, arch);
  }
};

function verifyRipgrep(context, arch) {
  const rgBinary = path.join(
    context.appOutDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    '@vscode',
    `ripgrep-win32-${arch}`,
    'bin',
    'rg.exe'
  );

  if (!fs.existsSync(rgBinary)) {
    throw new Error(`afterPack: expected ${rgBinary} but not found`);
  }

  console.log(`  afterPack: verified ripgrep ${arch} binary`);
}

function swapKeyboardLayout(context, arch) {
  const cacheDir = process.env.NATIVE_MODULES_CACHE;
  const cached = path.join(cacheDir, arch, 'keyboard-layout-manager.node');

  if (!fs.existsSync(cached)) {
    throw new Error(`afterPack: cached keyboard-layout binary not found: ${cached}`);
  }

  // On macOS, native modules are inside the .app bundle, not at appOutDir/resources/
  let resourcesBase;
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename + '.app';
    resourcesBase = path.join(context.appOutDir, appName, 'Contents', 'Resources');
  } else {
    resourcesBase = path.join(context.appOutDir, 'resources');
  }

  const target = path.join(
    resourcesBase,
    'app.asar.unpacked',
    'node_modules',
    'keyboard-layout',
    'build',
    'Release',
    'keyboard-layout-manager.node'
  );

  // Ensure the target directory exists — electron-builder may not unpack
  // keyboard-layout when npmRebuild is disabled and the .node wasn't rebuilt.
  const targetDir = path.dirname(target);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  fs.copyFileSync(cached, target);
  console.log(`  afterPack: set keyboard-layout to ${arch} binary`);
}

/**
 * Remove build/ directories from native modules that ship per-arch prebuilds
 * or platform-specific npm packages. The build/ dir is created by
 * electron-rebuild during `npm install` for the host arch, and may not match
 * the target arch. These modules resolve build/Release before their prebuilds,
 * so a stale build/ causes wrong-arch crashes at runtime.
 */
function removeStaleBuildDirs(context, arch) {
  // On macOS, appOutDir is the dir *containing* the .app bundle (e.g. dist/mac-arm64).
  // Native modules live inside the .app at Contents/Resources/app.asar.unpacked/,
  // NOT at appOutDir/resources/ (which is a staging area with only some modules).
  let resourcesBase;
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename + '.app';
    resourcesBase = path.join(context.appOutDir, appName, 'Contents', 'Resources');
  } else {
    resourcesBase = path.join(context.appOutDir, 'resources');
  }
  const unpackedModules = path.join(resourcesBase, 'app.asar.unpacked', 'node_modules');

  // node-pty: has prebuilds/darwin-{arch}/pty.node, but loads build/Release first
  const ptyDir = path.join(unpackedModules, 'node-pty');
  if (fs.existsSync(ptyDir)) {
    const prebuild = path.join(ptyDir, 'prebuilds', `darwin-${arch}`, 'pty.node');
    if (!fs.existsSync(prebuild)) {
      throw new Error(`afterPack: node-pty prebuild not found: ${prebuild}`);
    }
    const buildDir = path.join(ptyDir, 'build');
    if (fs.existsSync(buildDir)) {
      fs.rmSync(buildDir, { recursive: true, force: true });
      console.log(`  afterPack: removed node-pty/build (using prebuilds/darwin-${arch})`);
    }
    // npm strips execute bits from prebuilt binaries; spawn-helper needs +x
    // for posix_spawnp to succeed on macOS
    const spawnHelper = path.join(ptyDir, 'prebuilds', `darwin-${arch}`, 'spawn-helper');
    if (fs.existsSync(spawnHelper)) {
      fs.chmodSync(spawnHelper, 0o755);
      console.log(`  afterPack: set +x on node-pty spawn-helper (darwin-${arch})`);
    }
  }

  // @parcel/watcher: has @parcel/watcher-darwin-{arch} packages, but falls
  // back to build/Release/watcher.node if the platform package fails to load
  const watcherDir = path.join(unpackedModules, '@parcel', 'watcher');
  if (fs.existsSync(watcherDir)) {
    const platformPkg = path.join(unpackedModules, '@parcel', `watcher-darwin-${arch}`);
    if (!fs.existsSync(platformPkg)) {
      throw new Error(`afterPack: @parcel/watcher-darwin-${arch} package not found`);
    }
    const buildDir = path.join(watcherDir, 'build');
    if (fs.existsSync(buildDir)) {
      fs.rmSync(buildDir, { recursive: true, force: true });
      console.log(`  afterPack: removed @parcel/watcher/build (using watcher-darwin-${arch})`);
    }
  }
}
