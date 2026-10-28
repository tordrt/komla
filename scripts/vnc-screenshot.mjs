// Saves one frame from a local VNC server as a PNG, for scripts/linux-desktop.sh.
// Speaks just enough RFB 3.8: VNC password authentication and raw encoding.
//
// Usage: node scripts/vnc-screenshot.mjs <port> <password-file> <out.png>
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { crc32, deflateSync } from 'node:zlib';

const [port, passwordFile, outFile] = process.argv.slice(2);
if (!outFile) {
  console.error('Usage: node scripts/vnc-screenshot.mjs <port> <password-file> <out.png>');
  process.exit(2);
}

function createReader(socket) {
  const chunks = [];
  let available = 0;
  let failure = null;
  let wake = () => {};
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    available += chunk.length;
    wake();
  });
  socket.on('error', (error) => {
    failure = error;
    wake();
  });
  socket.on('close', () => {
    failure ??= new Error('VNC server closed the connection');
    wake();
  });
  return async (length) => {
    while (available < length) {
      if (failure) throw failure;
      await new Promise((resolve) => (wake = resolve));
    }
    const all = Buffer.concat(chunks);
    chunks.length = 0;
    if (all.length > length) chunks.push(all.subarray(length));
    available -= length;
    return all.subarray(0, length);
  };
}

// VNC authentication DES-encrypts the challenge with the password, each key byte bit-reversed.
function vncAuthResponse(password, challenge) {
  const key = Buffer.alloc(8);
  Buffer.from(password).copy(key, 0, 0, 8);
  for (let i = 0; i < 8; i++) {
    key[i] = parseInt(key[i].toString(2).padStart(8, '0').split('').reverse().join(''), 2);
  }
  return execFileSync(
    'openssl',
    [
      'enc',
      '-des-ecb',
      '-nopad',
      '-nosalt',
      '-K',
      key.toString('hex'),
      '-provider',
      'legacy',
      '-provider',
      'default',
    ],
    { input: challenge }
  );
}

function encodePng(width, height, rgb) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const socket = connect({ host: '127.0.0.1', port: Number(port) });
socket.setTimeout(15_000, () => socket.destroy(new Error('Timed out talking to the VNC server')));
const read = createReader(socket);

await read(12);
socket.write('RFB 003.008\n');
const securityTypes = await read((await read(1))[0]);
if (!securityTypes.includes(2))
  throw new Error(`VNC server does not offer password auth: ${[...securityTypes]}`);
socket.write(Buffer.from([2]));
socket.write(vncAuthResponse(readFileSync(passwordFile, 'utf8').trim(), await read(16)));
if ((await read(4)).readUInt32BE() !== 0) throw new Error('VNC authentication failed');

socket.write(Buffer.from([1])); // shared session
const serverInit = await read(24);
const width = serverInit.readUInt16BE(0);
const height = serverInit.readUInt16BE(2);
await read(serverInit.readUInt32BE(20));

// 32 bpp little-endian true colour, so each pixel arrives as B, G, R, padding.
socket.write(Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]));
socket.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])); // raw encoding only
const request = Buffer.alloc(10);
request.writeUInt8(3, 0);
request.writeUInt16BE(width, 6);
request.writeUInt16BE(height, 8);
socket.write(request);

for (;;) {
  const type = (await read(1))[0];
  if (type === 0) break; // framebuffer update
  if (type === 2) continue; // bell
  if (type !== 3) throw new Error(`Unexpected VNC server message ${type}`);
  await read(3); // server cut text
  await read((await read(4)).readUInt32BE());
}

const frame = Buffer.alloc(width * height * 4);
const rectCount = (await read(3)).readUInt16BE(1);
for (let i = 0; i < rectCount; i++) {
  const rect = await read(12);
  const [x, y, w, h] = [0, 2, 4, 6].map((offset) => rect.readUInt16BE(offset));
  if (rect.readInt32BE(8) !== 0) throw new Error(`Unexpected VNC encoding ${rect.readInt32BE(8)}`);
  const pixels = await read(w * h * 4);
  for (let row = 0; row < h; row++) {
    pixels.copy(frame, ((y + row) * width + x) * 4, row * w * 4, (row + 1) * w * 4);
  }
}
socket.destroy();

const rgb = Buffer.alloc(width * height * 3);
for (let i = 0, j = 0; i < frame.length; i += 4, j += 3) {
  rgb[j] = frame[i + 2];
  rgb[j + 1] = frame[i + 1];
  rgb[j + 2] = frame[i];
}
writeFileSync(outFile, encodePng(width, height, rgb));
console.log(`Saved ${width}x${height} frame to ${outFile}`);
