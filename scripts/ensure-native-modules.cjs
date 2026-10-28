#!/usr/bin/env node

/**
 * Verifies that native modules (node-pty) are built for the correct
 * Electron version. If not, triggers electron-rebuild automatically.
 *
 * Run as a pre-script before preview to prevent Napi::Error crashes.
 */

const { execSync } = require('child_process');

try {
  const pty = require('node-pty');
  const proc = pty.spawn('/bin/sh', ['-c', 'echo ok'], {
    name: 'xterm-color',
    cols: 80,
    rows: 10,
    cwd: process.env.HOME || '/tmp',
  });

  const timeout = setTimeout(() => {
    proc.kill();
    process.exit(0);
  }, 2000);

  proc.onData(() => {
    clearTimeout(timeout);
    proc.kill();
    process.exit(0);
  });

  proc.onExit(() => {
    clearTimeout(timeout);
  });
} catch {
  console.log('\n⚠ node-pty native module is stale — rebuilding...\n');
  try {
    execSync('npm run postinstall', { stdio: 'inherit' });
    console.log('\n✔ Native modules rebuilt successfully.\n');
  } catch {
    console.error('\n✘ Failed to rebuild native modules. Try running: npm run postinstall\n');
    process.exit(1);
  }
}
