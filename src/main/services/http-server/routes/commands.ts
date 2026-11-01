import { createLogger } from '../../../lib/logger';
import { parseKomlaOperation } from '../../komla-operation/schema';
import { KomlaOperationError, komlaOperationService } from '../../komla-operation.service';
import { isJsonRequest, parseRequestUrl, readBody, singleHeader } from '../http-io';

import type http from 'http';

const logger = createLogger('HttpServerService');

export function handleKomlaCommandRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  scopedTerminalId?: string
): void {
  void (async () => {
    if (!isJsonRequest(req)) {
      writeKomlaCommandError(
        res,
        415,
        'UNSUPPORTED_MEDIA_TYPE',
        'Komla command requests must use application/json.'
      );
      return;
    }
    const url = parseRequestUrl(rawUrl);
    if (!url) {
      writeKomlaCommandError(res, 400, 'INVALID_URL', 'Invalid request URL.');
      return;
    }
    const headerTerminalId = singleHeader(req.headers['x-komla-terminal-id']);
    if (scopedTerminalId && headerTerminalId && scopedTerminalId !== headerTerminalId) {
      writeKomlaCommandError(
        res,
        409,
        'WORKSPACE_CONTEXT_CONFLICT',
        'Terminal URL and header identities do not match.'
      );
      return;
    }
    try {
      const body = await readBody(req);
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        writeKomlaCommandError(res, 400, 'INVALID_JSON', 'Request body must be JSON.');
        return;
      }
      const operation = parseKomlaOperation(raw);
      const sshHostId = singleHeader(req.headers['x-komla-ssh-host-id']);
      const targetWorkspaceId = singleHeader(req.headers['x-komla-target-workspace-id']);
      const requestedAt = requestedAtOf(req);
      // `--workspace` names the workspace to act on, in place of the calling terminal's.
      const result = await komlaOperationService.execute(
        targetWorkspaceId
          ? { workspaceId: targetWorkspaceId, sshHostId, targeted: true, requestedAt }
          : {
              terminalId: scopedTerminalId ?? headerTerminalId,
              workspaceId: singleHeader(req.headers['x-komla-workspace-id']),
              sshHostId,
              cwd: url.searchParams.get('cwd') ?? undefined,
              requestedAt,
            },
        operation
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof KomlaOperationError) {
        writeKomlaCommandError(res, error.statusCode, error.code, error.message, error.details);
        return;
      }
      logger.error('Komla operation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      writeKomlaCommandError(
        res,
        500,
        'OPERATION_FAILED',
        'Komla could not complete the operation.'
      );
    }
  })();
}

function writeKomlaCommandError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: { code, message, ...(details ? { details } : {}) } }));
}

/**
 * When an agent ran a command its SSH host queued while Komla was away (ADR 0006), by this
 * computer's clock: the host says how long it waited, so a host clock that is off doesn't count.
 */
function requestedAtOf(req: http.IncomingMessage): number | undefined {
  const value = singleHeader(req.headers['x-komla-queued-ms']);
  return value && /^\d{1,16}$/.test(value) ? Date.now() - Number(value) : undefined;
}
