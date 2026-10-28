/**
 * Release smoke test: loads every native module from a packaged app.asar, under
 * the packaged app's own Electron, and starts a terminal with node-pty. Voice
 * transcription and keyboard layouts load their modules only when first used, so
 * launching the app does not show that their files shipped.
 *
 * Usage: ELECTRON_RUN_AS_NODE=1 <packaged app executable> \
 *   scripts/check-packaged-native-modules.cjs <path to app.asar>
 */

const { createRequire } = require('node:module');
const path = require('node:path');

const NATIVE_MODULES = ['node-pty', '@parcel/watcher', 'keyboard-layout', 'sherpa-onnx-node'];

function startTerminal(pty) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the shell did not exit within 10 s')), 10_000);
    pty.spawn('/bin/sh', ['-c', 'exit 0'], {}).onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode === 0) resolve();
      else reject(new Error(`the shell exited with code ${exitCode}`));
    });
  });
}

async function main() {
  // Resolve packages from where the main bundle does.
  const appRequire = createRequire(path.join(process.argv[2], 'out', 'main', 'index.js'));
  let failures = 0;
  for (const name of NATIVE_MODULES) {
    try {
      const loaded = appRequire(name);
      if (name === 'node-pty') await startTerminal(loaded);
      console.log(`  ${name} loads`);
    } catch (error) {
      failures++;
      console.error(`  ${name} failed: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

main().then((code) => process.exit(code));
