const { spawn } = require('child_process');
const fs = require('fs');

/**
 * electron-builder `win.signtoolOptions.sign` hook: signs Windows binaries with
 * jsign (https://ebourg.github.io/jsign/) when WIN_SIGN_STORETYPE is set, and does
 * nothing otherwise, so unsigned builds come out as before.
 *
 * electron-builder calls it for every .exe, .dll and .node it packages (signExts in
 * electron-builder.yml), the uninstaller and the installer, each before the file is
 * packed or hashed for the auto-updater. Files that already carry a signature, such as
 * Microsoft's DLLs, keep it; files that are not PE images (the macOS prebuilds node-pty
 * ships next to the Windows ones) are skipped.
 *
 * Environment, see docs/RELEASING.md:
 *   WIN_SIGN_STORETYPE  jsign --storetype, e.g. PKCS12, PKCS11, ESIGNER, DIGICERTONE
 *   WIN_SIGN_KEYSTORE   jsign --keystore
 *   WIN_SIGN_STOREPASS  jsign --storepass, which jsign reads from the environment
 *   WIN_SIGN_KEYPASS    jsign --keypass, which jsign reads from the environment
 *   WIN_SIGN_ALIAS      jsign --alias
 *   WIN_SIGN_CERTFILE   jsign --certfile
 *   WIN_SIGN_TSA_URL    RFC 3161 timestamp servers, comma separated
 *   JSIGN               jsign executable (default: jsign on PATH)
 */

const DEFAULT_TSA_URL = 'http://timestamp.digicert.com,http://timestamp.sectigo.com';

// IMAGE_DIRECTORY_ENTRY_SECURITY: the data directory that points at the Authenticode signatures.
const SECURITY_DIRECTORY = 4;

/** Returns 'not-pe', 'unsigned' or 'signed' from the file's PE headers. */
function peSignatureState(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const read = (position, length) => {
      const buffer = Buffer.alloc(length);
      return buffer.subarray(0, fs.readSync(fd, buffer, 0, length, position));
    };
    const dosHeader = read(0, 64);
    if (dosHeader.length < 64 || dosHeader.toString('latin1', 0, 2) !== 'MZ') return 'not-pe';
    // PE signature (4 bytes), COFF header (20) and the optional header through its 16 data
    // directories (PE32+ puts them at offset 112, PE32 at 96).
    const headers = read(dosHeader.readUInt32LE(0x3c), 24 + 112 + 16 * 8);
    if (headers.length < 26 || headers.toString('latin1', 0, 4) !== 'PE\0\0') return 'not-pe';
    const magic = headers.readUInt16LE(24);
    if (magic !== 0x10b && magic !== 0x20b) return 'not-pe';
    const directories = 24 + (magic === 0x20b ? 112 : 96);
    const entry = directories + SECURITY_DIRECTORY * 8;
    if (headers.length < entry + 8 || headers.readUInt32LE(directories - 4) <= SECURITY_DIRECTORY) {
      return 'unsigned';
    }
    return headers.readUInt32LE(entry) !== 0 && headers.readUInt32LE(entry + 4) !== 0
      ? 'signed'
      : 'unsigned';
  } finally {
    fs.closeSync(fd);
  }
}

function jsignArguments(file, programName, env) {
  const args = ['--storetype', env.WIN_SIGN_STORETYPE];
  if (env.WIN_SIGN_KEYSTORE) args.push('--keystore', env.WIN_SIGN_KEYSTORE);
  // The env: prefix makes jsign read the secret itself, so it never appears on a command line.
  if (env.WIN_SIGN_STOREPASS) args.push('--storepass', 'env:WIN_SIGN_STOREPASS');
  if (env.WIN_SIGN_KEYPASS) args.push('--keypass', 'env:WIN_SIGN_KEYPASS');
  if (env.WIN_SIGN_ALIAS) args.push('--alias', env.WIN_SIGN_ALIAS);
  if (env.WIN_SIGN_CERTFILE) args.push('--certfile', env.WIN_SIGN_CERTFILE);
  args.push(
    '--alg',
    'SHA-256',
    '--tsaurl',
    env.WIN_SIGN_TSA_URL || DEFAULT_TSA_URL,
    '--tsmode',
    'RFC3161',
    '--name',
    programName,
    file
  );
  return args;
}

function runJsign(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', (error) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} not found; install it with: brew install jsign (or set JSIGN)`)
          : error
      );
    });
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code} signing ${args.at(-1)}`));
    });
  });
}

async function sign(configuration) {
  const env = process.env;
  if (!env.WIN_SIGN_STORETYPE) return;

  const file = configuration.path;
  const state = peSignatureState(file);
  if (state !== 'unsigned') {
    const reason = state === 'signed' ? 'keeping its existing signature' : 'not a Windows binary';
    console.log(`  windows-sign: skipped ${file} (${reason})`);
    return;
  }
  await runJsign(env.JSIGN || 'jsign', jsignArguments(file, configuration.name, env));
}

exports.sign = sign;
exports.peSignatureState = peSignatureState;
