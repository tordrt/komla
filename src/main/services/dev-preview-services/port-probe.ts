/**
 * Loopback probes for the dev preview: whether a port accepts connections and
 * whether it answers HTTP or HTTPS.
 */

import { connect as netConnect, type Socket } from 'net';
import { connect as tlsConnect } from 'tls';

// `localhost` may resolve to either family, and a server can bind only one.
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const;
const CONNECT_TIMEOUT_MS = 500;
// Dev servers such as Next.js compile a page before answering its first
// request, so a server that accepts the request but stays silent counts as HTTP.
const RESPONSE_TIMEOUT_MS = 1_000;

// Long enough to hold `HTTP/1.1 400`.
const STATUS_PREFIX_BYTES = 12;

type ProbeResponse = 'http' | 'bad-request' | 'other' | 'silent';

function ignoreErrors(): void {}

/** Resolves once `socket` emits `readyEvent`, or null after an error, close, or timeout. */
function waitForSocket<T extends Socket>(socket: T, readyEvent: string): Promise<T | null> {
  // Failures are reported through the probe result, never as uncaught errors.
  socket.on('error', ignoreErrors);
  return new Promise((resolve) => {
    const finish = (ready: boolean): void => {
      clearTimeout(timer);
      socket.off(readyEvent, onReady);
      socket.off('error', onFailure);
      socket.off('close', onFailure);
      if (ready) {
        resolve(socket);
        return;
      }
      socket.destroy();
      resolve(null);
    };
    const onReady = (): void => finish(true);
    const onFailure = (): void => finish(false);
    const timer = setTimeout(onFailure, CONNECT_TIMEOUT_MS);
    socket.once(readyEvent, onReady);
    socket.once('error', onFailure);
    socket.once('close', onFailure);
  });
}

async function connectLoopback(port: number): Promise<{ host: string; socket: Socket } | null> {
  for (const host of LOOPBACK_HOSTS) {
    const socket = await waitForSocket(netConnect({ host, port }), 'connect');
    if (socket) return { host, socket };
  }
  return null;
}

export async function isLoopbackPortOpen(port: number): Promise<boolean> {
  const connection = await connectLoopback(port);
  connection?.socket.destroy();
  return connection !== null;
}

function classifyResponse(received: Buffer): ProbeResponse {
  const start = received.subarray(0, STATUS_PREFIX_BYTES).toString('latin1');
  if (!start.startsWith('HTTP/')) return 'other';
  return /^HTTP\/\S+ 400$/.test(start) ? 'bad-request' : 'http';
}

/** Sends `GET /` and classifies the first bytes of the reply, then closes the socket. */
function readResponseStart(socket: Socket, port: number): Promise<ProbeResponse> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    const finish = (response: ProbeResponse): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onEnd);
      socket.destroy();
      resolve(response);
    };
    const onData = (chunk: Buffer): void => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= STATUS_PREFIX_BYTES) finish(classifyResponse(received));
    };
    const onEnd = (): void => finish(classifyResponse(received));
    const timer = setTimeout(
      () => finish(received.length > 0 ? classifyResponse(received) : 'silent'),
      RESPONSE_TIMEOUT_MS
    );
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onEnd);
    socket.write(
      `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nUser-Agent: Komla\r\nAccept: */*\r\nConnection: close\r\n\r\n`
    );
  });
}

/** The scheme a loopback port answers HTTP on, or null when it does not answer HTTP. */
export async function probeHttpScheme(port: number): Promise<'http' | 'https' | null> {
  const connection = await connectLoopback(port);
  if (!connection) return null;
  const plain = await readResponseStart(connection.socket, port);
  if (plain === 'http' || plain === 'silent') return 'http';

  // nginx and Go servers such as Caddy answer plain HTTP on a TLS port with a 400.
  const tlsSocket = await waitForSocket(
    tlsConnect({
      host: connection.host,
      port,
      servername: 'localhost',
      rejectUnauthorized: false,
    }),
    'secureConnect'
  );
  const secure = tlsSocket ? await readResponseStart(tlsSocket, port) : 'other';
  if (secure !== 'other') return 'https';
  return plain === 'bad-request' ? 'http' : null;
}
