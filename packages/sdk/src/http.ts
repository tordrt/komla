import { KomlaError } from './errors.js';

import type { KomlaCallOptions, KomlaTransport } from './client.js';
import type { KomlaOperationRequest, KomlaOperationType } from './generated.js';

/** Where Komla's HTTP server is, and who is calling, as the `komla` CLI names them. */
export interface KomlaRoute {
  /**
   * Komla's base URL, such as `KOMLA_API_URL`. In a managed terminal it ends in
   * `/terminals/<id>`, which names the terminal.
   */
  url: string;
  terminalId?: string;
  workspaceId?: string;
  /** The caller's folder, from which Komla finds its workspace when no terminal is named. */
  cwd?: string;
}

export interface HttpTransportOptions {
  /** The route, or a function that finds it before each request. */
  route: KomlaRoute | (() => KomlaRoute | Promise<KomlaRoute>);
  fetch?: typeof fetch;
  /**
   * How long a call that changes nothing waits for Komla, 10 seconds as the CLI waits. The SDK
   * doesn't time out a call that changes something, which Komla may have carried out already.
   */
  readTimeoutMs?: number;
}

/** The operations the CLI gives up waiting on, as they change nothing. */
const READ_OPERATIONS: ReadonlySet<KomlaOperationType> = new Set([
  'context.get',
  'agent.presets',
  'workspace.list',
  'tag.list',
] satisfies KomlaOperationType[]);

/** Sends operations to `/api/v1/commands`, as the CLI does. */
export function httpTransport(options: HttpTransportOptions): KomlaTransport {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const readTimeoutMs = options.readTimeoutMs ?? 10_000;
  const resolveRoute = typeof options.route === 'function' ? options.route : () => options.route;
  return {
    async send(request: KomlaOperationRequest, { workspace, signal }: KomlaCallOptions) {
      const route = await (resolveRoute as () => KomlaRoute | Promise<KomlaRoute>)();
      const base = route.url.replace(/\/+$/, '');
      const scoped = /\/terminals\/[^/]+$/.test(base);
      let url = `${base}/api/v1/commands`;
      if (!scoped && !route.terminalId && route.cwd) {
        url += `?cwd=${encodeURIComponent(route.cwd)}`;
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };
      // A named workspace replaces the calling one, as `--workspace` does.
      if (workspace !== undefined) {
        headers['X-Komla-Target-Workspace-Id'] = workspace;
        headers['X-Komla-Workspace-Id'] = workspace;
      } else {
        if (route.terminalId) headers['X-Komla-Terminal-Id'] = route.terminalId;
        if (route.workspaceId) headers['X-Komla-Workspace-Id'] = route.workspaceId;
      }

      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      signal?.addEventListener('abort', abort, { once: true });
      let timedOut = false;
      const timer = READ_OPERATIONS.has(request.type)
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, readTimeoutMs)
        : undefined;
      let response: Response | undefined;
      let text: string;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        text = await response.text();
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (timedOut) {
          throw new KomlaError(
            'KOMLA_UNREACHABLE',
            `Komla at ${base} didn't answer within ${duration(readTimeoutMs)}.`
          );
        }
        // Komla answered a change, so it carried it out, or may have.
        if (response && !READ_OPERATIONS.has(request.type)) {
          throw new KomlaError(
            'UNEXPECTED_RESPONSE',
            `Komla's answer broke off: ${errorMessage(error)}`,
            response.status
          );
        }
        throw new KomlaError(
          'KOMLA_UNREACHABLE',
          `Komla couldn't be reached at ${base}: ${errorMessage(error)}`
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (isEnvelope(body)) {
        if (body.ok && 'result' in body) return body.result;
        if (body.error) {
          throw new KomlaError(
            body.error.code,
            body.error.message,
            response.status,
            body.error.details
          );
        }
      }
      throw new KomlaError(
        'UNEXPECTED_RESPONSE',
        `Komla answered ${response.status} without a result${text ? `: ${text.slice(0, 200)}` : '.'}`,
        response.status
      );
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function duration(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000} seconds` : `${ms} ms`;
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

function isEnvelope(body: unknown): body is Envelope {
  if (typeof body !== 'object' || body === null || typeof (body as Envelope).ok !== 'boolean') {
    return false;
  }
  const { error } = body as Envelope;
  return (
    error === undefined ||
    (typeof error === 'object' &&
      error !== null &&
      typeof error.code === 'string' &&
      typeof error.message === 'string')
  );
}
