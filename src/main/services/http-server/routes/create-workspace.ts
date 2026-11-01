import { z } from 'zod';

import { createLogger } from '../../../lib/logger';
import {
  MAX_BRANCH_LEN,
  MAX_DESCRIPTION_LEN,
  MAX_NAME_LEN,
  MAX_PATH_LEN,
  MAX_PROJECT_NAME_LEN,
  MAX_PROMPT_LEN,
} from '../../komla-operation/schema';
import { KomlaOperationError, komlaOperationService } from '../../komla-operation.service';
import { workspaceService } from '../../workspace.service';
import { isJsonRequest, readBody, singleHeader, writeValidationError } from '../http-io';

import type http from 'http';

const logger = createLogger('HttpServerService');

const createWorkspacePayloadSchema = z
  .object({
    project: z.string().min(1).max(MAX_PROJECT_NAME_LEN).optional(),
    cwd: z.string().min(1).max(MAX_PATH_LEN).optional(),
    branchName: z.string().min(1).max(MAX_BRANCH_LEN).optional(),
    name: z.string().min(1).max(MAX_NAME_LEN).optional(),
    description: z.string().max(MAX_DESCRIPTION_LEN).optional(),
    initialPrompt: z.string().max(MAX_PROMPT_LEN).optional(),
  })
  .strip();

export function handleCreateWorkspaceRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): void {
  // This route takes a bare project name and places the workspace by the
  // launch defaults. Remote agents launch through the CLI or MCP instead,
  // which keep new workspaces on their host. The SSH gateway already blocks
  // this route; refusing the header here is defense in depth.
  if (singleHeader(req.headers['x-komla-ssh-host-id'])) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not available from an SSH host' }));
    return;
  }
  // Requiring JSON keeps web pages from sending this as a simple cross-origin form post.
  if (!isJsonRequest(req)) {
    res.writeHead(415, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
    return;
  }
  void (async () => {
    let raw: unknown;
    try {
      const body = await readBody(req);
      try {
        raw = JSON.parse(body);
      } catch {
        // Scoped narrowly so a SyntaxError thrown deep inside workspace
        // creation isn't misclassified as malformed input.
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

    const parsed = createWorkspacePayloadSchema.safeParse(raw);
    if (!parsed.success) {
      writeValidationError(res, parsed.error);
      return;
    }

    const { cwd, project, branchName, name, description, initialPrompt } = parsed.data;
    try {
      const { state, destination } = await komlaOperationService.execute(
        { cwd },
        {
          type: 'agent.launch',
          destination: 'workspace',
          project,
          branch: branchName,
          name,
          description,
          prompt: initialPrompt,
        }
      );
      // A workspace launch always lands in a new workspace.
      if (destination.kind !== 'workspace') throw new Error('Launched into a tab');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          workspace: {
            id: destination.workspaceId,
            name: workspaceService.get(destination.workspaceId)?.name,
            ...(destination.branch ? { branchName: destination.branch } : {}),
            ...(destination.path ? { workingDirectory: destination.path } : {}),
            provisioning: state === 'provisioning',
          },
        })
      );
    } catch (error) {
      if (error instanceof KomlaOperationError && !res.headersSent) {
        const projects = error.details?.availableProjects;
        res.writeHead(error.statusCode, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: error.message,
            ...(Array.isArray(projects)
              ? { availableProjects: projects.map((entry: { name: string }) => entry.name) }
              : {}),
          })
        );
        return;
      }
      if (!res.headersSent) {
        // Log full detail server-side; return a stable generic body since this
        // endpoint is unauthenticated and callable from any local agent.
        logger.error('Failed to create workspace:', error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create workspace' }));
      }
    }
  })();
}
