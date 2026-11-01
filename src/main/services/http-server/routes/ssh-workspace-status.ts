import { z } from 'zod';

import { createLogger } from '../../../lib/logger';
import { MAX_BRANCH_LEN, MAX_ID_LEN, MAX_PATH_LEN } from '../../komla-operation/schema';
import { workspaceStatusService } from '../../workspace-status.service';
import { readBody, writeValidationError } from '../http-io';

import type http from 'http';

const logger = createLogger('HttpServerService');

// The Remote Companion reports more changed paths than this as unknown.
const MAX_CHANGED_PATHS = 500;

const sshWorkspaceStatusPayloadSchema = z.object({
  protocolVersion: z.literal(1),
  kind: z.literal('repository-snapshot'),
  workspaceId: z.string().min(1).max(MAX_ID_LEN),
  cwd: z.string().min(1).max(MAX_PATH_LEN),
  sequence: z.number().int().nonnegative(),
  observedAt: z.number().int().nonnegative(),
  stateHash: z.string().min(1).max(128),
  currentBranch: z.string().max(MAX_BRANCH_LEN).optional(),
  targetBranch: z.string().max(MAX_BRANCH_LEN).optional(),
  defaultBranch: z.string().max(MAX_BRANCH_LEN).optional(),
  statusB64: z.string().optional(),
  numstatB64: z.string().optional(),
  statusTooLarge: z.boolean().optional(),
  workingTreeChanged: z.boolean().optional(),
  fileListHash: z.string().min(1).max(128).optional(),
  changedPaths: z.array(z.string().min(1).max(MAX_PATH_LEN)).max(MAX_CHANGED_PATHS).optional(),
  aheadTargetBranch: z.number().int().nonnegative().optional(),
  behindTargetBranch: z.number().int().nonnegative().optional(),
  unpushedCommits: z.number().int().nonnegative().optional(),
  behindRemote: z.number().int().nonnegative().optional(),
  hasRemote: z.boolean().optional(),
  hasOriginRemote: z.boolean().optional(),
  targetBranchHasRemote: z.boolean().optional(),
  targetBranchAheadRemote: z.number().int().nonnegative().optional(),
  targetBranchBehindRemote: z.number().int().nonnegative().optional(),
});

export function handleSshWorkspaceStatusRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  void (async () => {
    let raw: unknown;
    try {
      const body = await readBody(req, 16 * 1024 * 1024);
      try {
        raw = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
    } catch (error) {
      if (!res.headersSent) {
        const isTooBig = error instanceof Error && error.message === 'Request body too large';
        res.writeHead(isTooBig ? 413 : 500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: isTooBig ? 'Request body too large' : 'Failed to read body' })
        );
      }
      return;
    }

    const parsed = sshWorkspaceStatusPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      writeValidationError(res, parsed.error);
      return;
    }

    try {
      const payload = parsed.data;
      const forwardedHostHeader = req.headers?.['x-komla-ssh-host-id'];
      const forwardedHostId = Array.isArray(forwardedHostHeader)
        ? forwardedHostHeader[0]
        : forwardedHostHeader;
      const receipt = await workspaceStatusService.change({
        kind: 'snapshot-observed',
        snapshot: {
          source: { kind: 'remote-companion', sequence: payload.sequence },
          workspaceId: payload.workspaceId,
          ...(forwardedHostId ? { hostId: forwardedHostId } : {}),
          cwd: payload.cwd,
          observedAt: payload.observedAt,
          stateHash: payload.stateHash,
          statusB64: payload.statusB64,
          numstatB64: payload.numstatB64,
          statusTooLarge: payload.statusTooLarge,
          workingTreeChanged: payload.workingTreeChanged,
          fileListHash: payload.fileListHash,
          changedPaths: payload.changedPaths,
          branch: {
            currentBranch: payload.currentBranch,
            targetBranch: payload.targetBranch,
            defaultBranch: payload.defaultBranch,
            aheadTargetBranch: payload.aheadTargetBranch,
            behindTargetBranch: payload.behindTargetBranch,
            hasRemote: payload.hasRemote,
            hasOriginRemote: payload.hasOriginRemote,
            unpushedCommits: payload.unpushedCommits,
            behindRemote: payload.behindRemote,
            targetBranchHasRemote: payload.targetBranchHasRemote,
            targetBranchAheadRemote: payload.targetBranchAheadRemote,
            targetBranchBehindRemote: payload.targetBranchBehindRemote,
          },
        },
      });
      if (receipt.disposition === 'rejected') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No matching SSH workspace found', cwd: payload.cwd }));
        return;
      }
      if (receipt.disposition === 'retry') {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(receipt));
        return;
      }
      res.writeHead(204);
      res.end();
    } catch (error) {
      if (!res.headersSent) {
        logger.error('Failed to handle SSH workspace status:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to handle SSH workspace status' }));
      }
    }
  })();
}
