import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { createServer as createHttpsServer } from 'https';
import { createServer as createNetServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

const TLS_HANDSHAKE_RECORD = 0x16;

/** A self-signed localhost certificate, or null when openssl is unavailable. */
export function createCertificate(): { key: Buffer; cert: Buffer } | null {
  const dir = mkdtempSync(join(tmpdir(), 'komla-probe-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-subj',
        '/CN=localhost',
        '-days',
        '1',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' }
    );
    return {
      key: readFileSync(join(dir, 'key.pem')),
      cert: readFileSync(join(dir, 'cert.pem')),
    };
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * An HTTPS server that answers a plain HTTP request with a 400, as nginx and
 * Go servers such as Caddy do on a TLS port.
 */
export function createHttpsServerRejectingPlainHttp(certificate: {
  key: Buffer;
  cert: Buffer;
}): Server {
  const https = createHttpsServer(certificate, (_request, response) => response.end('ok'));
  return createNetServer((socket) => {
    socket.on('error', () => {});
    socket.once('data', (chunk: Buffer) => {
      if (chunk[0] !== TLS_HANDSHAKE_RECORD) {
        socket.end(
          'HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n'
        );
        return;
      }
      socket.pause();
      socket.unshift(chunk);
      https.emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
}
