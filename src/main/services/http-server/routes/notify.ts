import { createLogger } from '../../../lib/logger';
import {
  notificationDeliveryService,
  notificationPayloadSchema,
} from '../../notification-delivery.service';
import { readJsonBody, singleHeader, writeValidationError } from '../http-io';

import type http from 'http';

const logger = createLogger('HttpServerService');

export function handleNotifyRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  void (async () => {
    const body = await readJsonBody(req, res);
    if (!body) return;

    const parsed = notificationPayloadSchema.safeParse(body.value);
    if (!parsed.success) {
      writeValidationError(res, parsed.error);
      return;
    }
    const payload = parsed.data;
    const sshHostId = singleHeader(req.headers['x-komla-ssh-host-id']);

    try {
      const receipt = notificationDeliveryService.receive(payload, sshHostId);
      if (receipt.kind === 'no-terminal') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No matching terminal found' }));
        return;
      }
      const { acceptance } = receipt;
      const canRetryPending =
        req.headers['x-komla-hook-pending'] === 'retry' && receipt.settlesLater;
      // A pending response releases the companion's delivery slot without
      // acknowledging durability. Retries share the same acceptance promise.
      const matchedWorkspace = canRetryPending
        ? await Promise.race([
            acceptance,
            new Promise<'pending'>((resolve) => setImmediate(() => resolve('pending'))),
          ])
        : await acceptance;
      if (matchedWorkspace === 'pending') {
        void acceptance.catch((error) =>
          logger.error('Failed to settle remote notification:', error)
        );
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ pending: true }));
      } else if (matchedWorkspace) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } else {
        notificationDeliveryService.syncHostOfUnknownTerminal(payload, sshHostId);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No matching workspace found', cwd: payload.cwd }));
      }
    } catch (error) {
      if (!res.headersSent) {
        // Log full detail server-side; return a stable generic body since this
        // endpoint is unauthenticated and callable from any local agent.
        logger.error('Failed to handle notification:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to handle notification' }));
      }
    }
  })();
}
