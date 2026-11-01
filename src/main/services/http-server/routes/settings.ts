import { z } from 'zod';

import {
  ACTION_SSH_EXECUTION_LOCATIONS,
  SETTINGS_FILE_RESOURCES,
  SETUP_DESTINATIONS,
  SETUP_TRIGGERS,
} from '../../../../shared/types';
import { BRANCH_NAME_PATTERN } from '../../../ipc/validation/primitives';
import { createLogger } from '../../../lib/logger';
import {
  MAX_COLOR_LEN,
  MAX_ID_LEN,
  MAX_NAME_LEN,
  MAX_PROMPT_LEN,
} from '../../komla-operation/schema';
import { pluginsService } from '../../plugins.service';
import { getSettingsManagementService } from '../../settings-management-instance';
import {
  SettingsManagementError,
  type SettingsActionScope,
  type SettingsApprovalRequest,
  type SettingsManagementService,
  type SettingsProposalResult,
  type SettingsRequestContext,
} from '../../settings-management.service';
import { isBodyTooLarge, parseRequestUrl, readBody, singleHeader } from '../http-io';

import type { AppearanceSettings } from '../../../../shared/types';
import type http from 'http';

const logger = createLogger('HttpServerService');

const settingsActionSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LEN).optional(),
    title: z.string().min(1).max(MAX_NAME_LEN),
    content: z.string().min(1).max(MAX_PROMPT_LEN),
    type: z.enum(['prompt', 'command']),
    projectCount: z.number().int().positive().optional(),
    presetId: z.string().min(1).max(MAX_ID_LEN).optional(),
    launchModeId: z.string().min(1).max(MAX_ID_LEN).optional(),
    sshExecutionLocation: z.enum(ACTION_SSH_EXECUTION_LOCATIONS).optional(),
    background: z.boolean().optional(),
  })
  .strict();

const settingsActionsPayloadSchema = z.object({ actions: z.array(settingsActionSchema) }).strict();

const settingsSetupStepSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LEN).optional(),
    name: z.string().min(1).max(MAX_NAME_LEN),
    command: z.string().max(MAX_PROMPT_LEN),
    placement: z.enum(['background', 'tab', 'split-right', 'split-bottom']),
    actionId: z.string().min(1).max(MAX_ID_LEN).optional(),
    agent: z
      .object({
        presetId: z.string().min(1).max(MAX_ID_LEN).optional(),
        launchModeId: z.string().min(1).max(MAX_ID_LEN).optional(),
      })
      .strict()
      .optional(),
    destination: z.enum(SETUP_DESTINATIONS).optional(),
    trigger: z.enum(SETUP_TRIGGERS).optional(),
  })
  .strict();

// appearanceProblems checks customPalette's fields and colors.
const settingsAppearancePayloadSchema = z
  .object({
    palette: z.string().min(1).max(MAX_ID_LEN),
    customPalette: z.record(z.string(), z.unknown()).optional(),
    accent: z.string().max(MAX_COLOR_LEN),
    borderRadius: z.number(),
  })
  .strict();

// Each settings file checks its own content, so problems name its fields.
const settingsFilePayloadSchema = z.record(z.string(), z.unknown());

/** The guide that describes each settings resource without a schema. */
const SETTINGS_SCHEMA_GUIDES: Record<string, string> = {
  actions: 'project-setup',
  'workspace-setup': 'project-setup',
  automations: 'automations',
  appearance: 'appearance',
};

const settingsAutomationTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('ssh'), hostId: z.string().min(1).max(MAX_ID_LEN) }).strict(),
]);

const settingsAutomationsPayloadSchema = z
  .object({
    automations: z.array(
      z
        .object({
          id: z.string().min(1).max(MAX_ID_LEN).optional(),
          name: z.string().min(1).max(200),
          prompt: z.string().min(1).max(32_000),
          target: settingsAutomationTargetSchema,
          presetId: z.string().min(1).max(MAX_ID_LEN).optional(),
          launchModeId: z.string().min(1).max(MAX_ID_LEN).optional(),
          startBranch: z
            .union([z.literal(''), z.string().max(1024).regex(BRANCH_NAME_PATTERN)])
            .optional(),
          // Shown by settings get; accepted so its output can be sent back unchanged.
          agentName: z.string().max(MAX_NAME_LEN).optional(),
          schedule: z
            .object({
              cron: z.string().min(1).max(256),
              timeZone: z.string().min(1).max(64).optional(),
            })
            .strict(),
          enabled: z.boolean().optional(),
          missedRunGraceMinutes: z.number().int().nonnegative().optional(),
        })
        .strict()
    ),
  })
  .strict();

const settingsWorkspaceSetupPayloadSchema = z
  .object({
    setupSteps: z.array(settingsSetupStepSchema),
    agentPlacement: z.enum(['tab', 'split-right', 'split-bottom']),
    agentLayoutOrder: z.number().int().nonnegative(),
    trashCleanupScript: z.string().max(MAX_PROMPT_LEN),
  })
  .strict();

/** A settings resource: what its GET reads, and what its PUT takes and proposes. */
interface SettingsRoute {
  resource: SettingsApprovalRequest['resource'];
  scope?: SettingsActionScope;
  payload: z.ZodType;
  read(service: SettingsManagementService, context: SettingsRequestContext): unknown;
  propose(
    service: SettingsManagementService,
    context: SettingsRequestContext,
    desired: unknown,
    signal: AbortSignal
  ): Promise<SettingsProposalResult<object>>;
}

/** Pairs a payload schema with the proposal that takes what it parsed. */
function settingsRoute<Payload extends z.ZodType>(
  route: Omit<SettingsRoute, 'payload' | 'propose'> & {
    payload: Payload;
    propose(
      service: SettingsManagementService,
      context: SettingsRequestContext,
      desired: z.output<Payload>,
      signal: AbortSignal
    ): Promise<SettingsProposalResult<object>>;
  }
): SettingsRoute {
  return route;
}

function actionsRoute(scope: SettingsActionScope): SettingsRoute {
  return settingsRoute({
    resource: 'actions',
    scope,
    payload: settingsActionsPayloadSchema,
    read: (service, context) => service.readActions(context, scope),
    propose: (service, context, desired, signal) =>
      service.proposeActions(context, scope, desired, signal),
  });
}

const ACTIONS_ROUTES: Record<SettingsActionScope, SettingsRoute> = {
  global: actionsRoute('global'),
  'current-project': actionsRoute('current-project'),
};

// Every resource but Quick Commands, whose routes depend on the requested scope.
const SETTINGS_ROUTES = new Map<string, SettingsRoute>([
  [
    '/settings/workspace-setup',
    settingsRoute({
      resource: 'workspace-setup',
      payload: settingsWorkspaceSetupPayloadSchema,
      read: (service, context) => service.readWorkspaceSetup(context),
      propose: (service, context, desired, signal) =>
        service.proposeWorkspaceSetup(context, desired, signal),
    }),
  ],
  [
    '/settings/automations',
    settingsRoute({
      resource: 'automations',
      payload: settingsAutomationsPayloadSchema,
      read: (service, context) => service.readAutomations(context),
      propose: (service, context, desired, signal) =>
        service.proposeAutomations(context, desired, signal),
    }),
  ],
  [
    '/settings/appearance',
    settingsRoute({
      resource: 'appearance',
      payload: settingsAppearancePayloadSchema,
      read: (service) => service.readAppearance(),
      propose: (service, context, desired, signal) =>
        service.proposeAppearance(context, desired as AppearanceSettings, signal),
    }),
  ],
  ...SETTINGS_FILE_RESOURCES.map((resource): [string, SettingsRoute] => [
    `/settings/${resource}`,
    settingsRoute({
      resource,
      payload: settingsFilePayloadSchema,
      read: (service) => service.readSettingsFile(resource),
      propose: (service, context, desired, signal) =>
        service.proposeSettingsFile(context, resource, desired, signal),
    }),
  ]),
]);

function logSettingsOutcome(
  service: SettingsManagementService,
  route: SettingsRoute,
  context: SettingsRequestContext,
  outcome: string,
  errorCode?: string
): void {
  const project = service.targetProject(context);
  logger.info('Settings management request', {
    resource: route.resource,
    ...(route.scope ? { scope: route.scope } : {}),
    ...(project ? { project: { id: project.id, name: project.name } } : {}),
    outcome,
    ...(errorCode ? { errorCode } : {}),
  });
}

export function handleSettingsManagementRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rawUrl: string,
  scopedTerminalId?: string
): void {
  void (async () => {
    const url = parseRequestUrl(rawUrl);
    if (!url) return writeSettingsError(res, 400, 'INVALID_URL', 'Invalid request URL.');
    if (req.method !== 'GET' && req.method !== 'PUT') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET, PUT' });
      res.end(
        JSON.stringify({
          error: {
            code: 'METHOD_NOT_ALLOWED',
            message: 'Only GET and PUT are supported.',
            details: [],
          },
        })
      );
      return;
    }
    const pathname = url.pathname.startsWith('/api/v1/settings/')
      ? url.pathname.slice('/api/v1'.length)
      : url.pathname;
    const schemaOf = /^\/settings\/([a-z-]+)\/schema$/.exec(pathname)?.[1];
    if (schemaOf !== undefined) {
      writeSettingsSchema(req, res, schemaOf);
      return;
    }
    const isActions = pathname === '/settings/actions';
    const namedRoute = SETTINGS_ROUTES.get(pathname);
    if (!isActions && !namedRoute) {
      writeSettingsError(res, 404, 'NOT_FOUND', 'Not found.');
      return;
    }
    const scope = isActions ? url.searchParams.get('scope') : null;
    if (isActions && scope !== 'global' && scope !== 'current-project') {
      writeSettingsError(res, 400, 'INVALID_SCOPE', 'scope must be global or current-project.');
      return;
    }
    const headerTerminalId = singleHeader(req.headers['x-komla-terminal-id']);
    if (scopedTerminalId && headerTerminalId && scopedTerminalId !== headerTerminalId) {
      writeSettingsError(
        res,
        409,
        'PROJECT_CONTEXT_CONFLICT',
        'Terminal URL and header identities do not match.'
      );
      return;
    }
    const context: SettingsRequestContext = {
      terminalId: scopedTerminalId ?? headerTerminalId,
      workspaceId: singleHeader(req.headers['x-komla-workspace-id']),
      sshHostId: singleHeader(req.headers['x-komla-ssh-host-id']),
      cwd: url.searchParams.get('cwd') ?? undefined,
    };
    const service = getSettingsManagementService();
    const route = isActions ? ACTIONS_ROUTES[scope as SettingsActionScope] : namedRoute!;
    try {
      // A plugin just copied into the plugins folder may not have been read yet.
      if (route.resource === 'plugins') await pluginsService.scan();
      if (req.method === 'GET') {
        const read = await route.read(service, context);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(read));
        logSettingsOutcome(service, route, context, 'read');
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(singleHeader(req.headers['content-type']) ?? '')) {
        writeSettingsError(
          res,
          400,
          'INVALID_CONTENT_TYPE',
          'Content-Type must be application/json.'
        );
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await readBody(req));
      } catch (error) {
        const tooLarge = isBodyTooLarge(error);
        writeSettingsError(
          res,
          tooLarge ? 413 : 400,
          tooLarge ? 'BODY_TOO_LARGE' : 'INVALID_JSON',
          tooLarge ? 'Request body too large.' : 'Malformed JSON.'
        );
        return;
      }
      const controller = new AbortController();
      req.socket?.setKeepAlive?.(true);
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const parsed = route.payload.safeParse(raw);
      if (!parsed.success) {
        writeSettingsError(
          res,
          400,
          'INVALID_REQUEST',
          'Invalid request body.',
          parsed.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          }))
        );
        return;
      }
      const result = await route.propose(service, context, parsed.data, controller.signal);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: result.status, applied: result.applied, ...result.value }));
      logSettingsOutcome(service, route, context, result.status);
    } catch (error) {
      const managed = error instanceof SettingsManagementError;
      const status = managed ? error.status : 500;
      const code = managed ? error.code : 'INTERNAL_ERROR';
      const message = managed ? error.message : 'Failed to update settings.';
      logSettingsOutcome(service, route, context, 'rejected', code);
      if (!managed) logger.error('Settings management request failed:', error);
      writeSettingsError(res, status, code, message, managed ? error.details : []);
    }
  })();
}

/** A settings resource's format, which `komla settings schema` prints. */
function writeSettingsSchema(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  resource: string
): void {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
    res.end(
      JSON.stringify({
        error: { code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported.', details: [] },
      })
    );
    return;
  }
  const fileResource = SETTINGS_FILE_RESOURCES.find((candidate) => candidate === resource);
  if (!fileResource) {
    // Komla checks these beyond what a schema says, so their guides describe them.
    const guide = SETTINGS_SCHEMA_GUIDES[resource];
    writeSettingsError(
      res,
      404,
      guide ? 'SCHEMA_UNAVAILABLE' : 'NOT_FOUND',
      guide ? `${resource} has no schema; \`komla skill ${guide}\` describes it.` : 'Not found.'
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(getSettingsManagementService().readSettingsFileSchema(fileResource)));
}

function writeSettingsError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  details: unknown[] = []
): void {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { code, message, details } }));
}
