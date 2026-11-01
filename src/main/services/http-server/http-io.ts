import type http from 'http';
import type { z } from 'zod';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

export function parseRequestUrl(url: string): URL | null {
  try {
    return new URL(url, 'http://127.0.0.1');
  } catch {
    return null;
  }
}

export function isJsonRequest(req: http.IncomingMessage): boolean {
  const contentType = singleHeader(req.headers['content-type']);
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'application/json';
}

export function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function readBody(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytesReceived = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      bytesReceived += chunk.length;
      if (bytesReceived > maxBytes) {
        tooLarge = true;
        reject(new Error('Request body too large'));
        return;
      }
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!tooLarge) resolve(body);
    });
    req.on('error', (err) => {
      if (!tooLarge) reject(err);
    });
  });
}

/** Whether readBody gave up on a body over its limit. */
export function isBodyTooLarge(error: unknown): boolean {
  return error instanceof Error && error.message === 'Request body too large';
}

/**
 * The request's body as JSON, wrapped since JSON may be null. When it can't be read or isn't JSON,
 * this answers the request and returns null.
 */
export async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  maxBytes?: number
): Promise<{ value: unknown } | null> {
  let body: string;
  try {
    body = await readBody(req, maxBytes);
  } catch (error) {
    if (!res.headersSent) {
      const isTooBig = isBodyTooLarge(error);
      res.writeHead(isTooBig ? 413 : 500, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: isTooBig ? 'Request body too large' : 'Failed to read body' })
      );
    }
    return null;
  }
  try {
    return { value: JSON.parse(body) };
  } catch {
    // Scoped narrowly so a SyntaxError thrown deeper in a route's work isn't misclassified as
    // malformed input.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return null;
  }
}

export function writeNotFound(res: http.ServerResponse): void {
  res.writeHead(404);
  res.end('Not found');
}

export function writeValidationError(res: http.ServerResponse, error: z.ZodError): void {
  const details = error.issues.map((issue) => ({
    path: issue.path.join('.') || '<root>',
    message: issue.message,
  }));
  res.writeHead(400, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Invalid payload', details }));
}
