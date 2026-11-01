import { join } from 'path';

import { nativeTheme } from 'electron';
import { z } from 'zod';

import {
  ACTION_SSH_EXECUTION_LOCATIONS,
  SETTINGS_FILE_RESOURCES,
  SETUP_DESTINATIONS,
  SETUP_TRIGGERS,
} from '../../../../shared/types';
import { BRANCH_NAME_PATTERN } from '../../../ipc/validation/primitives';
import { createLogger } from '../../../lib/logger';
import { actionService } from '../../action.service';
import { agentPresetService } from '../../agent-preset.service';
import {
  automationAgentProblem,
  automationHostProblem,
  automationService,
} from '../../automation.service';
import { configService } from '../../config.service';
import { customizationService } from '../../customization.service';
import { MAX_ID_LEN, MAX_NAME_LEN, MAX_PROMPT_LEN } from '../../komla-operation/schema';
import { getKomlaBasePath } from '../../paths';
import { pluginsService } from '../../plugins.service';
import { projectService } from '../../project.service';
import { settingsApprovalService } from '../../settings-approval.service';
import { createSettingsFiles } from '../../settings-files';
import {
  SettingsManagementError,
  SettingsManagementService,
  type SettingsApprovalRequest,
  type SettingsRequestContext,
} from '../../settings-management.service';
import { shortcutsService } from '../../shortcuts.service';
import { sshHostService } from '../../ssh-host.service';
import { workspaceCwdResolutionService } from '../../workspace-cwd-resolution.service';
import { workspaceService } from '../../workspace.service';
import { parseRequestUrl, readBody, singleHeader } from '../http-io';

import type { AppearanceSettings, Project, Workspace } from '../../../../shared/types';
import type http from 'http';

const logger = createLogger('HttpServerService');

const MAX_COLOR_LEN = 256;

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

let settingsService: SettingsManagementService | null = null;

function getSettingsManagementService(): SettingsManagementService {
  if (settingsService) return settingsService;
  settingsService = new SettingsManagementService({
    actions: actionService,
    projects: projectService,
    workspaces: workspaceService,
    resolveProjectByCwd: (cwd, sshHostId) => {
      const result = workspaceCwdResolutionService.findProjectByCwd(cwd, {
        workspaces: workspaceService
          .list()
          .filter(
            (workspace) =>
              !sshHostId ||
              (workspace.backend?.kind === 'ssh' && workspace.backend.hostId === sshHostId)
          ),
        getProject: (id) => projectService.get(id),
        komlaBasePath: getKomlaBasePath(),
      });
      return {
        project: result.project,
        workspace: result.sourceWorkspace,
        error: result.error,
      };
    },
    presets: agentPresetService,
    appearance: {
      get: () => customizationService.getTheme(),
      systemIsDark: () => nativeTheme.shouldUseDarkColors,
      set: (settings) => customizationService.setAppearance(settings),
    },
    environmentConfiguration: () => {
      const config = configService.get();
      return {
        lastWorkspaceEnvironment: config.lastWorkspaceEnvironment,
        defaultSshWorkspaceMode: config.defaultSshWorkspaceMode,
        sshHosts: sshHostService
          .list()
          .filter((host) => !host.setupPending)
          .map(({ id }) => ({ id })),
      };
    },
    files: createSettingsFiles({
      settingsPath: join(getKomlaBasePath(), 'settings'),
      shortcuts: {
        get: () => shortcutsService.getConfig().shortcuts,
        update: (shortcuts) => shortcutsService.updateConfig({ shortcuts }),
      },
      terminal: {
        get: () => customizationService.getTerminal(),
        update: (updates) => customizationService.updateTerminal(updates),
      },
      presets: agentPresetService,
      plugins: pluginsService,
    }),
    automations: {
      list: () => automationService.list(),
      listCurrent: (options) => automationService.listCurrent(options),
      hostProblem: (project) => automationHostProblem(project),
      agentProblem: (target, presetId, launchModeId) =>
        automationAgentProblem(target, presetId, launchModeId),
      save: (params) => automationService.save(params),
      setEnabled: (target, id, enabled) => automationService.setEnabled(target, id, enabled),
      delete: (target, id) => automationService.delete(target, id),
      hostName: (hostId) => sshHostService.get(hostId)?.name,
      timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
    approve: (request, signal) => settingsApprovalService.approve(request, signal),
    feedback: (message, workspace) => settingsApprovalService.sendFeedback(message, workspace),
  });
  return settingsService;
}

function resolveSettingsTarget(context: SettingsRequestContext): {
  workspace?: Workspace;
  project?: Project;
} {
  const terminalWorkspace = context.terminalId
    ? workspaceService.findWorkspaceByTerminalId(context.terminalId)
    : undefined;
  const explicitWorkspace = context.workspaceId
    ? workspaceService.get(context.workspaceId)
    : undefined;
  const identifiedWorkspace = terminalWorkspace ?? explicitWorkspace;
  if (identifiedWorkspace) {
    return {
      workspace: identifiedWorkspace,
      project: identifiedWorkspace.projectId
        ? projectService.get(identifiedWorkspace.projectId)
        : undefined,
    };
  }
  if (!context.cwd) return {};
  const resolved = workspaceCwdResolutionService.findProjectByCwd(context.cwd, {
    workspaces: workspaceService
      .list()
      .filter(
        (workspace) =>
          !context.sshHostId ||
          (workspace.backend?.kind === 'ssh' && workspace.backend.hostId === context.sshHostId)
      ),
    getProject: (id) => projectService.get(id),
    komlaBasePath: getKomlaBasePath(),
  });
  return { workspace: resolved.sourceWorkspace, project: resolved.project };
}

function logSettingsOutcome(
  resource: SettingsApprovalRequest['resource'],
  scope: 'global' | 'current-project' | undefined,
  context: SettingsRequestContext,
  outcome: string,
  errorCode?: string
): void {
  const { project } = resolveSettingsTarget(context);
  logger.info('Settings management request', {
    resource,
    ...(scope ? { scope } : {}),
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
    const isSetup = pathname === '/settings/workspace-setup';
    const isAppearance = pathname === '/settings/appearance';
    const isAutomations = pathname === '/settings/automations';
    const fileResource = SETTINGS_FILE_RESOURCES.find(
      (candidate) => pathname === `/settings/${candidate}`
    );
    if (!isActions && !isSetup && !isAppearance && !isAutomations && !fileResource) {
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
    const resource =
      fileResource ??
      (isActions
        ? 'actions'
        : isSetup
          ? 'workspace-setup'
          : isAutomations
            ? 'automations'
            : 'appearance');
    const settingsScope = isActions ? (scope as 'global' | 'current-project') : undefined;
    try {
      // A plugin just copied into the plugins folder may not have been read yet.
      if (fileResource === 'plugins') await pluginsService.scan();
      if (req.method === 'GET') {
        const read = fileResource
          ? service.readSettingsFile(fileResource)
          : isActions
            ? service.readActions(context, scope as 'global' | 'current-project')
            : isSetup
              ? service.readWorkspaceSetup(context)
              : isAutomations
                ? await service.readAutomations(context)
                : service.readAppearance();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(read));
        logSettingsOutcome(resource, settingsScope, context, 'read');
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
        const tooLarge = error instanceof Error && error.message === 'Request body too large';
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
      const parsed = fileResource
        ? settingsFilePayloadSchema.safeParse(raw)
        : isActions
          ? settingsActionsPayloadSchema.safeParse(raw)
          : isSetup
            ? settingsWorkspaceSetupPayloadSchema.safeParse(raw)
            : isAutomations
              ? settingsAutomationsPayloadSchema.safeParse(raw)
              : settingsAppearancePayloadSchema.safeParse(raw);
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
      const result = fileResource
        ? await service.proposeSettingsFile(context, fileResource, parsed.data, controller.signal)
        : isActions
          ? await service.proposeActions(
              context,
              scope as 'global' | 'current-project',
              parsed.data as z.infer<typeof settingsActionsPayloadSchema>,
              controller.signal
            )
          : isSetup
            ? await service.proposeWorkspaceSetup(
                context,
                parsed.data as z.infer<typeof settingsWorkspaceSetupPayloadSchema>,
                controller.signal
              )
            : isAutomations
              ? await service.proposeAutomations(
                  context,
                  parsed.data as z.infer<typeof settingsAutomationsPayloadSchema>,
                  controller.signal
                )
              : await service.proposeAppearance(
                  context,
                  parsed.data as AppearanceSettings,
                  controller.signal
                );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: result.status, applied: result.applied, ...result.value }));
      logSettingsOutcome(resource, settingsScope, context, result.status);
    } catch (error) {
      const managed = error instanceof SettingsManagementError;
      const status = managed ? error.status : 500;
      const code = managed ? error.code : 'INTERNAL_ERROR';
      const message = managed ? error.message : 'Failed to update settings.';
      logSettingsOutcome(resource, settingsScope, context, 'rejected', code);
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
