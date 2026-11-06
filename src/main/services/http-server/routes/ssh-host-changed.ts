import { z } from 'zod';

import { createLogger } from '../../../lib/logger';
import { sshHostService } from '../../ssh-host.service';
import { workspaceService } from '../../workspace.service';
import { readJsonBody, singleHeader, writeValidationError } from '../http-io';

import type http from 'http';

const logger = createLogger('HttpServerService');

const sshHostChangedSchema = z.object({
  protocolVersion: z.literal(1),
  kind: z.literal('ssh-host-changed'),
});

/**
 * The Remote Companion on an SSH host says another Komla installation changed a workspace there,
 * or started or ended one of its sessions, so this one syncs the host. Komla's host-scoped tunnel
 * names the host.
 */
export function handleSshHostChangedRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  void (async () => {
    const body = await readJsonBody(req, res, 4 * 1024);
    if (!body) return;
    const parsed = sshHostChangedSchema.safeParse(body.value);
    if (!parsed.success) {
      writeValidationError(res, parsed.error);
      return;
    }
    const hostId = singleHeader(req.headers['x-komla-ssh-host-id']);
    if (!hostId || !sshHostService.get(hostId)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No matching SSH host found' }));
      return;
    }
    workspaceService.sshSync.hostChanged(hostId);
    res.writeHead(204);
    res.end();
  })().catch((error: unknown) => {
    logger.error('Failed to handle an SSH host change:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to handle an SSH host change' }));
    }
  });
}
