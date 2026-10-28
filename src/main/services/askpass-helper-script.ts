/**
 * The Node.js helper that ssh and git spawn via SSH_ASKPASS. It:
 * 1. Reads the prompt from argv[2]
 * 2. Connects to the askpass socket
 * 3. Sends a JSON request with the prompt and its KOMLA_ASKPASS_SESSION
 * 4. Waits for the response
 * 5. Writes the passphrase to stdout
 * 6. Exits with 0 on success, 1 on failure/cancel, or once ssh exits without waiting
 */
export function askpassHelperScript(socketPath: string): string {
  return `#!/usr/bin/env node
const net = require('net');
const socketPath = ${JSON.stringify(socketPath)};
const prompt = process.argv[2] || 'Enter passphrase:';
const requestId = Math.random().toString(36).slice(2);
const session = process.env.KOMLA_ASKPASS_SESSION || null;

const client = net.createConnection(socketPath, () => {
  client.write(JSON.stringify({ id: requestId, prompt, session }) + '\\n');
});

let data = '';
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  process.exit(code);
}

client.on('data', (chunk) => {
  data += chunk.toString();
  const newlineIndex = data.indexOf('\\n');
  if (newlineIndex !== -1) {
    const response = data.slice(0, newlineIndex);
    try {
      const { passphrase } = JSON.parse(response);
      if (passphrase !== null && passphrase !== undefined) {
        process.stdout.write(passphrase);
        finish(0);
      } else {
        finish(1);
      }
    } catch {
      finish(1);
    }
  }
});

client.on('error', () => {
  finish(1);
});

client.on('close', () => {
  finish(1);
});

// Give up once ssh exits without waiting for the answer, such as when it is killed, so
// Komla stops showing its prompt
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) finish(1);
}, 1000).unref();

// Timeout after 3 minutes
setTimeout(() => {
  finish(1);
}, 180000);
`;
}
