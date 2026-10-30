import { join } from 'path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

import { IPC } from '../../../src/shared/constants/ipc-channels';
import {
  createTerminal,
  createWorkspace,
  createDirectoryWorkspace,
  createWorktreeWorkspace,
  createProject,
  resetIdCounter,
} from '../../factories';
import { mockElectron, createMockBrowserWindow } from '../../mocks/electron';

// ============================================================================
// Module-level mocks
// ============================================================================

// Suppress console output from the service
vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

// Electron
const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

// HTTP — captured request handler is set when start() calls http.createServer
type RequestHandler = (req: unknown, res: unknown) => void;
let capturedHandler: RequestHandler | null = null;

const mockServer = {
  listen: vi.fn(),
  close: vi.fn(),
  once: vi.fn(),
  removeListener: vi.fn(),
};
const mockCreateServer = vi.fn((handler: RequestHandler) => {
  capturedHandler = handler;
  return mockServer;
});
vi.mock('http', () => ({
  default: { createServer: mockCreateServer },
}));

const mockRealpathSync = vi.fn((path: string) => path);
mockRealpathSync.native = mockRealpathSync;

const mockReadFileSync = vi.fn();

vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  realpathSync: mockRealpathSync,
  readFileSync: mockReadFileSync,
}));

// Workspace service
const mockWorkspaceService = {
  list: vi.fn((): unknown[] => []),
  get: vi.fn((): unknown => undefined),
  findWorkspaceByTerminalId: vi.fn((): unknown => undefined),
  create: vi.fn(),
  update: vi.fn(),
  addAgentTab: vi.fn(),
  persistSshAttention: vi.fn(),
  hasAcceptedTerminalHook: vi.fn(() => false),
  recordCopiedHookDelivery: vi.fn(),
  sshSync: { expectWorkspace: vi.fn() },
  attention: {
    hook: vi.fn((): Promise<string> => Promise.resolve('taken')),
    hooksStopped: vi.fn(),
  },
};
vi.mock('../../../src/main/services/workspace.service', () => ({
  workspaceService: mockWorkspaceService,
}));

const mockWorkspaceStatusService = { change: vi.fn() };
vi.mock('../../../src/main/services/workspace-status.service', () => ({
  workspaceStatusService: mockWorkspaceStatusService,
}));

// Project service
const mockProjectService = {
  list: vi.fn((): unknown[] => []),
  get: vi.fn((): unknown => undefined),
  getStorageRevision: vi.fn(() => 'projects-revision'),
  getStorageRevisionState: vi.fn(() => ({
    status: 'current',
    revision: 'projects-revision',
  })),
  replaceWorkspaceSetup: vi.fn(() => 'projects-revision-2'),
};
vi.mock('../../../src/main/services/project.service', () => ({
  projectService: mockProjectService,
}));

const mockActionService = {
  list: vi.fn((): unknown[] => []),
  getStorageRevision: vi.fn(() => 'actions-revision'),
  getStorageRevisionState: vi.fn(() => ({
    status: 'current',
    revision: 'actions-revision',
  })),
  replaceAll: vi.fn(() => 'actions-revision-2'),
};
vi.mock('../../../src/main/services/action.service', () => ({ actionService: mockActionService }));

const mockAutomationService = {
  list: vi.fn(async (): Promise<unknown[]> => [
    { target: { kind: 'local' }, automations: [], runs: {}, scheduler: { available: true } },
  ]),
  listCurrent: vi.fn(async (): Promise<unknown[]> => [
    { target: { kind: 'local' }, automations: [], runs: {}, scheduler: { available: true } },
  ]),
  save: vi.fn(async () => undefined),
  setEnabled: vi.fn(async () => undefined),
  delete: vi.fn(async () => undefined),
};
vi.mock('../../../src/main/services/automation.service', () => ({
  automationService: mockAutomationService,
  automationHostProblem: vi.fn(async () => undefined),
  automationAgentProblem: vi.fn(() => undefined),
}));

const mockAgentPresetService = {
  list: vi.fn((): unknown[] => []),
  getActivePresets: vi.fn((): unknown[] => []),
};
vi.mock('../../../src/main/services/agent-preset.service', () => ({
  agentPresetService: mockAgentPresetService,
}));

const mockCustomizationService = {
  getTheme: vi.fn(() => ({
    mode: 'dark',
    palette: 'default',
    followSystem: false,
    lightPalette: 'frost',
    colors: { accent: 'oklch(0.65 0.15 250)', lightAccent: 'oklch(0.205 0 0)' },
    typography: { fontFamily: 'Inter', fontSize: 14, borderRadius: 6 },
  })),
  setAppearance: vi.fn(),
};
vi.mock('../../../src/main/services/customization.service', () => ({
  customizationService: mockCustomizationService,
}));

// One stand-in serves every settings file; each file's own checks are tested with the files.
const mockSettingsFile = {
  name: 'Hooks',
  schema: [
    {
      schema: z
        .object({ hooks: z.array(z.object({ id: z.string() })) })
        .meta({ description: 'Hooks to run.' }),
    },
  ],
  read: vi.fn(() => ({ _version: 1, hooks: [] as unknown[] })),
  revision: vi.fn(() => 'revision-1'),
  prepare: vi.fn(),
  write: vi.fn(),
};
vi.mock('../../../src/main/services/settings-files', () => ({
  createSettingsFiles: () => ({
    'status-items': mockSettingsFile,
    hooks: mockSettingsFile,
    shortcuts: mockSettingsFile,
    terminal: mockSettingsFile,
  }),
}));
vi.mock('../../../src/main/services/shortcuts.service', () => ({ shortcutsService: {} }));

const mockSshHostService = {
  list: vi.fn((): unknown[] => []),
  get: vi.fn((): unknown => undefined),
  isReady: vi.fn(() => true),
};
vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: mockSshHostService,
}));

// Window service
const mockWindowService = {
  getMainWindowId: vi.fn((): string | null => 'main-window-id'),
  getAllWindowIds: vi.fn((): string[] => ['main-window-id']),
  getWindowId: vi.fn((): string | undefined => undefined),
  sendWhenReady: vi.fn(),
  sendToWindowOrNext: vi.fn(),
  broadcastToAll: vi.fn(),
};
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: mockWindowService,
}));

// Git service
const mockGitService = {
  getCurrentBranch: vi.fn(() => Promise.resolve('main')),
  getCheckedOutBranch: vi.fn((): Promise<string | undefined> => Promise.resolve('main')),
};
vi.mock('../../../src/main/services/git.service', () => ({
  gitService: mockGitService,
}));

// Config service
const mockConfigService = {
  get: vi.fn().mockReturnValue({}),
  update: vi.fn(),
  wasLoadedFromDisk: vi.fn(() => true),
};
vi.mock('../../../src/main/services/config.service', () => ({
  configService: mockConfigService,
}));

// Paths
vi.mock('../../../src/main/services/paths', () => ({
  getKomlaBasePath: () => '/mock/home/.komla',
}));

vi.mock('../../../src/main/services/metrics-collector.service', () => ({
  metricsCollectorService: {
    increment: vi.fn(),
    incrementAction: vi.fn(),
    incrementMcpTool: vi.fn(),
  },
}));

vi.mock('../../../src/main/services/telemetry.service', () => ({
  telemetryService: {
    sendIntegrationMilestone: vi.fn(),
  },
}));

// Logger — captured so we can assert on error calls
const mockLoggerError = vi.fn();
const mockLoggerInfo = vi.fn();
const mockLoggerWarn = vi.fn();
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: mockLoggerInfo,
    warn: mockLoggerWarn,
    error: mockLoggerError,
  }),
}));

// MCP SDK — use classes so they work as constructors with `new`
const mockMcpTool = vi.fn();
const mockMcpConnect = vi.fn(() => Promise.resolve());
const mockTransportHandleRequest = vi.fn(() => Promise.resolve());

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: class MockMcpServer {
    tool = mockMcpTool;
    connect = mockMcpConnect;
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: class MockTransport {
    handleRequest = mockTransportHandleRequest;
  },
}));

// ============================================================================
// Test helpers
// ============================================================================

function createMockRequest(
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {}
) {
  const dataHandlers: ((chunk: Buffer) => void)[] = [];
  const endHandlers: (() => void)[] = [];

  return {
    method,
    url,
    headers,
    destroy: vi.fn(),
    on: vi.fn((event: string, handler: unknown) => {
      if (event === 'data') dataHandlers.push(handler as (chunk: Buffer) => void);
      if (event === 'end') endHandlers.push(handler as () => void);
    }),
    _sendBody() {
      if (body !== undefined) {
        for (const h of dataHandlers) h(Buffer.from(body));
      }
      for (const h of endHandlers) h();
    },
  };
}

function createMockResponse() {
  const closeHandlers: Array<() => void> = [];
  const response = {
    writeHead: vi.fn(),
    end: vi.fn(() => {
      response.writableEnded = true;
    }),
    headersSent: false,
    writableEnded: false,
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'close') closeHandlers.push(handler);
    }),
    _close() {
      for (const handler of closeHandlers) handler();
    },
  };
  return response;
}

async function sendRequest(
  method: string,
  url: string,
  body?: string,
  headers?: Record<string, string>
) {
  const req = createMockRequest(method, url, body, headers);
  const res = createMockResponse();
  capturedHandler!(req, res);
  req._sendBody();
  // Flush async handlers (void (async () => {...})() pattern)
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { req, res };
}

function sendJsonRequest(method: string, url: string, body: string) {
  return sendRequest(method, url, body, { 'content-type': 'application/json' });
}

function parseJsonResponse(res: ReturnType<typeof createMockResponse>): unknown {
  const lastCall = res.end.mock.calls[res.end.mock.calls.length - 1];
  return JSON.parse(lastCall[0] as string);
}

// ============================================================================
// Tests
// ============================================================================

describe('HttpServerService', () => {
  let httpServerService: (typeof import('../../../src/main/services/http-server.service'))['httpServerService'];

  beforeEach(async () => {
    vi.resetModules();
    resetIdCounter();
    capturedHandler = null;

    // Restore default mock implementations
    mockCreateServer.mockImplementation((handler: RequestHandler) => {
      capturedHandler = handler;
      return mockServer;
    });
    mockServer.listen.mockImplementation((_port: number, _host: string, callback: () => void) => {
      callback();
    });
    mockServer.close.mockReset();
    mockServer.once.mockReset();
    mockServer.removeListener.mockReset();
    mockLoggerError.mockReset();
    mockLoggerInfo.mockReset();
    mockLoggerWarn.mockReset();
    mockRealpathSync.mockReset();
    // Either separator: on Windows the service normalizes the cwd to backslashes first.
    mockRealpathSync.mockImplementation((path: string) =>
      path.replace(/^([\\/])private\1tmp\1komla-dev/, '$1tmp$1komla-dev')
    );
    mockRealpathSync.native = mockRealpathSync;
    mockReadFileSync.mockReset();
    mockWindowService.getMainWindowId.mockReset();
    mockWindowService.getMainWindowId.mockReturnValue('main-window-id');
    mockWindowService.getAllWindowIds.mockReset();
    mockWindowService.getAllWindowIds.mockReturnValue(['main-window-id']);
    mockWindowService.getWindowId.mockReset();
    mockWindowService.getWindowId.mockReturnValue(undefined);
    mockWindowService.sendWhenReady.mockReset();
    mockWindowService.sendToWindowOrNext.mockReset();

    mockWorkspaceService.list.mockReturnValue([]);
    mockWorkspaceService.get.mockReset();
    mockWorkspaceService.get.mockReturnValue(undefined);
    mockWorkspaceService.findWorkspaceByTerminalId.mockReset();
    mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(undefined);
    mockWorkspaceService.create.mockResolvedValue(undefined);
    mockWorkspaceService.addAgentTab.mockReset();
    mockWorkspaceService.persistSshAttention.mockReset();
    mockWorkspaceService.persistSshAttention.mockResolvedValue(undefined);
    mockWorkspaceService.hasAcceptedTerminalHook.mockReset();
    mockWorkspaceService.hasAcceptedTerminalHook.mockReturnValue(false);
    mockWorkspaceService.attention.hook.mockReset();
    mockWorkspaceService.attention.hook.mockResolvedValue('taken');
    mockWorkspaceService.attention.hooksStopped.mockReset();
    mockWorkspaceStatusService.change.mockReset();
    mockWorkspaceStatusService.change.mockResolvedValue({
      disposition: 'accepted',
      workspaceId: 'ws-ssh',
      stateHash: 'state',
    });
    mockWorkspaceService.update.mockImplementation(
      (_workspaceId: string, updates: Record<string, unknown>) =>
        createWorkspace({
          id: 'ws-updated',
          name: 'Updated Workspace',
          workingDirectory: '/projects/my-app',
          ...(updates as Partial<ReturnType<typeof createWorkspace>>),
        })
    );
    mockProjectService.list.mockReturnValue([]);
    mockProjectService.get.mockReset();
    mockProjectService.get.mockReturnValue(undefined);
    mockAgentPresetService.list.mockReset();
    mockAgentPresetService.list.mockReturnValue([]);
    mockAgentPresetService.getActivePresets.mockReset();
    mockAgentPresetService.getActivePresets.mockReturnValue([]);
    mockSshHostService.list.mockReset();
    mockSshHostService.list.mockReturnValue([]);
    mockSshHostService.get.mockReset();
    mockSshHostService.get.mockReturnValue(undefined);
    mockSshHostService.isReady.mockReset();
    mockSshHostService.isReady.mockReturnValue(true);
    mockConfigService.get.mockReset();
    mockConfigService.get.mockReturnValue({});
    mockConfigService.update.mockReset();
    mockConfigService.wasLoadedFromDisk.mockReset();
    mockConfigService.wasLoadedFromDisk.mockReturnValue(true);
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([]);

    mockMcpTool.mockReset();
    mockMcpConnect.mockResolvedValue(undefined);
    mockTransportHandleRequest.mockResolvedValue(undefined);

    const mod = await import('../../../src/main/services/http-server.service');
    httpServerService = mod.httpServerService;
  });

  describe('settings management API', () => {
    it('serves Global Actions independently of MCP settings', async () => {
      mockConfigService.get.mockReturnValue({ disableMcpServer: true });
      mockActionService.list.mockReturnValue([
        { id: 'global', title: 'Review', content: 'Review changes' },
        { id: 'local', title: 'Test', content: 'npm test', projectIds: ['project-1'] },
      ]);
      httpServerService.start();

      const { res } = await sendRequest('GET', '/settings/actions?scope=global');

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
      expect(parseJsonResponse(res)).toEqual({
        scope: 'global',
        actions: [{ id: 'global', title: 'Review', content: 'Review changes', type: 'prompt' }],
      });
      expect(mockLoggerInfo).toHaveBeenCalledWith('Settings management request', {
        resource: 'actions',
        scope: 'global',
        outcome: 'read',
      });
    });

    it('keeps the versioned settings route as a compatibility alias', async () => {
      mockActionService.list.mockReturnValue([]);
      httpServerService.start();

      const { res } = await sendRequest('GET', '/api/v1/settings/actions?scope=global');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(parseJsonResponse(res)).toMatchObject({ scope: 'global', actions: [] });
    });

    it('resolves an SSH project from terminal identity with workspace identity as fallback', async () => {
      const project = createProject({ id: 'project-1', name: 'Remote Project' });
      const workspace = createWorktreeWorkspace({
        id: 'workspace-1',
        projectId: project.id,
        backend: {
          kind: 'ssh',
          hostId: 'ssh-dev',
          remoteDirectory: '/home/dev/.komla/worktrees/project/feature',
          remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
          remoteProjectRoot: '/home/dev/.komla/worktrees/project',
          gitUrl: 'git@example.com:project.git',
        },
      });
      mockWorkspaceService.get.mockImplementation((id: string) =>
        id === workspace.id ? workspace : undefined
      );
      mockWorkspaceService.findWorkspaceByTerminalId.mockImplementation((id: string) =>
        id === 'terminal-1' ? workspace : undefined
      );
      mockProjectService.get.mockImplementation((id: string) =>
        id === project.id ? project : undefined
      );
      mockActionService.list.mockReturnValue([
        { id: 'remote', title: 'Dev', content: 'npm run dev', projectIds: [project.id] },
      ]);
      httpServerService.start();

      const terminalResult = await sendRequest(
        'GET',
        '/api/v1/settings/actions?scope=current-project',
        undefined,
        {
          'x-komla-terminal-id': 'terminal-1',
          'x-komla-ssh-host-id': 'ssh-dev',
        }
      );
      expect(terminalResult.res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));

      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(undefined);
      const { res } = await sendRequest(
        'GET',
        '/api/v1/settings/actions?scope=current-project',
        undefined,
        {
          'x-komla-workspace-id': workspace.id,
          'x-komla-ssh-host-id': 'ssh-dev',
        }
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(parseJsonResponse(res)).toMatchObject({
        project: { id: project.id, name: project.name },
        actions: [{ id: 'remote', title: 'Dev' }],
      });
    });

    it('resolves project context from a terminal-scoped URL without identity parameters', async () => {
      const project = createProject({ id: 'project-1', name: 'Scoped Project' });
      const workspace = createWorktreeWorkspace({
        id: 'workspace-1',
        projectId: project.id,
      });
      mockWorkspaceService.findWorkspaceByTerminalId.mockImplementation((id: string) =>
        id === 'terminal-1' ? workspace : undefined
      );
      mockProjectService.get.mockImplementation((id: string) =>
        id === project.id ? project : undefined
      );
      mockActionService.list.mockReturnValue([
        { id: 'dev', title: 'Dev', content: 'npm run dev', projectIds: [project.id] },
      ]);
      httpServerService.start();

      const { res } = await sendRequest(
        'GET',
        '/terminals/terminal-1/settings/actions?scope=current-project'
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(parseJsonResponse(res)).toMatchObject({
        project: { id: project.id, name: project.name },
        actions: [{ id: 'dev', title: 'Dev' }],
      });
    });

    it("reads and applies the current project's automations through the terminal-scoped API", async () => {
      const project = createProject({ id: 'project-1', name: 'Scoped Project' });
      const workspace = createWorktreeWorkspace({ id: 'workspace-1', projectId: project.id });
      mockWorkspaceService.findWorkspaceByTerminalId.mockImplementation((id: string) =>
        id === 'terminal-1' ? workspace : undefined
      );
      mockProjectService.get.mockImplementation((id: string) =>
        id === project.id ? project : undefined
      );
      const window = createMockBrowserWindow();
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      httpServerService.start();

      const read = await sendRequest('GET', '/terminals/terminal-1/settings/automations');
      expect(parseJsonResponse(read.res)).toEqual({
        project: { id: project.id, name: project.name },
        targets: [{ target: { kind: 'local' }, name: 'This computer' }],
        automations: [],
        agents: [],
      });
      expect(mockAutomationService.listCurrent).toHaveBeenCalled();

      const desired = {
        automations: [
          {
            name: 'Nightly deps',
            prompt: 'Update dependencies',
            target: { kind: 'local' },
            schedule: { cron: '0 2 * * *', timeZone: 'UTC' },
          },
        ],
      };
      const pending = await sendRequest(
        'PUT',
        '/terminals/terminal-1/settings/automations',
        JSON.stringify(desired),
        { 'content-type': 'application/json' }
      );
      const prompt = window.webContents.send.mock.calls.find(
        ([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED
      )?.[1] as { id: string };
      expect(prompt).toMatchObject({
        resource: 'automations',
        target: 'Scoped Project Automations',
        changes: [{ operation: 'add', kind: 'automation', title: 'Nightly deps' }],
      });

      httpServerService.resolveSettingsApproval(prompt.id, 'apply', window.webContents.id);
      await vi.waitFor(() => expect(pending.res.end).toHaveBeenCalled());
      expect(mockAutomationService.save).toHaveBeenCalledWith({
        name: 'Nightly deps',
        prompt: 'Update dependencies',
        projectId: project.id,
        target: { kind: 'local' },
        schedule: { cron: '0 2 * * *', timeZone: 'UTC' },
        enabled: true,
        missedRunGraceMinutes: 720,
      });
      expect(parseJsonResponse(pending.res)).toMatchObject({ status: 'applied', applied: true });
    });

    it('rejects conflicting terminal URL and header identities', async () => {
      httpServerService.start();

      const { res } = await sendRequest(
        'GET',
        '/terminals/terminal-1/settings/actions?scope=current-project',
        undefined,
        { 'x-komla-terminal-id': 'terminal-2' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(409, expect.any(Object));
      expect(parseJsonResponse(res)).toMatchObject({
        error: { code: 'PROJECT_CONTEXT_CONFLICT' },
      });
    });

    it('accepts settings writes without an If-Match header', async () => {
      mockActionService.list.mockReturnValue([]);
      httpServerService.start();

      const result = await sendRequest(
        'PUT',
        '/settings/actions?scope=global',
        JSON.stringify({ actions: [] }),
        { 'content-type': 'application/json' }
      );

      expect(result.res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(parseJsonResponse(result.res)).toMatchObject({
        status: 'unchanged',
        applied: false,
      });
    });

    it('round-trips destination-aware Workspace Setup through the terminal-scoped API', async () => {
      const project = createProject({
        id: 'project-1',
        setupSteps: [
          {
            id: 'install',
            name: 'Install',
            command: 'npm install',
            placement: 'background',
            destination: 'ssh-workspace-repository',
            trigger: 'workspace-creation',
          },
        ],
      });
      const workspace = createWorktreeWorkspace({
        id: 'workspace-1',
        projectId: project.id,
      });
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
      mockProjectService.get.mockReturnValue(project);
      httpServerService.start();

      const result = await sendRequest(
        'PUT',
        '/terminals/terminal-1/settings/workspace-setup',
        JSON.stringify({
          setupSteps: project.setupSteps,
          agentPlacement: 'tab',
          agentLayoutOrder: 0,
          trashCleanupScript: '',
        }),
        { 'content-type': 'application/json' }
      );

      expect(result.res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(parseJsonResponse(result.res)).toMatchObject({
        status: 'unchanged',
        applied: false,
      });
    });

    it('exposes configured environments and agent-rule preferences with Workspace Setup', async () => {
      const project = createProject({ id: 'project-1' });
      const workspace = createWorktreeWorkspace({
        id: 'workspace-1',
        projectId: project.id,
      });
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
      mockProjectService.get.mockReturnValue(project);
      mockAgentPresetService.list.mockReturnValue([
        {
          id: 'preset-1',
          name: 'Codex',
          launchModes: [{ id: 'remote', name: 'Remote', command: 'codex' }],
        },
      ]);
      mockAgentPresetService.getActivePresets.mockReturnValue([{ presetId: 'preset-1' }]);
      mockSshHostService.list.mockReturnValue([{ id: 'ssh-1' }]);
      mockConfigService.get.mockReturnValue({
        defaultSshWorkspaceMode: 'local-mirror-actions',
        lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'ssh-1' },
      });
      httpServerService.start();

      const { res } = await sendRequest(
        'GET',
        '/terminals/terminal-1/api/v1/settings/workspace-setup'
      );

      expect(parseJsonResponse(res)).toMatchObject({
        setupCapabilities: {
          currentEnvironment: { kind: 'local' },
          ssh: {
            configured: true,
            selectedForNewWorkspaces: true,
            actionsRunInLocalCopy: true,
          },
        },
      });
    });

    it('rejects unknown request fields through the common error envelope', async () => {
      mockActionService.list.mockReturnValue([]);
      httpServerService.start();

      const result = await sendRequest(
        'PUT',
        '/api/v1/settings/actions?scope=global',
        JSON.stringify({ actions: [], project: {} }),
        { 'content-type': 'application/json' }
      );

      expect(result.res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(parseJsonResponse(result.res)).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    });

    it('returns a JSON 413 without destroying the client socket for oversized settings writes', async () => {
      httpServerService.start();
      const result = await sendRequest(
        'PUT',
        '/api/v1/settings/actions?scope=global',
        'x'.repeat(1024 * 1024 + 1),
        { 'content-type': 'application/json' }
      );

      expect(result.req.destroy).not.toHaveBeenCalled();
      expect(result.res.writeHead).toHaveBeenCalledWith(413, expect.any(Object));
      expect(parseJsonResponse(result.res)).toMatchObject({ error: { code: 'BODY_TOO_LARGE' } });
    });

    it('surfaces a settings approval without depending on the renderer-ready queue', async () => {
      mockActionService.list.mockReturnValue([]);
      const window = createMockBrowserWindow({
        isMinimized: vi.fn(() => true),
        isVisible: vi.fn(() => false),
      });
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      mockWindowService.getWindowId.mockReturnValue('window-1');
      httpServerService.start();

      const pending = await sendRequest(
        'PUT',
        '/api/v1/settings/actions?scope=global',
        JSON.stringify({
          actions: [{ title: 'New', content: 'new prompt', type: 'prompt' }],
        }),
        { 'content-type': 'application/json' }
      );

      expect(window.restore).toHaveBeenCalledOnce();
      expect(window.show).toHaveBeenCalledOnce();
      expect(window.focus).toHaveBeenCalledOnce();
      expect(electronMock.app.focus).toHaveBeenCalledOnce();

      expect(window.webContents.send).toHaveBeenCalledWith(
        IPC.SETTINGS_APPROVAL_REQUESTED,
        expect.objectContaining({ target: 'Global Quick Commands' })
      );
      const prompt = window.webContents.send.mock.calls.find(
        ([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED
      )?.[1] as { id: string };
      httpServerService.resolveSettingsApproval(prompt.id, 'cancel', window.webContents.id);
      await vi.waitFor(() => expect(pending.res.end).toHaveBeenCalled());
    });

    it('leaves a background approval waiting in the window without bringing it forward', async () => {
      const window = createMockBrowserWindow({ isMinimized: vi.fn(() => true) });
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);

      const approved = httpServerService.approveSettingsChange({
        resource: 'project-settings',
        project: { id: 'project-1', name: 'web' },
        changes: [],
        description: 'Another computer changed web’s settings on Devbox.',
        background: true,
      });

      const prompt = window.webContents.send.mock.calls.find(
        ([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED
      )?.[1] as { id: string; target: string; description: string };
      expect(prompt).toMatchObject({
        target: 'web settings',
        description: 'Another computer changed web’s settings on Devbox.',
      });
      expect(window.show).not.toHaveBeenCalled();
      expect(window.focus).not.toHaveBeenCalled();
      expect(electronMock.app.focus).not.toHaveBeenCalled();
      httpServerService.resolveSettingsApproval(prompt.id, 'apply', window.webContents.id);
      await expect(approved).resolves.toBe(true);
    });

    it('tells an approval that ended without the user’s answer from one they cancelled', async () => {
      const window = createMockBrowserWindow();
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      const request = {
        resource: 'project-settings' as const,
        project: { id: 'project-1', name: 'web' },
        changes: [],
        background: true,
      };
      const controller = new AbortController();

      const abandoned = httpServerService.decideSettingsChange(request, controller.signal);
      controller.abort();
      await expect(abandoned).resolves.toBe('unanswered');

      const cancelled = httpServerService.decideSettingsChange(request);
      const prompt = window.webContents.send.mock.calls.findLast(
        ([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED
      )?.[1] as { id: string };
      httpServerService.resolveSettingsApproval(prompt.id, 'cancel', window.webContents.id);
      await expect(cancelled).resolves.toBe('cancel');
    });

    it('reads appearance with the built-in themes and applies a change the user keeps', async () => {
      const window = createMockBrowserWindow();
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      mockWindowService.getWindowId.mockReturnValue('window-1');
      httpServerService.start();

      const read = await sendRequest('GET', '/settings/appearance');
      expect(parseJsonResponse(read.res)).toMatchObject({
        palette: 'default',
        accent: 'oklch(0.65 0.15 250)',
        borderRadius: 6,
        themes: expect.arrayContaining([
          { id: 'nord', name: 'Nord', mode: 'dark', accent: 'oklch(0.77 0.06 217)' },
        ]),
        problems: [],
      });

      const desired = { palette: 'nord', accent: 'oklch(0.65 0.15 250)', borderRadius: 6 };
      const pending = await sendRequest('PUT', '/settings/appearance', JSON.stringify(desired), {
        'content-type': 'application/json',
      });
      const prompt = window.webContents.send.mock.calls.find(
        ([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED
      )?.[1] as { id: string };
      expect(prompt).toMatchObject({
        resource: 'appearance',
        target: 'Appearance',
        preview: desired,
        changes: [
          { kind: 'theme', title: 'Nord', details: [{ label: 'From', value: 'Komla Dark' }] },
        ],
      });

      httpServerService.resolveSettingsApproval(prompt.id, 'apply', window.webContents.id);
      await vi.waitFor(() => expect(pending.res.end).toHaveBeenCalled());
      expect(mockCustomizationService.setAppearance).toHaveBeenCalledWith(desired);
      expect(parseJsonResponse(pending.res)).toMatchObject({ status: 'applied', applied: true });
    });

    it('reads a settings file and applies a change the user keeps, with its commands', async () => {
      const window = createMockBrowserWindow();
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      mockWindowService.getWindowId.mockReturnValue('window-1');
      httpServerService.start();

      const read = await sendRequest('GET', '/settings/hooks');
      expect(parseJsonResponse(read.res)).toEqual({ _version: 1, hooks: [] });

      const desired = { hooks: [{ id: 'lint', event: 'agent.done', command: 'npm run lint' }] };
      const change = {
        operation: 'add',
        kind: 'hook',
        title: 'lint',
        contentLabel: 'Command',
        content: 'npm run lint',
        details: [],
      };
      mockSettingsFile.prepare.mockReturnValueOnce({
        next: desired,
        changes: [change],
        warning: 'Komla runs these commands without asking again.',
      });
      const pending = await sendRequest('PUT', '/settings/hooks', JSON.stringify(desired), {
        'content-type': 'application/json',
      });
      const prompt = window.webContents.send.mock.calls.find(
        ([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED
      )?.[1] as { id: string };
      expect(prompt).toMatchObject({
        resource: 'hooks',
        target: 'Hooks',
        changes: [change],
        warning: 'Komla runs these commands without asking again.',
      });

      httpServerService.resolveSettingsApproval(prompt.id, 'apply', window.webContents.id);
      await vi.waitFor(() => expect(pending.res.end).toHaveBeenCalled());
      expect(mockSettingsFile.write).toHaveBeenCalledWith(desired);
      expect(parseJsonResponse(pending.res)).toMatchObject({ status: 'applied', applied: true });
    });

    it("serves a settings file's format, and names the guide for a resource without one", async () => {
      httpServerService.start();

      const { res } = await sendRequest('GET', '/api/v1/settings/hooks/schema');
      expect(parseJsonResponse(res)).toEqual({
        resource: 'hooks',
        text: expect.stringContaining('# hooks\n\nHooks to run.\n\n- `hooks` (required)'),
        sections: [
          { schema: expect.objectContaining({ type: 'object', description: 'Hooks to run.' }) },
        ],
      });

      const actions = await sendRequest('GET', '/settings/actions/schema');
      expect(actions.res.writeHead).toHaveBeenCalledWith(404, expect.any(Object));
      expect(parseJsonResponse(actions.res)).toMatchObject({
        error: {
          code: 'SCHEMA_UNAVAILABLE',
          message: 'actions has no schema; `komla skill project-setup` describes it.',
        },
      });

      const put = await sendRequest('PUT', '/settings/hooks/schema', '{}', {
        'content-type': 'application/json',
      });
      expect(put.res.writeHead).toHaveBeenCalledWith(405, expect.any(Object));
    });

    it('rejects a settings file with problems before asking for approval', async () => {
      const window = createMockBrowserWindow();
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      httpServerService.start();
      mockSettingsFile.prepare.mockReturnValueOnce({
        problems: ['hooks.0.event: Invalid option'],
      });

      const { res } = await sendRequest(
        'PUT',
        '/settings/hooks',
        JSON.stringify({ hooks: [{ id: 'lint', event: 'agent.finished', command: 'true' }] }),
        { 'content-type': 'application/json' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
      expect(parseJsonResponse(res)).toMatchObject({
        error: {
          code: 'INVALID_SETTINGS',
          details: [{ message: 'hooks.0.event: Invalid option' }],
        },
      });
      expect(window.webContents.send).not.toHaveBeenCalledWith(
        IPC.SETTINGS_APPROVAL_REQUESTED,
        expect.anything()
      );
    });

    it('rejects appearance problems before asking for approval', async () => {
      const window = createMockBrowserWindow();
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      httpServerService.start();

      const { res } = await sendRequest(
        'PUT',
        '/settings/appearance',
        JSON.stringify({ palette: 'Dracula', accent: 'oklch(0.65 0.15 250)', borderRadius: 6 }),
        { 'content-type': 'application/json' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(422, expect.any(Object));
      expect(parseJsonResponse(res)).toMatchObject({
        error: {
          code: 'INVALID_APPEARANCE',
          details: [{ message: expect.stringContaining('palette "Dracula"') }],
        },
      });
      expect(window.webContents.send).not.toHaveBeenCalledWith(
        IPC.SETTINGS_APPROVAL_REQUESTED,
        expect.anything()
      );
    });

    it('rejects read-only appearance fields sent back in an apply', async () => {
      httpServerService.start();

      const { res } = await sendRequest(
        'PUT',
        '/settings/appearance',
        JSON.stringify({
          palette: 'nord',
          accent: 'oklch(0.65 0.15 250)',
          borderRadius: 6,
          themes: [],
        }),
        { 'content-type': 'application/json' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(parseJsonResponse(res)).toMatchObject({ error: { code: 'INVALID_REQUEST' } });
    });

    it('resends a pending approval when its target dialog mounts after initial delivery', async () => {
      mockActionService.list.mockReturnValue([]);
      const window = createMockBrowserWindow();
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      mockWindowService.getWindowId.mockReturnValue('window-1');
      httpServerService.start();

      const pending = await sendRequest(
        'PUT',
        '/api/v1/settings/actions?scope=global',
        JSON.stringify({
          actions: [{ title: 'New', content: 'new prompt', type: 'prompt' }],
        }),
        { 'content-type': 'application/json' }
      );
      const prompt = window.webContents.send.mock.calls.find(
        ([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED
      )?.[1];

      expect(httpServerService.requestPendingSettingsApproval(window.webContents.id)).toBe(true);
      expect(window.webContents.send).toHaveBeenCalledWith(IPC.SETTINGS_APPROVAL_REQUESTED, prompt);

      httpServerService.resolveSettingsApproval(
        (prompt as { id: string }).id,
        'cancel',
        window.webContents.id
      );
      await vi.waitFor(() => expect(pending.res.end).toHaveBeenCalled());
    });

    it('cancels approval on response disconnect and releases the Actions lock', async () => {
      mockActionService.list.mockReturnValue([]);
      const window = createMockBrowserWindow();
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      mockWindowService.getWindowId.mockReturnValue('window-1');
      mockWindowService.sendWhenReady.mockImplementation(
        (_windowId: string, channel: string, ...args: unknown[]) => {
          window.webContents.send(channel, ...args);
        }
      );
      httpServerService.start();
      const body = JSON.stringify({
        actions: [{ title: 'New', content: 'new prompt', type: 'prompt' }],
      });

      const pending = await sendRequest('PUT', '/api/v1/settings/actions?scope=global', body, {
        'content-type': 'application/json',
      });
      expect(window.webContents.send).toHaveBeenCalledWith(
        IPC.SETTINGS_APPROVAL_REQUESTED,
        expect.objectContaining({
          resource: 'actions',
          target: 'Global Quick Commands',
          changes: [
            expect.objectContaining({
              operation: 'add',
              title: 'New',
              content: 'new prompt',
            }),
          ],
        })
      );
      const firstPrompt = window.webContents.send.mock.calls.find(
        ([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED
      )?.[1] as { id: string };
      pending.res._close();
      await vi.waitFor(() =>
        expect(window.webContents.send).toHaveBeenCalledWith(
          IPC.SETTINGS_APPROVAL_DISMISSED,
          firstPrompt.id
        )
      );
      await vi.waitFor(() => expect(pending.res.end).toHaveBeenCalled());
      expect(mockActionService.replaceAll).not.toHaveBeenCalled();
      expect(window.webContents.send).not.toHaveBeenCalledWith(
        IPC.SETTINGS_FEEDBACK,
        expect.anything()
      );

      const subsequent = await sendRequest('PUT', '/api/v1/settings/actions?scope=global', body, {
        'content-type': 'application/json',
      });
      const prompts = window.webContents.send.mock.calls.filter(
        ([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED
      );
      const secondPrompt = prompts[1]?.[1] as { id: string };
      expect(httpServerService.resolveSettingsApproval(secondPrompt.id, 'apply', -1)).toBe(false);
      expect(
        httpServerService.resolveSettingsApproval(secondPrompt.id, 'cancel', window.webContents.id)
      ).toBe(true);
      await vi.waitFor(() => expect(subsequent.res.end).toHaveBeenCalled());
      expect(parseJsonResponse(subsequent.res)).toMatchObject({
        status: 'cancelled',
        applied: false,
      });
    });

    it('cancels approval when its renderer reloads and releases the Actions lock', async () => {
      mockActionService.list.mockReturnValue([]);
      const window = createMockBrowserWindow();
      vi.mocked(electronMock.BrowserWindow.getAllWindows).mockReturnValue([window]);
      mockWindowService.getWindowId.mockReturnValue('window-1');
      httpServerService.start();
      const body = JSON.stringify({
        actions: [{ title: 'New', content: 'new prompt', type: 'prompt' }],
      });

      const pending = await sendRequest('PUT', '/api/v1/settings/actions?scope=global', body, {
        'content-type': 'application/json',
      });
      const reloadHandler = window.webContents.on.mock.calls.find(
        ([event]) => event === 'did-start-navigation'
      )?.[1] as ((details: { isMainFrame: boolean; isSameDocument: boolean }) => void) | undefined;

      expect(reloadHandler).toBeDefined();
      reloadHandler?.({ isMainFrame: true, isSameDocument: false });
      await vi.waitFor(() => expect(pending.res.end).toHaveBeenCalled());
      expect(parseJsonResponse(pending.res)).toMatchObject({
        status: 'cancelled',
        applied: false,
      });
      expect(mockActionService.replaceAll).not.toHaveBeenCalled();

      const subsequent = await sendRequest('PUT', '/api/v1/settings/actions?scope=global', body, {
        'content-type': 'application/json',
      });
      expect(subsequent.res.writeHead).not.toHaveBeenCalledWith(409, expect.any(Object));
      const prompt = window.webContents.send.mock.calls
        .filter(([channel]) => channel === IPC.SETTINGS_APPROVAL_REQUESTED)
        .at(-1)?.[1] as { id: string };
      httpServerService.resolveSettingsApproval(prompt.id, 'cancel', window.webContents.id);
      await vi.waitFor(() => expect(subsequent.res.end).toHaveBeenCalled());
    });
  });

  afterEach(() => {
    httpServerService.stop();
    vi.useRealTimers();
  });

  // --------------------------------------------------------------------------
  // start / stop / getPort
  // --------------------------------------------------------------------------

  describe('Host header', () => {
    it('refuses web pages that point their own domain at this machine', async () => {
      httpServerService.start();

      const { res } = await sendRequest('POST', '/api/v1/commands', '{}', {
        'content-type': 'application/json',
        host: 'rebind.evil.example:52863',
      });

      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'text/plain' });
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        'Refused a request whose Host is not this machine',
        { host: 'rebind.evil.example:52863' }
      );
    });

    it.each(['127.0.0.1:52863', 'localhost:52863', '127.0.0.1:61234'])(
      'serves %s',
      async (host) => {
        httpServerService.start();

        const { res } = await sendRequest('GET', '/api/v1/health', undefined, { host });

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      }
    );

    it.each([
      ['/api/v1/notify', { origin: 'http://localhost:3000' }],
      ['/api/v1/notify', { 'sec-fetch-site': 'cross-site' }],
      ['/api/v1/ssh-workspace-status', { origin: 'null' }],
      // Same-origin, as through an SSH host's gateway, which rewrites Host.
      ['/api/v1/commands', { origin: 'http://127.0.0.1:52863', 'sec-fetch-site': 'same-origin' }],
    ])('refuses web pages posting to %s', async (path, headers) => {
      httpServerService.start();

      const { res } = await sendRequest(
        'POST',
        path,
        JSON.stringify({ cwd: '/projects/my-app', kind: 'idle' }),
        { 'content-type': 'text/plain', ...headers }
      );

      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'text/plain' });
      expect(mockWorkspaceService.attention.hook).not.toHaveBeenCalled();
    });
  });

  describe('Komla command transport', () => {
    it('requires a JSON content type for command requests', async () => {
      httpServerService.start();

      const { res } = await sendRequest(
        'POST',
        '/api/v1/commands',
        JSON.stringify({ type: 'context.get' }),
        { 'content-type': 'text/plain' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(415, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        ok: false,
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Komla command requests must use application/json.',
        },
      });
    });

    it('executes typed CLI operations independently of the MCP server', async () => {
      mockConfigService.get.mockReturnValue({ disableMcpServer: true });
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorkspace({
          id: 'workspace-1',
          workingDirectory: '/projects/komla',
          presetId: 'codex',
          launchModeId: 'plan',
        })
      );
      httpServerService.start();

      const { res } = await sendRequest(
        'POST',
        '/terminals/terminal-1/api/v1/commands',
        JSON.stringify({ type: 'context.get' }),
        { 'content-type': 'application/json' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        ok: true,
        result: {
          context: {
            connected: true,
            workspace: {
              id: 'workspace-1',
              path: '/projects/komla',
              environment: { kind: 'local' },
            },
            terminalId: 'terminal-1',
            agent: { presetId: 'codex', modeId: 'plan' },
          },
        },
      });
    });

    it('acts on the target workspace in place of the scoped terminal', async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorkspace({ id: 'workspace-1', workingDirectory: '/projects/komla' })
      );
      mockWorkspaceService.get.mockImplementation((id: string) =>
        id === 'workspace-2'
          ? createWorkspace({ id: 'workspace-2', workingDirectory: '/projects/other' })
          : undefined
      );
      httpServerService.start();

      const { res } = await sendRequest(
        'POST',
        '/terminals/terminal-1/api/v1/commands',
        JSON.stringify({ type: 'context.get' }),
        { 'content-type': 'application/json', 'x-komla-target-workspace-id': 'workspace-2' }
      );

      expect(parseJsonResponse(res)).toMatchObject({
        ok: true,
        result: { context: { workspace: { id: 'workspace-2', path: '/projects/other' } } },
      });
      expect(
        (parseJsonResponse(res) as { result: { context: object } }).result.context
      ).not.toHaveProperty('terminalId');
    });

    it('counts a command an SSH host queued from when the agent ran it', async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorkspace({ id: 'workspace-1', workingDirectory: '/projects/komla' })
      );
      mockWorkspaceService.update.mockImplementation((id: string, updates: object) => ({
        id,
        ...updates,
      }));
      httpServerService.start();
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = Date.now();

      // The host's clock may be off, so it says how long the command waited, not when.
      await sendRequest(
        'POST',
        '/terminals/terminal-1/api/v1/commands',
        JSON.stringify({ type: 'workspace.snooze', until: '2h' }),
        { 'content-type': 'application/json', 'x-komla-queued-ms': String(60 * 60 * 1000) }
      );
      vi.useRealTimers();

      expect(mockWorkspaceService.update).toHaveBeenCalledWith(
        'workspace-1',
        expect.objectContaining({ snoozedUntil: now + 60 * 60 * 1000 })
      );
    });

    it("adds a script's new tag to the list with its icon as an image, and refuses a bad look", async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorkspace({ id: 'workspace-1', workingDirectory: '/projects/komla' })
      );
      mockWorkspaceService.update.mockImplementation((id: string, updates: object) => ({
        id,
        ...updates,
      }));
      mockConfigService.get.mockReturnValue({ workspaceTags: [] });
      mockConfigService.update.mockImplementation((updates: object) => updates);
      httpServerService.start();
      const tag = (operation: object) =>
        sendRequest(
          'POST',
          '/terminals/terminal-1/api/v1/commands',
          JSON.stringify({ type: 'workspace.tag', tag: 'CI running', ...operation }),
          { 'content-type': 'application/json' }
        );

      const { res } = await tag({ icon: '<svg/>', spinner: true, tone: 'info' });
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(mockConfigService.update).toHaveBeenCalledWith({
        workspaceTags: [
          {
            name: 'CI running',
            tone: 'info',
            icon: `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`,
            spinner: true,
          },
        ],
      });
      expect(mockWindowService.broadcastToAll).toHaveBeenCalled();
      for (const operation of [{ tone: 'purple' }, { icon: 'logo.png' }, { tooltip: ' ' }]) {
        const { res } = await tag(operation);
        expect(res.writeHead, JSON.stringify(operation)).toHaveBeenCalledWith(400, {
          'Content-Type': 'application/json',
        });
      }
    });

    it('lists the tags without a workspace, and refuses options it has none of', async () => {
      mockConfigService.get.mockReturnValue({
        workspaceTags: [{ name: 'Blocked', tone: 'error' }],
      });
      httpServerService.start();
      const list = (operation: object) =>
        sendRequest(
          'POST',
          '/api/v1/commands',
          JSON.stringify({ type: 'tag.list', ...operation }),
          { 'content-type': 'application/json' }
        );

      const { res } = await list({});
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        ok: true,
        result: { tags: [{ name: 'Blocked', tone: 'error' }] },
      });
      const { res: refused } = await list({ includeTrashed: true });
      expect(refused.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
    });

    it('takes a snooze until notified with or without a time, but not one with neither', async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorkspace({ id: 'workspace-1', workingDirectory: '/projects/komla' })
      );
      mockWorkspaceService.update.mockImplementation((id: string, updates: object) => ({
        id,
        ...updates,
      }));
      httpServerService.start();
      const snooze = (operation: object) =>
        sendRequest(
          'POST',
          '/terminals/terminal-1/api/v1/commands',
          JSON.stringify({ type: 'workspace.snooze', ...operation }),
          { 'content-type': 'application/json' }
        );

      for (const operation of [{ untilNotified: true }, { until: '2h', untilNotified: true }]) {
        const { res } = await snooze(operation);
        expect(res.writeHead, JSON.stringify(operation)).toHaveBeenCalledWith(200, {
          'Content-Type': 'application/json',
        });
      }
      for (const operation of [{}, { untilNotified: false }]) {
        const { res } = await snooze(operation);
        expect(res.writeHead, JSON.stringify(operation)).toHaveBeenCalledWith(400, {
          'Content-Type': 'application/json',
        });
      }
    });

    it('takes a tag to set or none to take it off, but not an empty or overlong one', async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorkspace({ id: 'workspace-1', workingDirectory: '/projects/komla' })
      );
      mockWorkspaceService.update.mockImplementation((id: string, updates: object) => ({
        id,
        ...updates,
      }));
      httpServerService.start();
      const tag = (operation: object) =>
        sendRequest(
          'POST',
          '/terminals/terminal-1/api/v1/commands',
          JSON.stringify({ type: 'workspace.tag', ...operation }),
          { 'content-type': 'application/json' }
        );

      for (const operation of [{ tag: 'Waiting for review' }, {}]) {
        const { res } = await tag(operation);
        expect(res.writeHead, JSON.stringify(operation)).toHaveBeenCalledWith(200, {
          'Content-Type': 'application/json',
        });
      }
      for (const operation of [{ tag: '  ' }, { tag: 'x'.repeat(41) }]) {
        const { res } = await tag(operation);
        expect(res.writeHead, JSON.stringify(operation)).toHaveBeenCalledWith(400, {
          'Content-Type': 'application/json',
        });
      }
    });

    it('lists a virtual desktop from komla desktop run, given a valid VNC port and viewer', async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorkspace({ id: 'workspace-1', workingDirectory: '/projects/komla' })
      );
      mockWorkspaceService.update.mockReturnValue({ id: 'workspace-1' });
      httpServerService.start();
      const open = (
        vncPort: unknown,
        viewer?: unknown,
        url = 'http://127.0.0.1:6081/vnc.html?autoconnect=1'
      ) =>
        sendRequest(
          'POST',
          '/terminals/terminal-1/api/v1/commands',
          JSON.stringify({ type: 'desktop.open', vncPort, url, viewer }),
          { 'content-type': 'application/json' }
        );

      for (const rejected of [
        await open(70000),
        await open(5901, 'native'),
        await open(5901, undefined, 'javascript:alert(1)'),
      ]) {
        expect(rejected.res.writeHead).toHaveBeenCalledWith(400, {
          'Content-Type': 'application/json',
        });
      }

      const accepted = await open(5901);
      expect(accepted.res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
      expect(parseJsonResponse(accepted.res)).toEqual({
        ok: true,
        result: { desktop: { workspaceId: 'workspace-1' } },
      });
    });

    it('opens a virtual desktop in the VNC app this computer has for --app, with its password in the link', async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorkspace({ id: 'workspace-1', workingDirectory: '/projects/komla' })
      );
      electronMock.app.getApplicationNameForProtocol.mockReturnValueOnce('Screen Sharing');
      httpServerService.start();

      const { res } = await sendRequest(
        'POST',
        '/terminals/terminal-1/api/v1/commands',
        JSON.stringify({
          type: 'desktop.open',
          vncPort: 5901,
          vncPassword: 'pa55word',
          vncPorts: [5901, 5903],
          viewer: 'vnc-app',
        }),
        { 'content-type': 'application/json' }
      );

      expect(parseJsonResponse(res)).toEqual({
        ok: true,
        result: {
          desktop: { workspaceId: 'workspace-1', viewer: 'vnc-app', vncApp: 'Screen Sharing' },
        },
      });
      expect(electronMock.shell.openExternal).toHaveBeenCalledWith(
        'vnc://:pa55word@127.0.0.1:5901'
      );
    });

    it('only lists the virtual desktop an agent starts, as any other without a flag', async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorkspace({
          id: 'workspace-1',
          workingDirectory: '/projects/komla',
          terminals: [createTerminal({ id: 'terminal-1', agentActive: true })],
        })
      );
      mockWorkspaceService.update.mockReturnValue({ id: 'workspace-1' });
      electronMock.app.getApplicationNameForProtocol.mockReturnValueOnce('Screen Sharing');
      electronMock.shell.openExternal.mockClear();
      httpServerService.start();

      const { res } = await sendRequest(
        'POST',
        '/terminals/terminal-1/api/v1/commands',
        JSON.stringify({
          type: 'desktop.open',
          vncPort: 5901,
          url: 'http://127.0.0.1:6081/vnc.html?autoconnect=1',
          vncPassword: 'pa55word',
        }),
        { 'content-type': 'application/json' }
      );

      expect(parseJsonResponse(res)).toEqual({
        ok: true,
        result: { desktop: { workspaceId: 'workspace-1', vncApp: 'Screen Sharing' } },
      });
      expect(electronMock.shell.openExternal).not.toHaveBeenCalled();
    });

    it('accepts only a boolean fromCurrentBranch on agent launches', async () => {
      const project = createProject({ id: 'proj-1', name: 'Komla' });
      mockProjectService.get.mockReturnValue(project);
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorktreeWorkspace({
          id: 'workspace-1',
          projectId: 'proj-1',
          branchName: 'feature/search',
          workingDirectory: '/projects/komla',
        })
      );
      mockGitService.getCheckedOutBranch.mockResolvedValueOnce('feature/search');
      mockWorkspaceService.create.mockResolvedValue(createWorktreeWorkspace({ id: 'workspace-2' }));
      httpServerService.start();
      const launch = (fromCurrentBranch: unknown) =>
        sendRequest(
          'POST',
          '/terminals/terminal-1/api/v1/commands',
          JSON.stringify({ type: 'agent.launch', destination: 'workspace', fromCurrentBranch }),
          { 'content-type': 'application/json' }
        );

      const rejected = await launch('yes');
      expect(rejected.res.writeHead).toHaveBeenCalledWith(400, {
        'Content-Type': 'application/json',
      });
      expect(mockWorkspaceService.create).not.toHaveBeenCalled();

      const accepted = await launch(true);
      expect(accepted.res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'application/json',
      });
      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({ baseBranch: 'feature/search' })
      );
    });
  });

  describe('start and stop', () => {
    it('should create an HTTP server and listen on the default port', () => {
      httpServerService.start();

      expect(mockCreateServer).toHaveBeenCalledOnce();
      expect(mockServer.listen).toHaveBeenCalledWith(52863, '127.0.0.1', expect.any(Function));
    });

    it('should be idempotent — second start() is a no-op', () => {
      httpServerService.start();
      httpServerService.start();

      expect(mockCreateServer).toHaveBeenCalledOnce();
    });

    it('should use a custom port when provided', () => {
      httpServerService.start(9999);

      expect(mockServer.listen).toHaveBeenCalledWith(9999, '127.0.0.1', expect.any(Function));
      expect(httpServerService.getPort()).toBe(9999);
    });

    it('should set actualPort after successful listen', () => {
      httpServerService.start();

      expect(httpServerService.getPort()).toBe(52863);
    });

    it('should return preferredPort before listen completes', () => {
      // listen does NOT call its callback
      mockServer.listen.mockImplementation(() => {});

      httpServerService.start();

      // actualPort is null, so getPort falls back to preferredPort
      expect(httpServerService.getPort()).toBe(52863);
    });

    it('waits for the actual bound port', async () => {
      let finishListen: (() => void) | undefined;
      mockServer.listen.mockImplementation((_port: number, _host: string, callback: () => void) => {
        finishListen = callback;
      });

      httpServerService.start(9999);
      const actualPort = httpServerService.waitForActualPort();
      finishListen?.();

      await expect(actualPort).resolves.toBe(9999);
    });

    it('allows actual-port waits before the server starts', async () => {
      const actualPort = httpServerService.waitForActualPort();
      httpServerService.start(9999);

      await expect(actualPort).resolves.toBe(9999);
    });

    it('rejects actual-port waits when stopped before startup', async () => {
      const actualPort = httpServerService.waitForActualPort();
      httpServerService.stop();

      await expect(actualPort).rejects.toThrow('HTTP server stopped');
    });

    it('should close server and clear state on stop()', () => {
      httpServerService.start();
      httpServerService.stop();

      expect(mockServer.close).toHaveBeenCalledOnce();
      // After stop, getPort returns preferredPort (actualPort is null)
      expect(httpServerService.getPort()).toBe(52863);
    });

    it('should be safe to call stop() when not started', () => {
      expect(() => httpServerService.stop()).not.toThrow();
    });
  });

  // --------------------------------------------------------------------------
  // Port retry logic
  // --------------------------------------------------------------------------

  describe('port retry on EADDRINUSE', () => {
    let errorHandlers: ((error: { code: string }) => void)[];

    beforeEach(() => {
      errorHandlers = [];
      mockServer.once.mockImplementation((event: string, handler: unknown) => {
        if (event === 'error') errorHandlers.push(handler as (error: { code: string }) => void);
      });
    });

    it('should retry on the next port when EADDRINUSE occurs', () => {
      // listen does not call its callback (simulates port in use)
      mockServer.listen.mockImplementation(() => {});

      httpServerService.start();

      expect(mockServer.listen).toHaveBeenCalledWith(52863, '127.0.0.1', expect.any(Function));

      // Fire EADDRINUSE — triggers retry with attempt+1
      errorHandlers[0]({ code: 'EADDRINUSE' });

      expect(mockServer.listen).toHaveBeenCalledTimes(2);
      expect(mockServer.listen).toHaveBeenLastCalledWith(52864, '127.0.0.1', expect.any(Function));
    });

    it('should set actualPort to the fallback port on successful retry', () => {
      let listenCallCount = 0;
      mockServer.listen.mockImplementation((_port: number, _host: string, callback: () => void) => {
        listenCallCount++;
        // Only succeed on the second attempt
        if (listenCallCount === 2) callback();
      });

      httpServerService.start();
      errorHandlers[0]({ code: 'EADDRINUSE' });

      expect(httpServerService.getPort()).toBe(52864);
    });

    it("reports only the fallback port, though the busy port's listen callback runs too", async () => {
      // Node leaves a failed listen()'s callback on 'listening', so the fallback's success runs both.
      const callbacks: (() => void)[] = [];
      mockServer.listen.mockImplementation((_port: number, _host: string, callback: () => void) => {
        callbacks.push(callback);
        if (callbacks.length === 2) callbacks.forEach((listening) => listening());
      });
      const startedOn: number[] = [];
      httpServerService.onStarted(() => startedOn.push(httpServerService.getPort()));

      httpServerService.start();
      const actualPort = httpServerService.waitForActualPort();
      errorHandlers[0]({ code: 'EADDRINUSE' });

      await expect(actualPort).resolves.toBe(52864);
      expect(startedOn).toEqual([52864]);
      expect(process.env.KOMLA_API_URL).toBe('http://127.0.0.1:52864');
    });

    it('should stop retrying after maxPortRetries exceeded', () => {
      mockServer.listen.mockImplementation(() => {});

      httpServerService.start();

      // Fire 10 retries (which exhausts the limit)
      for (let i = 0; i < 10; i++) {
        errorHandlers[errorHandlers.length - 1]({ code: 'EADDRINUSE' });
      }

      // The 11th error handler fires EADDRINUSE but attempt >= maxRetries
      errorHandlers[errorHandlers.length - 1]({ code: 'EADDRINUSE' });

      // Should NOT have made another listen call (still 11)
      expect(mockServer.listen).toHaveBeenCalledTimes(11);
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Notification server error:',
        expect.any(Object)
      );
    });

    it('should not retry on other errors', () => {
      mockServer.listen.mockImplementation(() => {});

      httpServerService.start();
      errorHandlers[0]({ code: 'EADDRNOTAVAIL' });

      expect(mockServer.listen).toHaveBeenCalledOnce();
      expect(mockLoggerError).toHaveBeenCalledWith(
        'Notification server error:',
        expect.any(Object)
      );
    });

    it('rejects actual-port waits when binding ultimately fails', async () => {
      mockServer.listen.mockImplementation(() => {});
      const bindError = Object.assign(new Error('cannot bind'), { code: 'EADDRNOTAVAIL' });

      httpServerService.start();
      const actualPort = httpServerService.waitForActualPort();
      errorHandlers[0](bindError);

      await expect(actualPort).rejects.toBe(bindError);
      await expect(httpServerService.waitForActualPort()).rejects.toBe(bindError);
    });

    it('should persist fallback port and emit server:port-changed when prior config existed on disk', () => {
      mockConfigService.wasLoadedFromDisk.mockReturnValue(true);
      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      let listenCallCount = 0;
      mockServer.listen.mockImplementation((_port: number, _host: string, callback: () => void) => {
        listenCallCount++;
        // Only succeed on the second attempt (fallback port)
        if (listenCallCount === 2) callback();
      });

      httpServerService.start();
      // Fire EADDRINUSE to trigger retry on port 52864
      errorHandlers[0]({ code: 'EADDRINUSE' });

      expect(mockConfigService.update).toHaveBeenCalledWith({ notificationPort: 52864 });
      expect(win.webContents.send).toHaveBeenCalledWith('server:port-changed', {
        oldPort: 52863,
        newPort: 52864,
      });
    });

    it('should persist fallback port and suppress server:port-changed on first run (no config on disk)', () => {
      // First-run scenario: no config.json existed at load. The port we end up
      // on is just our initial assignment, not a deviation — so the banner
      // must NOT fire even though we fell back from the default.
      mockConfigService.wasLoadedFromDisk.mockReturnValue(false);
      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      let listenCallCount = 0;
      mockServer.listen.mockImplementation((_port: number, _host: string, callback: () => void) => {
        listenCallCount++;
        if (listenCallCount === 2) callback();
      });

      httpServerService.start();
      errorHandlers[0]({ code: 'EADDRINUSE' });

      // Sticky-port persistence still happens — boot 2 should remember 52864.
      expect(mockConfigService.update).toHaveBeenCalledWith({ notificationPort: 52864 });
      // But no banner event.
      expect(win.webContents.send).not.toHaveBeenCalledWith(
        'server:port-changed',
        expect.anything()
      );
      // And getPortChange() returns null so a late-mounting renderer doesn't
      // pick up a stale event either.
      expect(httpServerService.getPortChangeEvent()).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/v1/notify
  // --------------------------------------------------------------------------

  describe('POST /api/v1/notify', () => {
    const hook = mockWorkspaceService.attention.hook;

    beforeEach(() => {
      httpServerService.start();
    });

    it.each([
      ['turn-complete', 'Stop'],
      ['idle', 'Notification'],
    ])(
      'acknowledges a local synchronous %s hook while the module settles it',
      async (kind, hookEventName) => {
        const workspace = createWorkspace({
          id: 'ws-1',
          workingDirectory: '/projects/my-app',
          terminals: [createTerminal({ id: 'term-1' })],
        });
        mockWorkspaceService.list.mockReturnValue([workspace]);
        let settle!: (outcome: string) => void;
        hook.mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              settle = resolve;
            })
        );

        const { res } = await sendRequest(
          'POST',
          '/api/v1/notify',
          JSON.stringify({
            cwd: '/projects/my-app',
            terminalId: 'term-1',
            source: 'codex',
            kind,
            hookInput: { hook_event_name: hookEventName, session_id: 's', turn_id: 't' },
          })
        );

        // The agent must not wait out the settle, or it couldn't cancel its own completion.
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        expect(parseJsonResponse(res)).toEqual({ success: true });
        expect(hook).toHaveBeenCalledWith(
          expect.objectContaining({ workspace, terminalId: 'term-1', hasInvalidTerminalId: false }),
          expect.objectContaining({
            kind,
            source: 'codex',
            hookInput: expect.objectContaining({ hook_event_name: hookEventName }),
          })
        );
        expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();

        settle('taken');
        await vi.waitFor(() =>
          expect(mockWorkspaceService.persistSshAttention).toHaveBeenCalledWith('ws-1')
        );
      }
    );

    it('rejects invalid lifecycle identifiers before handing the hook to the module', async () => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          kind: 'activity',
          hookInput: { session_id: 42, turn_id: 'x'.repeat(129) },
        })
      );
      expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
      expect(hook).not.toHaveBeenCalled();
    });

    it('persists a hook the module took before acknowledging it', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      let settle!: (outcome: string) => void;
      hook.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            settle = resolve;
          })
      );
      let finishPersistence!: () => void;
      mockWorkspaceService.persistSshAttention.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPersistence = resolve;
          })
      );

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          message: 'Turn completed',
          kind: 'turn-complete',
          source: 'codex',
        })
      );

      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ workspace, hasInvalidTerminalId: false }),
        expect.objectContaining({
          kind: 'turn-complete',
          source: 'codex',
          message: 'Turn completed',
        })
      );
      expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();

      settle('taken');
      await vi.waitFor(() =>
        expect(mockWorkspaceService.persistSshAttention).toHaveBeenCalledWith('ws-1')
      );
      expect(res.end).not.toHaveBeenCalled();

      finishPersistence();
      await vi.waitFor(() =>
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
      );
      expect(parseJsonResponse(res)).toEqual({ success: true });
    });

    it("doesn't warn about a Terminal id when the hook matched no workspace", async () => {
      hook.mockResolvedValueOnce('unmatched');

      await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/some/path', terminalId: 'term-gone' })
      );

      expect(mockLoggerWarn).not.toHaveBeenCalledWith(
        'Notification terminalId was not found; falling back to workspaceId/cwd',
        expect.anything()
      );
    });

    it('should return 404 when no workspace matches', async () => {
      hook.mockResolvedValueOnce('unmatched');

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/some/path' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        error: 'No matching workspace found',
        cwd: '/some/path',
      });
      expect(hook).toHaveBeenCalledWith(
        expect.not.objectContaining({ workspace: expect.anything() }),
        expect.objectContaining({ cwd: '/some/path' })
      );
      expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();
    });

    it('answers a retried remote completion as pending until the module settles it', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
        terminals: [createTerminal({ id: 'term-1' })],
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      let settle!: (outcome: string) => void;
      hook.mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            settle = resolve;
          })
      );
      const completion = JSON.stringify({
        cwd: '/projects/my-app',
        terminalId: 'term-1',
        source: 'codex',
        deliveryId: 'completion-1',
        kind: 'turn-complete',
        hookInput: { hook_event_name: 'Stop', session_id: 'root', turn_id: 'turn-1' },
      });
      const headers = { 'x-komla-hook-pending': 'retry' };
      const first = await sendRequest('POST', '/api/v1/notify', completion, headers);
      await vi.waitFor(() =>
        expect(first.res.writeHead).toHaveBeenCalledWith(202, expect.any(Object))
      );
      expect(parseJsonResponse(first.res)).toEqual({ pending: true });
      const retry = await sendRequest('POST', '/api/v1/notify', completion, headers);
      await vi.waitFor(() =>
        expect(retry.res.writeHead).toHaveBeenCalledWith(202, expect.any(Object))
      );
      // The retry shares the first delivery's acceptance.
      expect(hook).toHaveBeenCalledTimes(1);
      expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();

      settle('taken');
      await vi.waitFor(() =>
        expect(mockWorkspaceService.persistSshAttention).toHaveBeenCalledWith('ws-1', {
          terminalId: 'term-1',
          deliveryId: 'completion-1',
        })
      );
      mockWorkspaceService.hasAcceptedTerminalHook.mockReturnValue(true);
      const accepted = await sendRequest('POST', '/api/v1/notify', completion, headers);
      await vi.waitFor(() =>
        expect(accepted.res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      );
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it('keeps remote completion pending until attention is persisted', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
        terminals: [createTerminal({ id: 'term-1' })],
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      let finishPersistence!: () => void;
      mockWorkspaceService.persistSshAttention.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPersistence = resolve;
          })
      );
      const body = JSON.stringify({
        cwd: '/projects/my-app',
        terminalId: 'term-1',
        source: 'codex',
        deliveryId: 'completion-1',
        kind: 'turn-complete',
        hookInput: { hook_event_name: 'Stop', session_id: 'root' },
      });
      const headers = { 'x-komla-hook-pending': 'retry' };
      const first = await sendRequest('POST', '/api/v1/notify', body, headers);
      await vi.waitFor(() =>
        expect(first.res.writeHead).toHaveBeenCalledWith(202, expect.any(Object))
      );
      await vi.waitFor(() =>
        expect(mockWorkspaceService.persistSshAttention).toHaveBeenCalledWith('ws-1', {
          terminalId: 'term-1',
          deliveryId: 'completion-1',
        })
      );
      const retry = await sendRequest('POST', '/api/v1/notify', body, headers);
      await vi.waitFor(() =>
        expect(retry.res.writeHead).toHaveBeenCalledWith(202, expect.any(Object))
      );
      expect(mockWorkspaceService.persistSshAttention).toHaveBeenCalledTimes(1);
      mockWorkspaceService.hasAcceptedTerminalHook.mockReturnValue(true);
      finishPersistence();
      const accepted = await sendRequest('POST', '/api/v1/notify', body, headers);
      await vi.waitFor(() =>
        expect(accepted.res.writeHead).toHaveBeenCalledWith(200, expect.any(Object))
      );
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it.each([
      { delivery: 'remote', deliveryId: 'request-1', status: 202 },
      { delivery: 'local', deliveryId: undefined, status: 200 },
    ])(
      'answers a $delivery permission request without waiting for its reply',
      async ({ deliveryId, status }) => {
        const workspace = createWorkspace({
          id: 'ws-1',
          workingDirectory: '/projects/my-app',
          terminals: [createTerminal({ id: 'term-1' })],
        });
        mockWorkspaceService.list.mockReturnValue([workspace]);
        hook.mockImplementationOnce(() => new Promise<string>(() => {}));
        const request = JSON.stringify({
          cwd: '/projects/my-app',
          terminalId: 'term-1',
          source: 'opencode',
          deliveryId,
          kind: 'input-required',
          hookInput: { hook_event_name: 'PermissionRequest', permissionID: 'per_1' },
        });

        const { res } = await sendRequest('POST', '/api/v1/notify', request, {
          'x-komla-hook-pending': 'retry',
        });

        await vi.waitFor(() =>
          expect(res.writeHead).toHaveBeenCalledWith(status, expect.any(Object))
        );
      }
    );

    it('acknowledges a retried terminal hook without handing it to the module again', async () => {
      const terminal = createTerminal({ id: 'term-1' });
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
        terminals: [terminal],
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
      mockWorkspaceService.hasAcceptedTerminalHook.mockReturnValue(true);

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          terminalId: 'term-1',
          deliveryId: 'delivery-1',
          kind: 'input-required',
          source: 'codex',
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(mockWorkspaceService.hasAcceptedTerminalHook).toHaveBeenCalledWith(
        'term-1',
        'delivery-1'
      );
      expect(hook).not.toHaveBeenCalled();
      expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();
    });

    it('makes a concurrent terminal-hook retry await the same durable acceptance', async () => {
      const terminal = createTerminal({ id: 'term-1' });
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
        terminals: [terminal],
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
      let finishPersistence!: () => void;
      mockWorkspaceService.persistSshAttention.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishPersistence = resolve;
          })
      );
      const body = JSON.stringify({
        cwd: '/projects/my-app',
        terminalId: 'term-1',
        deliveryId: 'delivery-1',
        kind: 'input-required',
        source: 'codex',
      });

      const first = await sendRequest('POST', '/api/v1/notify', body);
      const retry = await sendRequest('POST', '/api/v1/notify', body);

      expect(hook).toHaveBeenCalledTimes(1);
      expect(mockWorkspaceService.persistSshAttention).toHaveBeenCalledTimes(1);
      expect(retry.res.end).not.toHaveBeenCalled();

      finishPersistence();
      await vi.waitFor(() => expect(first.res.end).toHaveBeenCalled());
      await vi.waitFor(() => expect(retry.res.end).toHaveBeenCalled());
      expect(parseJsonResponse(first.res)).toEqual({ success: true });
      expect(parseJsonResponse(retry.res)).toEqual({ success: true });
    });

    it('should return 400 for invalid JSON', async () => {
      const { res } = await sendRequest('POST', '/api/v1/notify', 'not json');

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({ error: 'Invalid JSON' });
    });

    it('should return 400 when cwd is missing', async () => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ kind: 'turn-complete' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; details: { path: string }[] };
      expect(body.error).toBe('Invalid payload');
      expect(body.details.some((d) => d.path === 'cwd')).toBe(true);
    });

    it('should return 400 when cwd is an empty string', async () => {
      const { res } = await sendRequest('POST', '/api/v1/notify', JSON.stringify({ cwd: '' }));

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string };
      expect(body.error).toBe('Invalid payload');
    });

    it('should return 400 when kind is not in the allowed enum', async () => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/projects/my-app', kind: 'pwn' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; details: { path: string }[] };
      expect(body.error).toBe('Invalid payload');
      expect(body.details.some((d) => d.path === 'kind')).toBe(true);
    });

    it('passes custom source labels and presentation to the module verbatim', async () => {
      const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
      mockWorkspaceService.list.mockReturnValue([workspace]);

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          kind: 'turn-complete',
          source: 'my-agent',
          title: 'Review ready',
          body: 'Authentication changes are waiting.',
          color: 'oklch(62% 0.2 285)',
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      // Custom labels must reach the module verbatim, not get silently coerced to 'generic'.
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ workspace }),
        expect.objectContaining({
          source: 'my-agent',
          title: 'Review ready',
          body: 'Authentication changes are waiting.',
          color: 'oklch(62% 0.2 285)',
        })
      );
    });

    it('passes a badge and an icon, the icon as a data URL', async () => {
      const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      const svg = "<svg xmlns='http://www.w3.org/2000/svg'/>";

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          title: 'CI failed on main',
          badge: 'CI',
          icon: svg,
          iconColor: 'foreground',
          color: 'error',
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ workspace }),
        expect.objectContaining({
          badge: 'CI',
          icon: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
          iconColor: 'foreground',
          color: 'error',
        })
      );
    });

    it.each([
      ['icon', { icon: 'javascript:alert(1)' }],
      ['iconColor', { icon: '<svg/>', iconColor: 'red; background: url(x)' }],
      ['badge', { badge: 'b'.repeat(65) }],
    ])('returns 400 for an invalid notification %s', async (field, presentation) => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/projects/my-app', title: 'Done', ...presentation })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { details: { path: string }[] };
      expect(body.details.some((d) => d.path === field)).toBe(true);
    });

    it('returns 404 when the module leaves a matched hook unmatched', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
        terminals: [createTerminal({ id: 'term-1' })],
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      // e.g. its Terminal closed while the hook settled.
      hook.mockResolvedValueOnce('unmatched');

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          terminalId: 'term-1',
          kind: 'input-required',
          source: 'claude-code',
        })
      );

      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ workspace, terminalId: 'term-1' }),
        expect.any(Object)
      );
      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        error: 'No matching workspace found',
        cwd: '/projects/my-app',
      });
      expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();
    });

    describe('hooks that end a turn without a Stop', () => {
      const terminalWorkspace = () => {
        const workspace = createWorkspace({
          id: 'ws-1',
          workingDirectory: '/projects/my-app',
          terminals: [createTerminal({ id: 'term-1' })],
        });
        mockWorkspaceService.list.mockReturnValue([workspace]);
        mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
      };
      const notify = (fields: Record<string, unknown>) =>
        sendRequest(
          'POST',
          '/api/v1/notify',
          JSON.stringify({ cwd: '/projects/my-app', terminalId: 'term-1', ...fields })
        );

      it('takes an interrupt that Codex reports from its Interrupt hook', async () => {
        terminalWorkspace();

        const { res } = await notify({
          source: 'codex',
          kind: 'interrupted',
          hookInput: { hook_event_name: 'Interrupt', session_id: 's', turn_id: 't1' },
        });

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        expect(hook).toHaveBeenCalledWith(
          expect.objectContaining({ terminalId: 'term-1' }),
          expect.objectContaining({ kind: 'interrupted', source: 'codex' })
        );
      });

      // An SSH host keeps the komla CLI of the device that prepared it last.
    });

    describe('copies of hooks for a terminal another device is attached to', () => {
      const sshWorkspace = (terminals: ReturnType<typeof createTerminal>[]) =>
        createWorkspace({
          id: 'ws-1',
          workingDirectory: 'ssh://ssh-dev/home/dev/repo',
          terminals,
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/repo',
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'git@example/repo.git',
            branchName: 'feature',
            baseBranch: 'main',
          },
        });

      const copied = (hook: Record<string, unknown>) =>
        sendRequest(
          'POST',
          '/api/v1/notify',
          JSON.stringify({ cwd: '/home/dev/repo', source: 'claude-code', copy: true, ...hook }),
          { 'x-komla-ssh-host-id': 'ssh-dev' }
        );

      it("records a copied hook's delivery without persisting the workspace", async () => {
        const workspace = sshWorkspace([createTerminal({ id: 'term-1' })]);
        mockWorkspaceService.list.mockReturnValue([workspace]);
        mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
        mockWorkspaceService.get.mockReturnValue(workspace);

        const { res } = await copied({
          terminalId: 'term-1',
          kind: 'prompt-submit',
          hookInput: { prompt: 'Fix the build' },
        });

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        expect(hook).toHaveBeenCalledWith(
          expect.objectContaining({ workspace, terminalId: 'term-1' }),
          expect.objectContaining({ kind: 'prompt-submit', copy: true })
        );
        // Copies only change what's shown, so each one doesn't rewrite the workspace file.
        expect(mockWorkspaceService.recordCopiedHookDelivery).toHaveBeenCalledWith(
          'ws-1',
          undefined
        );
        expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();
      });

      it('acknowledges a relayed interrupt without recording its delivery', async () => {
        const workspace = sshWorkspace([createTerminal({ id: 'term-1' })]);
        mockWorkspaceService.list.mockReturnValue([workspace]);
        mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
        mockWorkspaceService.get.mockReturnValue(workspace);
        hook.mockResolvedValueOnce('ignored');

        const { res } = await copied({ terminalId: 'term-1', kind: 'interrupted' });

        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        expect(parseJsonResponse(res)).toEqual({ success: true });
        expect(hook).toHaveBeenCalledWith(
          expect.objectContaining({ workspace, terminalId: 'term-1' }),
          expect.objectContaining({ kind: 'interrupted', copy: true })
        );
        expect(mockWorkspaceService.recordCopiedHookDelivery).not.toHaveBeenCalled();
        expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();
      });

      it.each([undefined, 'PostToolUse'])(
        'accepts an interrupt only from an interrupt hook or as a copy from another device, not from %s',
        async (hookEventName) => {
          const { res } = await sendRequest(
            'POST',
            '/api/v1/notify',
            JSON.stringify({
              cwd: '/home/dev/repo',
              terminalId: 'term-1',
              kind: 'interrupted',
              ...(hookEventName ? { hookInput: { hook_event_name: hookEventName } } : {}),
            })
          );

          expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
        }
      );

      it('rejects a copy flag that is not a boolean', async () => {
        const { res } = await copied({ terminalId: 'term-1', kind: 'turn-complete', copy: 'true' });

        expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      });

      it('drops a copy for a terminal this device does not have', async () => {
        const workspace = sshWorkspace([]);
        mockWorkspaceService.list.mockReturnValue([workspace]);
        mockWorkspaceService.get.mockReturnValue(workspace);

        const { res } = await copied({ terminalId: 'term-elsewhere', kind: 'turn-complete' });

        expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
        expect(parseJsonResponse(res)).toEqual({ error: 'No matching terminal found' });
        expect(hook).not.toHaveBeenCalled();
      });

      it('checks the host for a workspace started there when it has no such terminal here', async () => {
        const workspace = sshWorkspace([]);
        mockWorkspaceService.list.mockReturnValue([workspace]);
        mockWorkspaceService.get.mockReturnValue(workspace);

        await copied({ terminalId: 'term-elsewhere', kind: 'prompt-submit' });
        await copied({ terminalId: 'term-elsewhere', kind: 'turn-complete' });

        // Once per terminal: its host syncs again by itself in case the workspace came later.
        expect(mockWorkspaceService.sshSync.expectWorkspace.mock.calls).toEqual([['ssh-dev']]);
      });

      it('does not check the host for a hook whose terminal it has', async () => {
        const workspace = sshWorkspace([createTerminal({ id: 'term-1' })]);
        mockWorkspaceService.list.mockReturnValue([workspace]);
        mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
        mockWorkspaceService.get.mockReturnValue(workspace);

        await copied({ terminalId: 'term-1', kind: 'prompt-submit' });

        expect(mockWorkspaceService.sshSync.expectWorkspace).not.toHaveBeenCalled();
      });

      it('drops a copied subagent hook for a terminal this device does not have', async () => {
        const workspace = sshWorkspace([]);
        mockWorkspaceService.list.mockReturnValue([workspace]);
        mockWorkspaceService.get.mockReturnValue(workspace);

        const { res } = await copied({
          terminalId: 'term-elsewhere',
          kind: 'turn-complete',
          hookInput: { hook_event_name: 'SubagentStop', agent_id: 'agent-1' },
        });

        expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
        expect(parseJsonResponse(res)).toEqual({ error: 'No matching terminal found' });
        expect(hook).not.toHaveBeenCalled();
      });
    });

    it('rejects ignored Claude subagent hooks scoped to a different SSH host', async () => {
      const terminal = createTerminal({ id: 'term-b' });
      const workspace = createWorkspace({
        id: 'ws-b',
        workingDirectory: 'ssh://ssh-b/home/dev/repo',
        terminals: [terminal],
        backend: {
          kind: 'ssh',
          hostId: 'ssh-b',
          remoteDirectory: '/home/dev/repo',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'git@example/repo.git',
          branchName: 'feature',
          baseBranch: 'main',
        },
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
      mockWorkspaceService.get.mockReturnValue(workspace);
      hook.mockResolvedValueOnce('unmatched');

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/home/dev/repo',
          workspaceId: 'ws-b',
          terminalId: 'term-b',
          kind: 'turn-complete',
          source: 'claude-code',
          hookInput: {
            hook_event_name: 'SubagentStop',
            agent_id: 'agent-abc123',
          },
        }),
        { 'x-komla-ssh-host-id': 'ssh-a' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        error: 'No matching workspace found',
        cwd: '/home/dev/repo',
      });
      expect(hook).not.toHaveBeenCalledWith(
        expect.objectContaining({ workspace: expect.anything() }),
        expect.anything()
      );
    });

    it('acknowledges a hook the module ignores without making it durable', async () => {
      const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      hook.mockResolvedValueOnce('ignored');

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          kind: 'input-required',
          source: 'claude-code',
          message: 'Background agent needs input',
          hookInput: {
            notification_type: 'agent_needs_input',
          },
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({ success: true });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ workspace }),
        expect.objectContaining({
          hookInput: expect.objectContaining({ notification_type: 'agent_needs_input' }),
        })
      );
      expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();
      expect(mockWorkspaceService.recordCopiedHookDelivery).not.toHaveBeenCalled();
    });

    it('routes by workspaceId and terminalId before falling back to cwd', async () => {
      const terminal1 = createTerminal({ id: 'term-1' });
      const terminal2 = createTerminal({ id: 'term-2' });
      const workspace1 = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared',
        terminals: [terminal1],
      });
      const workspace2 = createWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared',
        terminals: [terminal2],
      });
      mockWorkspaceService.list.mockReturnValue([workspace1, workspace2]);
      mockWorkspaceService.findWorkspaceByTerminalId.mockImplementation((id: string) =>
        id === 'term-1' ? workspace1 : id === 'term-2' ? workspace2 : undefined
      );
      mockWorkspaceService.get.mockImplementation((id: string) =>
        id === 'ws-1' ? workspace1 : id === 'ws-2' ? workspace2 : undefined
      );

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          workspaceId: 'ws-2',
          terminalId: 'term-2',
          cwd: '/projects/shared',
          kind: 'turn-complete',
          source: 'codex',
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace: workspace2,
          terminalId: 'term-2',
          hasInvalidTerminalId: false,
        }),
        expect.objectContaining({ kind: 'turn-complete', source: 'codex' })
      );
    });

    it.each([
      ['terminal ID', { terminalId: 'term-b' }],
      ['workspace ID', { workspaceId: 'ws-b' }],
      ['cwd', {}],
    ])('scopes notification resolution by forwarded SSH host for %s', async (_, identity) => {
      const terminal = createTerminal({ id: 'term-b' });
      const workspace = createWorkspace({
        id: 'ws-b',
        workingDirectory: 'ssh://ssh-b/home/dev/repo',
        terminals: [terminal],
        backend: {
          kind: 'ssh',
          hostId: 'ssh-b',
          remoteDirectory: '/home/dev/repo',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'git@example/repo.git',
          branchName: 'feature',
          baseBranch: 'main',
        },
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace);
      mockWorkspaceService.get.mockReturnValue(workspace);
      hook.mockResolvedValueOnce('unmatched');

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          ...identity,
          cwd: '/home/dev/repo',
          kind: 'turn-complete',
          source: 'codex',
        }),
        { 'x-komla-ssh-host-id': 'ssh-a' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(hook).not.toHaveBeenCalledWith(
        expect.objectContaining({ workspace: expect.anything() }),
        expect.anything()
      );
    });

    it('routes cwd-only notifications to the only running duplicate cwd match', async () => {
      const workspace1 = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const workspace2 = createDirectoryWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared',
        terminals: [createTerminal({ status: 'running' })],
      });
      mockWorkspaceService.list.mockReturnValue([workspace1, workspace2]);

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/shared/src',
          kind: 'turn-complete',
          source: 'codex',
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace: workspace2,
          terminalId: undefined,
          hasInvalidTerminalId: false,
        }),
        expect.objectContaining({ source: 'codex' })
      );
    });

    it('rejects cwd-only notifications when duplicate cwd matches are not obvious', async () => {
      const workspace1 = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const workspace2 = createDirectoryWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      mockWorkspaceService.list.mockReturnValue([workspace1, workspace2]);
      hook.mockResolvedValueOnce('unmatched');

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/shared/src',
          kind: 'turn-complete',
          source: 'codex',
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        error: 'No matching workspace found',
        cwd: '/projects/shared/src',
      });
      expect(hook).not.toHaveBeenCalledWith(
        expect.objectContaining({ workspace: expect.anything() }),
        expect.anything()
      );
    });

    it('lets terminalId choose the workspace when workspaceId is stale', async () => {
      const terminal1 = createTerminal({ id: 'term-1' });
      const terminal2 = createTerminal({ id: 'term-2' });
      const workspace1 = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared',
        terminals: [terminal1],
      });
      const workspace2 = createWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared',
        terminals: [terminal2],
      });
      mockWorkspaceService.list.mockReturnValue([workspace1, workspace2]);
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(workspace2);
      mockWorkspaceService.get.mockImplementation((id: string) =>
        id === 'ws-1' ? workspace1 : id === 'ws-2' ? workspace2 : undefined
      );

      await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          workspaceId: 'ws-1',
          terminalId: 'term-2',
          cwd: '/projects/shared',
          kind: 'input-required',
          source: 'codex',
        })
      );

      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: workspace2, terminalId: 'term-2' }),
        expect.objectContaining({ kind: 'input-required' })
      );
    });

    it('drops stale terminalId before handing the hook to the module', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
        terminals: [createTerminal({ id: 'term-1' })],
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          terminalId: 'stale-term',
          kind: 'input-required',
          source: 'claude-code',
          message: 'Needs approval',
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ workspace, terminalId: undefined, hasInvalidTerminalId: true }),
        expect.objectContaining({ kind: 'input-required', message: 'Needs approval' })
      );
    });

    it('should return 400 when source exceeds the length cap', async () => {
      const oversized = 'x'.repeat(65);
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/projects/my-app', source: oversized })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; details: { path: string }[] };
      expect(body.error).toBe('Invalid payload');
      expect(body.details.some((d) => d.path === 'source')).toBe(true);
    });

    it('should return 400 when message exceeds the size cap', async () => {
      const oversized = 'x'.repeat(64 * 1024 + 1);
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/projects/my-app', message: oversized })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; details: { path: string }[] };
      expect(body.error).toBe('Invalid payload');
      expect(body.details.some((d) => d.path === 'message')).toBe(true);
    });

    it('should return 400 when a custom color exceeds the size cap', async () => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          title: 'Review ready',
          color: 'x'.repeat(257),
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; details: { path: string }[] };
      expect(body.error).toBe('Invalid payload');
      expect(body.details.some((d) => d.path === 'color')).toBe(true);
    });

    it('should return 400 when a custom title is blank', async () => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/projects/my-app', title: '   ' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; details: { path: string }[] };
      expect(body.error).toBe('Invalid payload');
      expect(body.details.some((d) => d.path === 'title')).toBe(true);
    });

    it('should strip unknown extra fields without rejecting', async () => {
      const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
      mockWorkspaceService.list.mockReturnValue([workspace]);

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({
          cwd: '/projects/my-app',
          kind: 'turn-complete',
          source: 'codex',
          // Codex hooks pass through a `type` field that we ignore.
          type: 'agent-turn-complete',
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ workspace }),
        expect.not.objectContaining({ type: expect.anything() })
      );
    });

    it('should return 500 when the module fails to handle the hook (not 400)', async () => {
      // Regression: a SyntaxError raised while handling the hook must not be misclassified as
      // a malformed request body.
      const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      hook.mockRejectedValueOnce(new SyntaxError('boom'));

      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/projects/my-app', kind: 'turn-complete' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
      // Generic body — internal exception text is logged but not echoed to
      // unauthenticated callers.
      expect(parseJsonResponse(res)).toEqual({ error: 'Failed to handle notification' });
    });
  });

  // --------------------------------------------------------------------------
  // GET /skills/:file — serves skill instruction files over loopback
  // --------------------------------------------------------------------------

  describe('GET /skills/:file', () => {
    beforeEach(() => {
      httpServerService.start();
    });

    it('serves an existing instruction file as markdown', async () => {
      mockReadFileSync.mockReturnValue('# Instructions');

      const { res } = await sendRequest('GET', '/skills/komla-onboarding-demo-instructions.md');

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
      });
      expect(res.end).toHaveBeenCalledWith('# Instructions');
    });

    it('serves instructions through a terminal-scoped URL', async () => {
      mockReadFileSync.mockReturnValue('# Scoped instructions');

      const { res } = await sendRequest(
        'GET',
        '/terminals/terminal-1/skills/komla-project-setup-instructions.md'
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
      });
      expect(res.end).toHaveBeenCalledWith('# Scoped instructions');
      expect(mockReadFileSync).toHaveBeenCalledWith(
        join('/mock/home/.komla/skills/komla-project-setup-instructions.md'),
        'utf-8'
      );
    });

    it('serves the same project setup instructions to an SSH terminal', async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorktreeWorkspace({
          id: 'workspace-1',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/project/feature',
            remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/project',
            gitUrl: 'git@example.com:project.git',
          },
        })
      );
      mockReadFileSync.mockReturnValue('# Environment-independent instructions');

      const { res } = await sendRequest(
        'GET',
        '/terminals/terminal-1/skills/komla-project-setup-instructions.md'
      );

      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
      expect(mockReadFileSync).toHaveBeenCalledWith(
        join('/mock/home/.komla/skills/komla-project-setup-instructions.md'),
        'utf-8'
      );
      expect(res.end).toHaveBeenCalledWith('# Environment-independent instructions');
    });

    it('serves the same self-integration instructions to an SSH terminal', async () => {
      mockWorkspaceService.findWorkspaceByTerminalId.mockReturnValue(
        createWorktreeWorkspace({
          id: 'workspace-1',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/.komla/worktrees/project/feature',
            remoteRepoPath: '/home/dev/.komla/repos/project/repo.git',
            remoteProjectRoot: '/home/dev/.komla/worktrees/project',
            gitUrl: 'git@example.com:project.git',
          },
        })
      );
      mockReadFileSync.mockReturnValue('# Integration instructions');

      const { res } = await sendRequest(
        'GET',
        '/terminals/terminal-1/skills/komla-self-integration-instructions.md'
      );

      expect(mockReadFileSync).toHaveBeenCalledWith(
        join('/mock/home/.komla/skills/komla-self-integration-instructions.md'),
        'utf-8'
      );
      expect(res.end).toHaveBeenCalledWith('# Integration instructions');
    });

    it('serves the Komla skill for `komla skill komla`', async () => {
      mockReadFileSync.mockReturnValue('---\nname: komla\n---');

      const { res } = await sendRequest('GET', '/skills/komla.md');

      expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
      expect(mockReadFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/[/\\]skills[/\\]komla[/\\]SKILL\.md$/),
        'utf-8'
      );
      expect(res.end).toHaveBeenCalledWith('---\nname: komla\n---');
    });

    it('rejects a path-traversal attempt without touching the filesystem', async () => {
      const { res } = await sendRequest('GET', '/skills/..%2f..%2fconfig.json');

      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it('returns 404 for malformed percent-encoding instead of throwing', async () => {
      const { res } = await sendRequest('GET', '/skills/%E0%A4%A.md');

      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it('rejects a non-markdown filename', async () => {
      const { res } = await sendRequest('GET', '/skills/secrets.json');

      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });

    it('returns 404 when the file does not exist', async () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const { res } = await sendRequest('GET', '/skills/missing.md');

      expect(res.writeHead).toHaveBeenCalledWith(404);
    });
  });

  // --------------------------------------------------------------------------
  // GET /validate-settings
  // --------------------------------------------------------------------------

  describe('GET /validate-settings', () => {
    const projectsJsonPath = join('/mock/home/.komla/settings/projects.json');
    const actionsJsonPath = join('/mock/home/.komla/settings/actions.json');

    beforeEach(() => {
      httpServerService.start();
    });

    it('returns ok when projects.json and actions.json are valid', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) {
          return JSON.stringify({
            _version: 1,
            projects: [
              {
                id: 'project-1',
                name: 'Project',
                repositoryPath: '/repo/project',
                defaultBranchPrefix: '',
                createdAt: 1234567890,
                order: 0,
                managed: false,
              },
            ],
          });
        }
        if (path === actionsJsonPath) {
          return JSON.stringify({
            _version: 1,
            actions: [
              {
                id: 'action-1',
                title: 'Action',
                content: '# Prompt',
                type: 'prompt',
              },
            ],
          });
        }
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('GET', '/validate-settings');

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        ok: true,
        files: {
          projects: { ok: true, count: 1 },
          actions: { ok: true, count: 1 },
        },
      });
    });

    it('reports parse errors without exposing file contents', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) return '{';
        if (path === actionsJsonPath) return JSON.stringify({ actions: [] });
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('GET', '/validate-settings');
      const body = parseJsonResponse(res) as {
        ok: boolean;
        files: { projects: { ok: boolean; error: string }; actions: { ok: boolean } };
      };

      expect(res.writeHead).toHaveBeenCalledWith(422, { 'Content-Type': 'application/json' });
      expect(body.ok).toBe(false);
      expect(body.files.projects.ok).toBe(false);
      expect(body.files.projects.error).toContain('JSON');
      expect(body.files.actions).toEqual({ ok: true, count: 0 });
    });

    it('accepts but warns about a leading UTF-8 BOM', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) return '\ufeff{"projects":[]}';
        if (path === actionsJsonPath) return JSON.stringify({ actions: [] });
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('POST', '/validate-settings');
      const body = parseJsonResponse(res) as {
        ok: boolean;
        files: { projects: { ok: boolean; warning?: string } };
      };

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(body.ok).toBe(true);
      expect(body.files.projects).toMatchObject({
        ok: true,
        warning: expect.stringContaining('UTF-8 BOM'),
      });
    });

    it('reports schema-compatible errors for invalid entries', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) {
          return JSON.stringify({ projects: [{ id: 'missing-required-fields' }] });
        }
        if (path === actionsJsonPath) return JSON.stringify({ actions: [] });
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('GET', '/validate-settings');
      const body = parseJsonResponse(res) as {
        files: { projects: { ok: boolean; error: string } };
      };

      expect(res.writeHead).toHaveBeenCalledWith(422, { 'Content-Type': 'application/json' });
      expect(body.files.projects.ok).toBe(false);
      expect(body.files.projects.error).toBe(
        'projects.json has an invalid project entry at index 0'
      );
    });

    it('rejects project entries with malformed optional setup fields', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) {
          return JSON.stringify({
            projects: [
              {
                id: 'project-1',
                name: 'Project',
                repositoryPath: '/repo/project',
                defaultBranchPrefix: '',
                createdAt: 1234567890,
                order: 0,
                managed: false,
                setupSteps: {},
              },
            ],
          });
        }
        if (path === actionsJsonPath) return JSON.stringify({ actions: [] });
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('GET', '/validate-settings');
      const body = parseJsonResponse(res) as {
        files: { projects: { ok: boolean; error: string } };
      };

      expect(res.writeHead).toHaveBeenCalledWith(422, { 'Content-Type': 'application/json' });
      expect(body.files.projects.ok).toBe(false);
      expect(body.files.projects.error).toBe(
        'projects.json has an invalid project entry at index 0'
      );
    });

    it('rejects setup steps with an array-shaped agent target', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) {
          return JSON.stringify({
            projects: [
              {
                id: 'project-1',
                name: 'Project',
                repositoryPath: '/repo/project',
                defaultBranchPrefix: '',
                createdAt: 1234567890,
                order: 0,
                managed: false,
                setupSteps: [
                  {
                    id: 'step-1',
                    name: 'Agent',
                    command: '',
                    placement: 'tab',
                    agent: [],
                  },
                ],
              },
            ],
          });
        }
        if (path === actionsJsonPath) return JSON.stringify({ actions: [] });
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('GET', '/validate-settings');
      const body = parseJsonResponse(res) as {
        files: { projects: { ok: boolean; error: string } };
      };

      expect(res.writeHead).toHaveBeenCalledWith(422, { 'Content-Type': 'application/json' });
      expect(body.files.projects.ok).toBe(false);
      expect(body.files.projects.error).toBe(
        'projects.json has an invalid project entry at index 0'
      );
    });

    it('rejects project entries with duplicate ids', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) {
          return JSON.stringify({
            projects: [
              {
                id: 'project-1',
                name: 'Project',
                repositoryPath: '/repo/project',
                defaultBranchPrefix: '',
                createdAt: 1234567890,
                order: 0,
                managed: false,
              },
              {
                id: 'project-1',
                name: 'Duplicate Project',
                repositoryPath: '/repo/duplicate',
                defaultBranchPrefix: '',
                createdAt: 1234567891,
                order: 1,
                managed: false,
              },
            ],
          });
        }
        if (path === actionsJsonPath) return JSON.stringify({ actions: [] });
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('GET', '/validate-settings');
      const body = parseJsonResponse(res) as {
        files: { projects: { ok: boolean; error: string } };
      };

      expect(res.writeHead).toHaveBeenCalledWith(422, { 'Content-Type': 'application/json' });
      expect(body.files.projects.ok).toBe(false);
      expect(body.files.projects.error).toBe('projects.json has a duplicate project id at index 1');
    });

    it('rejects action entries with malformed optional fields', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) return JSON.stringify({ projects: [] });
        if (path === actionsJsonPath) {
          return JSON.stringify({
            actions: [
              {
                id: 'action-1',
                title: 'Action',
                content: '# Prompt',
                type: 'prompt',
                projectIds: 'project-1',
              },
            ],
          });
        }
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('GET', '/validate-settings');
      const body = parseJsonResponse(res) as {
        files: { actions: { ok: boolean; error: string } };
      };

      expect(res.writeHead).toHaveBeenCalledWith(422, { 'Content-Type': 'application/json' });
      expect(body.files.actions.ok).toBe(false);
      expect(body.files.actions.error).toBe('actions.json has an invalid action entry at index 0');
    });

    it('rejects action entries with duplicate ids', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) return JSON.stringify({ projects: [] });
        if (path === actionsJsonPath) {
          return JSON.stringify({
            actions: [
              {
                id: 'action-1',
                title: 'Action',
                content: '# Prompt',
                type: 'prompt',
              },
              {
                id: 'action-1',
                title: 'Duplicate Action',
                content: '# Duplicate Prompt',
                type: 'prompt',
              },
            ],
          });
        }
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('GET', '/validate-settings');
      const body = parseJsonResponse(res) as {
        files: { actions: { ok: boolean; error: string } };
      };

      expect(res.writeHead).toHaveBeenCalledWith(422, { 'Content-Type': 'application/json' });
      expect(body.files.actions.ok).toBe(false);
      expect(body.files.actions.error).toBe('actions.json has a duplicate action id at index 1');
    });

    it('accepts action entries with nullable lastUsedAt', async () => {
      mockReadFileSync.mockImplementation((path: string) => {
        if (path === projectsJsonPath) return JSON.stringify({ projects: [] });
        if (path === actionsJsonPath) {
          return JSON.stringify({
            actions: [
              {
                id: 'action-1',
                title: 'Action',
                content: '# Prompt',
                type: 'prompt',
                lastUsedAt: null,
              },
            ],
          });
        }
        throw new Error('Unexpected file');
      });

      const { res } = await sendRequest('GET', '/validate-settings');

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        ok: true,
        files: {
          projects: { ok: true, count: 0 },
          actions: { ok: true, count: 1 },
        },
      });
    });
  });

  describe('POST /api/v1/ssh-workspace-status', () => {
    beforeEach(() => {
      httpServerService.start();
    });

    it('rejects status payloads without a Remote Companion envelope', async () => {
      const statusText = ' M src/app.ts\n?? notes.txt';
      const numstatText = '3\t1\tsrc/app.ts';

      const { res } = await sendRequest(
        'POST',
        '/api/v1/ssh-workspace-status',
        JSON.stringify({
          workspaceId: 'ws-ssh',
          cwd: '/home/dev/.komla/worktrees/app/branch',
          currentBranch: 'feature/remote',
          targetBranch: 'main',
          statusB64: Buffer.from(statusText).toString('base64'),
          numstatB64: Buffer.from(numstatText).toString('base64'),
          statusTooLarge: false,
          aheadTargetBranch: 2,
          behindTargetBranch: 1,
          unpushedCommits: 2,
          behindRemote: 0,
          hasRemote: true,
          hasOriginRemote: true,
          targetBranchHasRemote: true,
          targetBranchAheadRemote: 0,
          targetBranchBehindRemote: 3,
        }),
        { 'x-komla-ssh-host-id': 'ssh-dev' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      expect(mockWorkspaceStatusService.change).not.toHaveBeenCalled();
    });

    it('accepts a latest-value companion snapshot without a receipt body', async () => {
      const statusText = ' M src/app.ts\0';
      const numstatText = '3\t1\tsrc/app.ts\0';
      const { res } = await sendRequest(
        'POST',
        '/api/v1/ssh-workspace-status',
        JSON.stringify({
          protocolVersion: 1,
          kind: 'repository-snapshot',
          workspaceId: 'ws-ssh',
          cwd: '/home/dev/worktree',
          sequence: 7,
          observedAt: 1_700_000_000_000,
          stateHash: 'state-7',
          workingTreeChanged: false,
          fileListHash: 'file-list-7',
          changedPaths: ['src/app.ts'],
          statusB64: Buffer.from(statusText).toString('base64'),
          numstatB64: Buffer.from(numstatText).toString('base64'),
          currentBranch: 'feature/remote',
          targetBranch: 'release',
          defaultBranch: 'main',
          aheadTargetBranch: 2,
        }),
        { 'x-komla-ssh-host-id': 'ssh-dev' }
      );

      expect(mockWorkspaceStatusService.change).toHaveBeenCalledWith({
        kind: 'snapshot-observed',
        snapshot: expect.objectContaining({
          workspaceId: 'ws-ssh',
          source: { kind: 'remote-companion', sequence: 7 },
          observedAt: 1_700_000_000_000,
          stateHash: 'state-7',
          workingTreeChanged: false,
          fileListHash: 'file-list-7',
          changedPaths: ['src/app.ts'],
          statusB64: Buffer.from(statusText).toString('base64'),
          numstatB64: Buffer.from(numstatText).toString('base64'),
          branch: expect.objectContaining({ targetBranch: 'release', defaultBranch: 'main' }),
        }),
      });
      expect(res.writeHead).toHaveBeenCalledWith(204);
    });

    it.each(['false', 0, null, {}])(
      'rejects invalid workingTreeChanged: %j',
      async (workingTreeChanged) => {
        const { res } = await sendRequest(
          'POST',
          '/api/v1/ssh-workspace-status',
          JSON.stringify({
            protocolVersion: 1,
            kind: 'repository-snapshot',
            workspaceId: 'ws-ssh',
            cwd: '/home/dev/worktree',
            sequence: 1,
            observedAt: 1,
            stateHash: 'state-1',
            workingTreeChanged,
          })
        );
        expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
        expect(mockWorkspaceStatusService.change).not.toHaveBeenCalled();
      }
    );

    it('rejects more changed paths than the Remote Companion sends', async () => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/ssh-workspace-status',
        JSON.stringify({
          protocolVersion: 1,
          kind: 'repository-snapshot',
          workspaceId: 'ws-ssh',
          cwd: '/home/dev/worktree',
          sequence: 1,
          observedAt: 1,
          stateHash: 'state-1',
          changedPaths: Array.from({ length: 501 }, (_, index) => `file-${index}.ts`),
        })
      );
      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      expect(mockWorkspaceStatusService.change).not.toHaveBeenCalled();
    });

    it('returns 404 when no SSH workspace matches', async () => {
      mockWorkspaceStatusService.change.mockResolvedValue({
        disposition: 'rejected',
        workspaceId: 'ws-missing',
        code: 'workspace-not-found',
      });

      const { res } = await sendRequest(
        'POST',
        '/api/v1/ssh-workspace-status',
        JSON.stringify({
          protocolVersion: 1,
          kind: 'repository-snapshot',
          workspaceId: 'ws-missing',
          cwd: '/home/dev/missing',
          sequence: 1,
          observedAt: 1_700_000_000_000,
          stateHash: 'state-1',
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        error: 'No matching SSH workspace found',
        cwd: '/home/dev/missing',
      });
    });

    it('forwards an incomplete snapshot for Workspace Status retention policy', async () => {
      await sendRequest(
        'POST',
        '/api/v1/ssh-workspace-status',
        JSON.stringify({
          protocolVersion: 1,
          kind: 'repository-snapshot',
          workspaceId: 'ws-ssh',
          cwd: '/home/dev/worktree',
          sequence: 8,
          observedAt: 1_700_000_001_000,
          stateHash: 'state-8',
          statusB64: '',
          numstatB64: '',
          statusTooLarge: true,
        })
      );

      expect(mockWorkspaceStatusService.change).toHaveBeenCalledWith({
        kind: 'snapshot-observed',
        snapshot: expect.objectContaining({
          workspaceId: 'ws-ssh',
          statusTooLarge: true,
          statusB64: '',
          numstatB64: '',
        }),
      });
    });

    it('accepts SSH status fields larger than the notification message limit', async () => {
      const statusText = ` M ${'nested/'.repeat(10_000)}file.ts\0`;
      const { res } = await sendRequest(
        'POST',
        '/api/v1/ssh-workspace-status',
        JSON.stringify({
          protocolVersion: 1,
          kind: 'repository-snapshot',
          workspaceId: 'ws-ssh',
          cwd: '/home/dev/worktree',
          sequence: 9,
          observedAt: 1_700_000_002_000,
          stateHash: 'state-9',
          statusB64: Buffer.from(statusText).toString('base64'),
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(204);
      expect(mockWorkspaceStatusService.change).toHaveBeenCalledOnce();
    });

    it('accepts SSH snapshots larger than the general API body limit', async () => {
      const statusText = `?? ${'a'.repeat(1_100_000)}\0`;
      const { res } = await sendRequest(
        'POST',
        '/api/v1/ssh-workspace-status',
        JSON.stringify({
          protocolVersion: 1,
          kind: 'repository-snapshot',
          workspaceId: 'ws-ssh',
          cwd: '/home/dev/worktree',
          sequence: 10,
          observedAt: 1_700_000_003_000,
          stateHash: 'state-10',
          statusB64: Buffer.from(statusText).toString('base64'),
        })
      );

      expect(res.writeHead).toHaveBeenCalledWith(204);
      expect(mockWorkspaceStatusService.change).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------------------------
  // Notify route — which workspace a hook lands on, and its durable save
  // --------------------------------------------------------------------------

  describe('notification handling', () => {
    beforeEach(() => {
      httpServerService.start();
    });

    function expectHookOn(workspace: unknown, payload: Record<string, unknown>): void {
      expect(mockWorkspaceService.attention.hook).toHaveBeenCalledWith(
        expect.objectContaining({ workspace, terminalId: undefined, hasInvalidTerminalId: false }),
        expect.objectContaining(payload)
      );
    }

    function expectNoMatch(res: ReturnType<typeof createMockResponse>, cwd: string): void {
      expect(mockWorkspaceService.attention.hook).not.toHaveBeenCalledWith(
        expect.objectContaining({ workspace: expect.anything() }),
        expect.anything()
      );
      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({ error: 'No matching workspace found', cwd });
    }

    describe('exact path match', () => {
      const sshWorkspace = () =>
        createWorkspace({
          id: 'ws-ssh',
          workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
          backend: {
            kind: 'ssh',
            hostId: 'ssh-dev',
            remoteDirectory: '/home/dev/worktree',
            remoteRepoPath: '/home/dev/repo.git',
            remoteProjectRoot: '/home/dev',
            gitUrl: 'git@example.test:repo.git',
            projectName: 'Repo',
            branchName: 'feature',
          },
        });

      it('acknowledges an SSH hook only after attention persistence succeeds', async () => {
        const workspace = sshWorkspace();
        mockWorkspaceService.list.mockReturnValue([workspace]);
        let settle!: (outcome: string) => void;
        mockWorkspaceService.attention.hook.mockImplementationOnce(
          () => new Promise<string>((resolve) => (settle = resolve))
        );
        mockWorkspaceService.persistSshAttention.mockRejectedValueOnce(new Error('disk full'));

        const { res } = await sendRequest(
          'POST',
          '/api/v1/notify',
          JSON.stringify({ cwd: '/home/dev/worktree', kind: 'input-required' })
        );

        expectHookOn(workspace, { cwd: '/home/dev/worktree', kind: 'input-required' });
        expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();
        expect(res.writeHead).not.toHaveBeenCalled();

        settle('taken');
        await vi.waitFor(() => expect(res.writeHead).toHaveBeenCalled());
        expect(mockWorkspaceService.persistSshAttention).toHaveBeenCalledWith('ws-ssh');
        expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
        expect(parseJsonResponse(res)).toEqual({ error: 'Failed to handle notification' });
      });

      it('does not request an SSH snapshot after accepting an agent notification', async () => {
        const workspace = sshWorkspace();
        mockWorkspaceService.list.mockReturnValue([workspace]);

        const { res } = await sendRequest(
          'POST',
          '/api/v1/notify',
          JSON.stringify({ cwd: '/home/dev/worktree', kind: 'turn-complete' })
        );

        expectHookOn(workspace, { cwd: '/home/dev/worktree', kind: 'turn-complete' });
        expect(mockWorkspaceService.persistSshAttention).toHaveBeenCalledWith('ws-ssh');
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        expect(mockWorkspaceStatusService.change).not.toHaveBeenCalled();
      });

      it('lands a hook on the workspace whose directory is its cwd', async () => {
        const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
        mockWorkspaceService.list.mockReturnValue([workspace]);

        const { res } = await sendRequest(
          'POST',
          '/api/v1/notify',
          JSON.stringify({ cwd: '/projects/my-app' })
        );

        expectHookOn(workspace, { cwd: '/projects/my-app' });
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
        expect(parseJsonResponse(res)).toEqual({ success: true });
      });

      it('should match when cwd is a subdirectory of workspace directory', async () => {
        const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
        mockWorkspaceService.list.mockReturnValue([workspace]);

        const { res } = await sendRequest(
          'POST',
          '/api/v1/notify',
          JSON.stringify({ cwd: '/projects/my-app/src/components' })
        );

        expectHookOn(workspace, { cwd: '/projects/my-app/src/components' });
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      });
    });

    describe('worktree path match (Strategy 2)', () => {
      it.each([
        {
          name: 'should match by project name and safe branch name',
          // Worktree path: ~/.komla/worktrees/{projectName}/{safeBranchName}
          workspace: { id: 'ws-wt', branchName: 'agent/feature', repoName: 'my-project' },
          cwd: '/mock/home/.komla/worktrees/my-project/agent-feature',
        },
        {
          name: 'should handle branch names with multiple slashes',
          workspace: { id: 'ws-multi', branchName: 'agent/nested/branch', repoName: 'my-project' },
          cwd: '/mock/home/.komla/worktrees/my-project/agent-nested-branch',
        },
        {
          name: 'should match equivalent realpaths when cwd uses a symlinked temp path',
          workspace: {
            id: 'ws-symlink',
            branchName: 'codex/keen-cloud',
            repoName: 'komla',
            workingDirectory: '/tmp/komla-dev/worktrees/komla/codex-keen-cloud',
          },
          cwd: '/private/tmp/komla-dev/worktrees/komla/codex-keen-cloud',
        },
        {
          // Workspaces created before project-segment sanitization have raw repoNames like
          // "My Cool Project", but new worktrees on disk sit at the sanitized "My-Cool-Project".
          name: 'should match a legacy repoName with spaces against the sanitized path segment',
          workspace: { id: 'ws-legacy', branchName: 'agent/feature', repoName: 'My Cool Project' },
          cwd: '/mock/home/.komla/worktrees/My-Cool-Project/agent-feature',
        },
      ])('$name', async ({ workspace: overrides, cwd }) => {
        const workspace = createWorktreeWorkspace({
          workingDirectory: '/other/path',
          ...overrides,
        });
        mockWorkspaceService.list.mockReturnValue([workspace]);

        const { res } = await sendRequest('POST', '/api/v1/notify', JSON.stringify({ cwd }));

        expectHookOn(workspace, { cwd });
        expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      });

      it.each([
        {
          name: 'should not match when project name differs',
          workspace: createWorktreeWorkspace({
            id: 'ws-wt',
            branchName: 'agent/feature',
            repoName: 'my-project',
            workingDirectory: '/other/path',
          }),
          cwd: '/mock/home/.komla/worktrees/other-project/agent-feature',
        },
        {
          name: 'should not match non-worktree workspaces',
          workspace: createWorkspace({
            id: 'ws-dir',
            isWorktree: false,
            branchName: 'agent/feature',
            repoName: 'my-project',
            workingDirectory: '/other/path',
          }),
          cwd: '/mock/home/.komla/worktrees/my-project/agent-feature',
        },
        {
          name: 'should not match workspaces without branchName',
          workspace: createWorktreeWorkspace({
            id: 'ws-nb',
            branchName: undefined,
            repoName: 'my-project',
            workingDirectory: '/other/path',
          }),
          cwd: '/mock/home/.komla/worktrees/my-project/agent-feature',
        },
      ])('$name', async ({ workspace, cwd }) => {
        mockWorkspaceService.list.mockReturnValue([workspace]);
        mockWorkspaceService.attention.hook.mockResolvedValue('unmatched');

        const { res } = await sendRequest('POST', '/api/v1/notify', JSON.stringify({ cwd }));

        expectNoMatch(res, cwd);
      });
    });

    describe('no match', () => {
      beforeEach(() => {
        mockWorkspaceService.attention.hook.mockResolvedValue('unmatched');
      });

      it('should return 404 when no workspace matches the cwd', async () => {
        mockWorkspaceService.list.mockReturnValue([
          createWorkspace({ workingDirectory: '/projects/other' }),
        ]);

        const { res } = await sendRequest(
          'POST',
          '/api/v1/notify',
          JSON.stringify({ cwd: '/projects/unknown' })
        );

        expectNoMatch(res, '/projects/unknown');
      });

      it('returns 404 for a hook Terminal Attention State found unmatched', async () => {
        const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
        mockWorkspaceService.list.mockReturnValue([workspace]);

        const { res } = await sendRequest(
          'POST',
          '/api/v1/notify',
          JSON.stringify({ cwd: '/projects/my-app', kind: 'turn-complete' })
        );

        expectHookOn(workspace, { cwd: '/projects/my-app', kind: 'turn-complete' });
        expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
        expect(mockWorkspaceService.persistSshAttention).not.toHaveBeenCalled();
      });
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/workspace
  // --------------------------------------------------------------------------

  describe('POST /api/workspace', () => {
    const project = createProject({ id: 'proj-1', name: 'My Project' });

    beforeEach(() => {
      httpServerService.start();
      mockProjectService.list.mockReturnValue([project]);
    });

    it('rejects requests that arrive through an SSH host tunnel', async () => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/workspace',
        JSON.stringify({ project: 'My Project', initialPrompt: 'Run this' }),
        { 'content-type': 'application/json', 'x-komla-ssh-host-id': 'ssh-dev' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(403, { 'Content-Type': 'application/json' });
      expect(mockWorkspaceService.create).not.toHaveBeenCalled();
    });

    it('refuses rather than starting elsewhere while the pinned SSH host is not set up', async () => {
      mockConfigService.get.mockReturnValue({ agentLaunchDefaultSshHostId: 'box' });
      mockSshHostService.list.mockReturnValue([{ id: 'box', name: 'Box' }]);
      mockSshHostService.isReady.mockReturnValue(false);

      const { res } = await sendJsonRequest(
        'POST',
        '/api/v1/workspace',
        JSON.stringify({ project: 'My Project' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(409, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toMatchObject({
        error:
          "Agents start new workspaces on Box, which isn't set up yet. Finish setting it up, or change Where agents start in Settings → Integrations & MCP.",
      });
      expect(mockWorkspaceService.create).not.toHaveBeenCalled();
    });

    it('says so when the pinned SSH host is no longer in Komla', async () => {
      mockConfigService.get.mockReturnValue({ agentLaunchDefaultSshHostId: 'gone' });
      mockSshHostService.isReady.mockReturnValue(false);

      const { res } = await sendJsonRequest(
        'POST',
        '/api/v1/workspace',
        JSON.stringify({ project: 'My Project' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(409, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toMatchObject({
        error:
          "Agents start new workspaces on an SSH host that isn't in Komla any more. Change Where agents start in Settings → Integrations & MCP.",
      });
    });

    it('starts a launch from a cwd several workspaces share where New Workspace would', async () => {
      mockProjectService.get.mockReturnValue(project);
      mockWorkspaceService.list.mockReturnValue([
        createWorktreeWorkspace({ id: 'ws-a', projectId: 'proj-1', workingDirectory: '/repos/a' }),
        createWorktreeWorkspace({ id: 'ws-b', projectId: 'proj-1', workingDirectory: '/repos/a' }),
      ]);

      await sendJsonRequest('POST', '/api/v1/workspace', JSON.stringify({ cwd: '/repos/a' }));

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1' })
      );
      expect(mockWorkspaceService.create.mock.calls[0][0]).not.toHaveProperty('environment');
    });

    // Not wherever New Workspace last started one, which may be an SSH host.
    it('starts a project named from outside every workspace on this computer', async () => {
      await sendJsonRequest('POST', '/api/v1/workspace', JSON.stringify({ project: 'My Project' }));

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1', environment: { kind: 'local' } })
      );
    });

    it('requires a JSON request body', async () => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/workspace',
        JSON.stringify({ project: 'My Project' }),
        { 'content-type': 'text/plain' }
      );

      expect(res.writeHead).toHaveBeenCalledWith(415, { 'Content-Type': 'application/json' });
      expect(mockWorkspaceService.create).not.toHaveBeenCalled();
    });

    it('should create workspace and return 200 with details', async () => {
      const workspace = createWorktreeWorkspace({
        id: 'ws-new',
        name: 'new-workspace',
        branchName: 'agent/feature',
        workingDirectory: '/mock/worktree',
      });
      mockWorkspaceService.create.mockResolvedValue(workspace);
      mockWorkspaceService.get.mockReturnValue(workspace);

      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ project: 'My Project' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as {
        success: boolean;
        workspace: Record<string, unknown>;
      };
      expect(body.success).toBe(true);
      expect(body.workspace).toEqual({
        id: 'ws-new',
        name: 'new-workspace',
        branchName: 'agent/feature',
        workingDirectory: '/mock/worktree',
        provisioning: false,
      });
    });

    it('should find project case-insensitively', async () => {
      const workspace = createWorktreeWorkspace();
      mockWorkspaceService.create.mockResolvedValue(workspace);

      await sendJsonRequest('POST', '/api/workspace', JSON.stringify({ project: 'my project' }));

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1' })
      );
    });

    it('should create workspace in the same window as the workspace matching cwd', async () => {
      const sourceWorkspace = createWorktreeWorkspace({
        id: 'ws-source',
        projectId: 'proj-1',
        workingDirectory: '/mock/source-worktree',
        windowId: 'window-2',
      });
      const workspace = createWorktreeWorkspace();
      mockWorkspaceService.list.mockReturnValue([sourceWorkspace]);
      mockProjectService.get.mockReturnValue(project);
      mockWorkspaceService.create.mockResolvedValue(workspace);

      await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ cwd: '/mock/source-worktree/src' })
      );

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1', windowId: 'window-2' })
      );
    });

    it('should preserve project metadata when creating from an SSH workspace cwd', async () => {
      const sourceWorkspace = createWorktreeWorkspace({
        id: 'ws-source',
        projectId: 'proj-1',
        workingDirectory: '/home/dev/.komla/worktrees/my-project/agent-source',
        windowId: 'window-2',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-host-1',
          remoteDirectory: '/home/dev/.komla/worktrees/my-project/agent-source',
          remoteRepoPath: '/home/dev/.komla/repos/my-project.git',
          remoteProjectRoot: '/home/dev/.komla/worktrees/my-project',
          gitUrl: 'git@github.com:example/my-project.git',
        },
      });
      const workspace = createWorktreeWorkspace();
      mockWorkspaceService.list.mockReturnValue([sourceWorkspace]);
      mockProjectService.get.mockReturnValue(project);
      mockWorkspaceService.create.mockResolvedValue(workspace);

      await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ cwd: '/home/dev/.komla/worktrees/my-project/agent-source/src' })
      );

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          windowId: 'window-2',
          location: {
            kind: 'ssh',
            hostId: 'ssh-host-1',
            gitUrl: 'git@github.com:example/my-project.git',
            sourceBackend: sourceWorkspace.backend,
          },
        })
      );
    });

    it('reuses exact SSH backend roots when creating from a URL-only workspace cwd', async () => {
      const sourceWorkspace = createWorktreeWorkspace({
        id: 'ws-source',
        projectId: null,
        workingDirectory: '/srv/custom/worktrees/source',
        windowId: 'window-2',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-host-1',
          remoteDirectory: '/srv/custom/worktrees/source',
          remoteRepoPath: '/srv/custom/repos/exact-repo.git',
          remoteProjectRoot: '/srv/custom/worktrees',
          gitUrl: 'git@github.com:example/my-project.git',
          projectName: 'Original Project',
        },
      });
      mockWorkspaceService.list.mockReturnValue([sourceWorkspace]);
      mockWorkspaceService.create.mockResolvedValue(createWorktreeWorkspace());

      await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ cwd: '/srv/custom/worktrees/source/src', branchName: 'agent/sibling' })
      );

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'worktree',
          branchName: 'agent/sibling',
          windowId: 'window-2',
          location: {
            kind: 'ssh',
            hostId: 'ssh-host-1',
            gitUrl: 'git@github.com:example/my-project.git',
            sourceBackend: sourceWorkspace.backend,
          },
        })
      );
    });

    it('should create workspace from the only running duplicate cwd match', async () => {
      const directoryProject = createProject({
        id: 'dir-proj',
        name: 'Directory Project',
        kind: 'directory',
        repositoryPath: '/projects/shared',
      });
      const stoppedWorkspace = createDirectoryWorkspace({
        id: 'ws-stopped',
        projectId: 'old-proj',
        workingDirectory: '/projects/shared',
        windowId: 'window-1',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const runningWorkspace = createDirectoryWorkspace({
        id: 'ws-running',
        projectId: 'dir-proj',
        workingDirectory: '/projects/shared',
        windowId: 'window-2',
        terminals: [createTerminal({ status: 'running' })],
      });
      const workspace = createDirectoryWorkspace();
      mockWorkspaceService.list.mockReturnValue([stoppedWorkspace, runningWorkspace]);
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'dir-proj' ? directoryProject : undefined
      );
      mockWorkspaceService.create.mockResolvedValue(workspace);

      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ cwd: '/projects/shared/src' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'directory',
          projectId: 'dir-proj',
          windowId: 'window-2',
        })
      );
    });

    it('should create workspace when duplicate running cwd matches share one project', async () => {
      const directoryProject = createProject({
        id: 'dir-proj',
        name: 'Directory Project',
        kind: 'directory',
        repositoryPath: '/projects/shared',
      });
      const workspace1 = createDirectoryWorkspace({
        id: 'ws-1',
        projectId: 'dir-proj',
        workingDirectory: '/projects/shared',
        windowId: 'window-1',
        terminals: [createTerminal({ status: 'running' })],
      });
      const workspace2 = createDirectoryWorkspace({
        id: 'ws-2',
        projectId: 'dir-proj',
        workingDirectory: '/projects/shared',
        windowId: 'window-2',
        terminals: [createTerminal({ status: 'running' })],
      });
      const workspace = createDirectoryWorkspace();
      mockWorkspaceService.list.mockReturnValue([workspace1, workspace2]);
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'dir-proj' ? directoryProject : undefined
      );
      mockWorkspaceService.create.mockResolvedValue(workspace);

      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ cwd: '/projects/shared/src' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'directory',
          projectId: 'dir-proj',
          windowId: 'main-window-id',
        })
      );
    });

    it('should reject cwd workspace creation when duplicate matches imply different projects', async () => {
      const projectOne = createProject({
        id: 'dir-proj-1',
        name: 'Directory Project 1',
        kind: 'directory',
        repositoryPath: '/projects/shared',
      });
      const projectTwo = createProject({
        id: 'dir-proj-2',
        name: 'Directory Project 2',
        kind: 'directory',
        repositoryPath: '/projects/shared',
      });
      const workspace1 = createDirectoryWorkspace({
        id: 'ws-1',
        projectId: 'dir-proj-1',
        workingDirectory: '/projects/shared',
        terminals: [createTerminal({ status: 'running' })],
      });
      const workspace2 = createDirectoryWorkspace({
        id: 'ws-2',
        projectId: 'dir-proj-2',
        workingDirectory: '/projects/shared',
        terminals: [createTerminal({ status: 'running' })],
      });
      mockWorkspaceService.list.mockReturnValue([workspace1, workspace2]);
      mockProjectService.get.mockImplementation((id: string) =>
        id === 'dir-proj-1' ? projectOne : id === 'dir-proj-2' ? projectTwo : undefined
      );

      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ cwd: '/projects/shared/src' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(409, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        error:
          'Multiple projects match cwd: /projects/shared/src. This workspace creation request cannot safely choose a project. Name the project with --project.',
        availableProjects: ['My Project'],
      });
      expect(mockWorkspaceService.create).not.toHaveBeenCalled();
    });

    it('should return 400 when project field is missing', async () => {
      const { res } = await sendJsonRequest('POST', '/api/workspace', JSON.stringify({}));

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({
        error:
          'This is not a Komla workspace, so name the project with --project. Projects: My Project.',
        availableProjects: ['My Project'],
      });
    });

    it('should return 400 when project is empty string (schema rejection)', async () => {
      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ project: '' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; details: unknown[] };
      expect(body.error).toBe('Invalid payload');
      expect(body.details.length).toBeGreaterThan(0);
    });

    it('should return 404 when project is not found', async () => {
      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ project: 'Nonexistent' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(404, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; availableProjects: string[] };
      expect(body.error).toContain('not found');
      expect(body.availableProjects).toEqual(['My Project']);
    });

    it('should return 500 with a generic body when workspaceService.create throws', async () => {
      // Detail is logged server-side, never echoed to unauthenticated callers.
      mockWorkspaceService.create.mockRejectedValue(new Error('Disk full'));

      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ project: 'My Project' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({ error: 'Failed to create workspace' });
    });

    it('should return 500 with a generic body for non-Error throws', async () => {
      mockWorkspaceService.create.mockRejectedValue('string error');

      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ project: 'My Project' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({ error: 'Failed to create workspace' });
    });

    it('should pass branchName, name, and initialPrompt through', async () => {
      const workspace = createWorktreeWorkspace();
      mockWorkspaceService.create.mockResolvedValue(workspace);

      await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({
          project: 'My Project',
          branchName: 'feat-x',
          name: 'My Workspace',
          initialPrompt: 'fix the bug',
        })
      );

      expect(mockWorkspaceService.create).toHaveBeenCalledWith({
        mode: 'worktree',
        projectId: 'proj-1',
        branchName: 'feat-x',
        customName: 'My Workspace',
        customDescription: undefined,
        initialPrompt: 'fix the bug',
        windowId: 'main-window-id',
        presetId: undefined,
        launchModeId: undefined,
        environment: { kind: 'local' },
        skipRecordUsage: true,
        deferBranchNaming: true,
      });
    });

    it('should use directory mode for directory projects', async () => {
      const directoryProject = createProject({
        id: 'dir-proj',
        name: 'Directory Project',
        kind: 'directory',
        repositoryPath: '/plain/folder',
      });
      const workspace = createDirectoryWorkspace({
        id: 'dir-ws',
        name: 'Directory Workspace',
        projectId: 'dir-proj',
        workingDirectory: '/plain/folder',
      });
      mockProjectService.list.mockReturnValue([project, directoryProject]);
      mockWorkspaceService.create.mockResolvedValue(workspace);

      await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({
          project: 'Directory Project',
          branchName: 'ignored-branch',
          name: 'Directory Workspace',
          initialPrompt: 'work in this folder',
        })
      );

      expect(mockWorkspaceService.create).toHaveBeenCalledWith({
        mode: 'directory',
        projectId: 'dir-proj',
        branchName: undefined,
        deferBranchNaming: true,
        customName: 'Directory Workspace',
        customDescription: undefined,
        initialPrompt: 'work in this folder',
        windowId: 'main-window-id',
        presetId: undefined,
        launchModeId: undefined,
        environment: { kind: 'local' },
        skipRecordUsage: true,
      });
    });

    it('should queue workspace:created notifications until each renderer is ready', async () => {
      const workspace = createWorktreeWorkspace();
      mockWorkspaceService.create.mockResolvedValue(workspace);
      mockWindowService.getAllWindowIds.mockReturnValue(['main-window-id', 'window-2']);

      await sendJsonRequest('POST', '/api/workspace', JSON.stringify({ project: 'My Project' }));

      expect(mockWindowService.sendWhenReady).toHaveBeenCalledWith(
        'main-window-id',
        IPC.WORKSPACE_CREATED,
        workspace
      );
      expect(mockWindowService.sendWhenReady).toHaveBeenCalledWith(
        'window-2',
        IPC.WORKSPACE_CREATED,
        workspace
      );
    });

    it('should return 400 for invalid JSON body', async () => {
      const { res } = await sendJsonRequest('POST', '/api/workspace', 'not json');

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({ error: 'Invalid JSON' });
    });

    it('should return 400 when branchName has the wrong type', async () => {
      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ project: 'My Project', branchName: 12345 })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; details: { path: string }[] };
      expect(body.error).toBe('Invalid payload');
      expect(body.details.some((d) => d.path === 'branchName')).toBe(true);
    });

    it('should return 400 when initialPrompt exceeds the size cap', async () => {
      const oversized = 'x'.repeat(64 * 1024 + 1);
      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ project: 'My Project', initialPrompt: oversized })
      );

      expect(res.writeHead).toHaveBeenCalledWith(400, { 'Content-Type': 'application/json' });
      const body = parseJsonResponse(res) as { error: string; details: { path: string }[] };
      expect(body.error).toBe('Invalid payload');
      expect(body.details.some((d) => d.path === 'initialPrompt')).toBe(true);
    });

    it('should return 500 when workspace creation throws a SyntaxError (not 400)', async () => {
      // Regression: a SyntaxError raised deep inside workspace creation (e.g.
      // from JSON.parse on a corrupted config file) must not be misclassified
      // as a malformed request body.
      mockWorkspaceService.create.mockRejectedValue(new SyntaxError('boom'));

      const { res } = await sendJsonRequest(
        'POST',
        '/api/workspace',
        JSON.stringify({ project: 'My Project' })
      );

      expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({ error: 'Failed to create workspace' });
    });
  });

  // --------------------------------------------------------------------------
  // /api/v1/mcp route
  // --------------------------------------------------------------------------

  describe('/api/v1/mcp route', () => {
    beforeEach(() => {
      httpServerService.start();
    });

    it('scopes MCP tools to the SSH host the request came through', async () => {
      mockProjectService.list.mockReturnValue([
        createProject({ id: 'proj-1', name: 'My Project' }),
      ]);
      const req = createMockRequest('POST', '/api/v1/mcp', undefined, {
        'x-komla-ssh-host-id': 'ssh-dev',
      });
      capturedHandler!(req, createMockResponse());
      const spawnCall = mockMcpTool.mock.calls.find(
        (call) => call[0] === 'spawn_agent_in_new_workspace'
      );
      const spawn = spawnCall![3] as (params: Record<string, unknown>) => Promise<unknown>;

      const result = (await spawn({ cwd: '/not/a/workspace', project: 'My Project' })) as {
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(mockWorkspaceService.create).not.toHaveBeenCalled();
    });

    it('should create MCP server and transport, then handle request', async () => {
      const req = createMockRequest('POST', '/api/v1/mcp');
      const res = createMockResponse();
      capturedHandler!(req, res);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockMcpConnect).toHaveBeenCalled();
      expect(mockTransportHandleRequest).toHaveBeenCalledWith(req, res);
    });

    it('should return 500 when MCP connect fails', async () => {
      mockMcpConnect.mockRejectedValue(new Error('connect failed'));

      const req = createMockRequest('POST', '/api/v1/mcp');
      const res = createMockResponse();
      capturedHandler!(req, res);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
      expect(parseJsonResponse(res)).toEqual({ error: 'Internal server error' });
    });

    it('should not send error response if headers already sent', async () => {
      mockMcpConnect.mockRejectedValue(new Error('connect failed'));

      const req = createMockRequest('POST', '/api/v1/mcp');
      const res = createMockResponse();
      res.headersSent = true;
      capturedHandler!(req, res);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('should handle any HTTP method on /mcp', async () => {
      const req = createMockRequest('GET', '/api/v1/mcp');
      const res = createMockResponse();
      capturedHandler!(req, res);
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Routes to MCP handler regardless of method
      expect(mockMcpConnect).toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // MCP spawn_agent_in_new_workspace tool
  // --------------------------------------------------------------------------

  describe('MCP spawn_agent_in_new_workspace tool', () => {
    let toolHandler: (params: Record<string, unknown>) => Promise<unknown>;

    beforeEach(() => {
      httpServerService.start();

      // Trigger MCP server creation to capture the tool handler
      const req = createMockRequest('POST', '/api/v1/mcp');
      const res = createMockResponse();
      capturedHandler!(req, res);

      // Extract the tool handler from the mock
      expect(mockMcpTool).toHaveBeenCalled();
      // server.tool(name, description, schema, handler)
      toolHandler = mockMcpTool.mock.calls[0][3];
    });

    it('gates both spawn tools on a user request', () => {
      const descriptions = new Map(
        mockMcpTool.mock.calls.map(([name, description]) => [name, description])
      );

      for (const tool of ['spawn_agent_in_new_workspace', 'spawn_agent_new_tab']) {
        expect(descriptions.get(tool)).toContain('Use only when the user asks');
      }
    });

    it('should return success content when workspace creation succeeds', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        name: 'ws-name',
        branchName: 'agent/feat',
        workingDirectory: '/mock/worktree',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);

      const result = (await toolHandler({ project: 'My Project' })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Agent spawned in new workspace.');
      expect(result.content[0].text).toContain('agent/feat');
    });

    it('queues workspace-created notifications until the renderer is ready', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        id: 'ws-1',
        name: 'ws-name',
        branchName: 'agent/feat',
        workingDirectory: '',
        provisioning: true,
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);

      await toolHandler({ project: 'My Project' });

      expect(mockWindowService.sendWhenReady).toHaveBeenCalledWith(
        'main-window-id',
        IPC.WORKSPACE_CREATED,
        workspace
      );
    });

    it("branches from the calling workspace's current branch on request", async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      mockProjectService.list.mockReturnValue([project]);
      mockProjectService.get.mockReturnValue(project);
      mockWorkspaceService.list.mockReturnValue([
        createWorktreeWorkspace({
          id: 'ws-source',
          projectId: 'proj-1',
          branchName: 'feature/search',
          workingDirectory: '/projects/my-app',
        }),
      ]);
      mockGitService.getCheckedOutBranch.mockResolvedValueOnce('feature/search');
      mockWorkspaceService.create.mockResolvedValue(
        createWorktreeWorkspace({ branchName: 'agent/follow-up', workingDirectory: '/mock/wt' })
      );

      const result = (await toolHandler({ cwd: '/projects/my-app', fromCurrentBranch: true })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1', baseBranch: 'feature/search' })
      );
      expect(result.content[0].text).toContain('Branched from: feature/search');
    });

    it('should pass description as customDescription to workspace create', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        name: 'ws-name',
        branchName: 'agent/feat',
        workingDirectory: '/mock/worktree',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);

      await toolHandler({ project: 'My Project', description: 'Refactoring auth to use OAuth2' });

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customDescription: 'Refactoring auth to use OAuth2',
        })
      );
    });

    it('should return error when project is not found', async () => {
      const project = createProject({ name: 'Existing' });
      mockProjectService.list.mockReturnValue([project]);

      const result = (await toolHandler({ project: 'Missing' })) as {
        content: { type: string; text: string }[];
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('not found');
      expect(result.content[0].text).toContain('Existing');
    });

    it('should return error when workspace creation fails', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockRejectedValue(new Error('git worktree failed'));

      const result = (await toolHandler({ project: 'My Project' })) as {
        content: { type: string; text: string }[];
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('git worktree failed');
    });

    it('should use directory mode for directory projects', async () => {
      const project = createProject({
        id: 'dir-proj',
        name: 'Directory Project',
        kind: 'directory',
        repositoryPath: '/plain/folder',
      });
      const workspace = createDirectoryWorkspace({
        name: 'dir-ws',
        workingDirectory: '/plain/folder',
        projectId: 'dir-proj',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);

      const result = (await toolHandler({
        project: 'Directory Project',
        branchName: 'ignored-branch',
        initialPrompt: 'work in this folder',
      })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'directory',
          projectId: 'dir-proj',
          initialPrompt: 'work in this folder',
        })
      );
      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.not.objectContaining({
          mode: 'worktree',
          branchName: expect.any(String),
          deferBranchNaming: expect.any(Boolean),
        })
      );
    });

    it('should handle non-Error throws', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockRejectedValue(42);

      const result = (await toolHandler({ project: 'My Project' })) as {
        content: { type: string; text: string }[];
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown error');
    });

    it('should set deferBranchNaming when autoNameBranches is enabled and no branchName provided', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        name: 'ws-name',
        branchName: 'agent/feat',
        workingDirectory: '/mock/worktree',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);
      mockConfigService.get.mockReturnValue({ autoNameBranches: true });

      await toolHandler({
        project: 'My Project',
        initialPrompt: 'Fix the login bug',
      });

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          deferBranchNaming: true,
          initialPrompt: 'Fix the login bug',
        })
      );
    });

    it('should always set deferBranchNaming even when branchName is provided', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        name: 'ws-name',
        branchName: 'agent/my-branch',
        workingDirectory: '/mock/worktree',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);
      mockConfigService.get.mockReturnValue({ autoNameBranches: true });

      await toolHandler({
        project: 'My Project',
        initialPrompt: 'Fix the login bug',
        branchName: 'my-branch',
      });

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          deferBranchNaming: true,
          branchName: 'my-branch',
        })
      );
    });

    it('should always set deferBranchNaming even when autoNameBranches is disabled', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        name: 'ws-name',
        branchName: 'agent/feat',
        workingDirectory: '/mock/worktree',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);
      mockConfigService.get.mockReturnValue({ autoNameBranches: false });

      await toolHandler({
        project: 'My Project',
        initialPrompt: 'Fix the login bug',
      });

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          deferBranchNaming: true,
        })
      );
    });

    it('should always set deferBranchNaming even without initialPrompt', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        name: 'ws-name',
        branchName: 'agent/feat',
        workingDirectory: '/mock/worktree',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);
      mockConfigService.get.mockReturnValue({ autoNameBranches: true });

      await toolHandler({ project: 'My Project' });

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          deferBranchNaming: true,
        })
      );
    });

    it('should pass agentLaunchDefaultPresetId from config to workspace create', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        name: 'ws-name',
        branchName: 'agent/feat',
        workingDirectory: '/mock/worktree',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);
      mockConfigService.get.mockReturnValue({ agentLaunchDefaultPresetId: 'preset-123' });

      await toolHandler({ project: 'My Project' });

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          presetId: 'preset-123',
        })
      );
    });

    it('should pass agentLaunchDefaultLaunchModeId from config to workspace create', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        name: 'ws-name',
        branchName: 'agent/feat',
        workingDirectory: '/mock/worktree',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);
      mockConfigService.get.mockReturnValue({
        agentLaunchDefaultPresetId: 'preset-123',
        agentLaunchDefaultLaunchModeId: 'mode-456',
      });

      await toolHandler({ project: 'My Project' });

      expect(mockWorkspaceService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          presetId: 'preset-123',
          launchModeId: 'mode-456',
        })
      );
    });

    it('should not pass presetId or launchModeId when config has no MCP defaults', async () => {
      const project = createProject({ id: 'proj-1', name: 'My Project' });
      const workspace = createWorktreeWorkspace({
        name: 'ws-name',
        branchName: 'agent/feat',
        workingDirectory: '/mock/worktree',
      });
      mockProjectService.list.mockReturnValue([project]);
      mockWorkspaceService.create.mockResolvedValue(workspace);
      mockConfigService.get.mockReturnValue({});

      await toolHandler({ project: 'My Project' });

      const createCall = mockWorkspaceService.create.mock.calls[0][0];
      expect(createCall.presetId).toBeUndefined();
      expect(createCall.launchModeId).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // MCP set_status_item tool
  // --------------------------------------------------------------------------

  describe('MCP set_status_item tool', () => {
    it("sets the calling workspace's status item, and clears it without text", async () => {
      httpServerService.start();
      capturedHandler!(createMockRequest('POST', '/api/v1/mcp'), createMockResponse());
      const call = mockMcpTool.mock.calls.find((args) => args[0] === 'set_status_item');
      const toolHandler = call![3] as (params: Record<string, unknown>) => Promise<{
        content: { text: string }[];
        isError?: boolean;
      }>;
      mockWorkspaceService.list.mockReturnValue([
        createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' }),
      ]);
      const { statusItemsService } =
        await import('../../../src/main/services/status-items.service');

      const set = await toolHandler({
        cwd: '/projects/my-app',
        id: 'tests',
        text: 'All passing',
        tone: 'success',
      });
      expect(set.isError).toBeUndefined();
      expect(set.content[0].text).toBe('Status item tests set.');
      expect(statusItemsService.list()).toEqual([
        expect.objectContaining({ workspaceId: 'ws-1', id: 'tests', text: 'All passing' }),
      ]);

      const cleared = await toolHandler({ cwd: '/projects/my-app', id: 'tests' });
      expect(cleared.content[0].text).toBe('Status item tests cleared.');
      expect(statusItemsService.list()).toEqual([]);

      await toolHandler({
        cwd: '/projects/my-app',
        id: 'pr',
        text: 'PR #812',
        color: '#e5c07b',
        popoverMarkdown: '## Review\nRequested from **you**',
      });
      expect(statusItemsService.list()).toEqual([
        expect.objectContaining({
          id: 'pr',
          color: '#e5c07b',
          popoverMarkdown: '## Review\nRequested from **you**',
        }),
      ]);
      statusItemsService.clear('ws-1');

      await toolHandler({
        cwd: '/projects/my-app',
        id: 'ci',
        segments: [{ text: '\uf00c', color: 'success' }, { text: ' CI' }],
      });
      expect(statusItemsService.list()).toEqual([
        expect.objectContaining({
          id: 'ci',
          text: '\uf00c CI',
          segments: [{ text: '\uf00c', color: 'success' }, { text: ' CI' }],
        }),
      ]);
      statusItemsService.clear('ws-1');

      await toolHandler({
        cwd: '/projects/my-app',
        id: 'ci',
        text: 'CI 4/4',
        popover: '<b>4/4</b>',
      });
      expect(statusItemsService.list()).toEqual([
        expect.objectContaining({ id: 'ci', popover: '<b>4/4</b>' }),
      ]);
      statusItemsService.clear('ws-1');
    });

    it('counts status text without its terminal colors, and checks segments', () => {
      httpServerService.start();
      capturedHandler!(createMockRequest('POST', '/api/v1/mcp'), createMockResponse());
      const call = mockMcpTool.mock.calls.find((args) => args[0] === 'set_status_item');
      const shape = call![2] as Record<
        string,
        { safeParse: (value: unknown) => { success: boolean } }
      >;
      const colored = `\u001b[32m${'x'.repeat(30)}\u001b[0m`.repeat(2);
      expect(shape.text.safeParse(colored).success).toBe(true);
      expect(shape.text.safeParse(`${colored}x`).success).toBe(false);
      expect(shape.text.safeParse('\u001b[32m\u001b[0m').success).toBe(false);
      expect(shape.segments.safeParse([{ text: 'CI', color: 'success' }]).success).toBe(true);
      expect(shape.segments.safeParse([{ text: 'CI', color: 'red; x: y' }]).success).toBe(false);
      expect(
        shape.segments.safeParse([{ text: 'x'.repeat(40) }, { text: 'x'.repeat(21) }]).success
      ).toBe(false);
      expect(shape.segments.safeParse([]).success).toBe(false);
      expect(shape.segments.safeParse([{ text: colored }]).success).toBe(true);
      expect(
        shape.segments.safeParse([{ icon: '<svg/>', color: 'success' }, { text: ' CI' }]).success
      ).toBe(true);
      expect(shape.segments.safeParse([{ icon: 'https://x/a.svg' }, { text: 'CI' }]).success).toBe(
        false
      );
      expect(
        shape.segments.safeParse([...Array(5).fill({ icon: '<svg/>' }), { text: 'CI' }]).success
      ).toBe(false);
      expect(shape.icon.safeParse('data:image/png;base64,iVBORw0KGgo=').success).toBe(true);
      expect(shape.icon.safeParse('data:text/html,<b>').success).toBe(false);
    });

    it('rejects a color that is neither a theme color nor hex', () => {
      httpServerService.start();
      capturedHandler!(createMockRequest('POST', '/api/v1/mcp'), createMockResponse());
      const call = mockMcpTool.mock.calls.find((args) => args[0] === 'set_status_item');
      const shape = call![2] as Record<
        string,
        { safeParse: (value: unknown) => { success: boolean } }
      >;
      expect(shape.color.safeParse('success').success).toBe(true);
      expect(shape.color.safeParse('#E5C07B').success).toBe(true);
      expect(shape.color.safeParse('red; background: url(x)').success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // MCP set_workspace_title tool
  // --------------------------------------------------------------------------

  describe('MCP set_workspace_title tool', () => {
    let toolHandler: (params: Record<string, unknown>) => Promise<unknown>;

    beforeEach(() => {
      httpServerService.start();

      const req = createMockRequest('POST', '/api/v1/mcp');
      const res = createMockResponse();
      capturedHandler!(req, res);

      const setTitleCall = mockMcpTool.mock.calls.find((call) => call[0] === 'set_workspace_title');
      expect(setTitleCall).toBeTruthy();
      toolHandler = setTitleCall![3];
    });

    it('should update workspace title when cwd matches workspace', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        name: 'Original Workspace',
        workingDirectory: '/projects/my-app',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.update.mockReturnValue({
        ...workspace,
        customName: 'Implement auth flow',
      });

      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      const result = (await toolHandler({
        cwd: '/projects/my-app',
        title: 'Implement auth flow',
      })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain('Workspace title updated');
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', {
        customName: 'Implement auth flow',
      });
      expect(win.webContents.send).toHaveBeenCalledWith('workspace:updated', {
        ...workspace,
        customName: 'Implement auth flow',
      });
    });

    it('should match workspace when cwd is a nested path', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);

      await toolHandler({
        cwd: '/projects/my-app/src/features',
        title: 'Refactor layout store',
      });

      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', {
        customName: 'Refactor layout store',
      });
    });

    it('should update title for a single directory workspace match', async () => {
      const workspace = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared-dir',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);

      const result = (await toolHandler({
        cwd: '/projects/shared-dir',
        title: 'Directory task',
      })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-1', {
        customName: 'Directory task',
      });
    });

    it('should reject title updates when directory workspace cwd is ambiguous', async () => {
      const firstWorkspace = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const secondWorkspace = createDirectoryWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      mockWorkspaceService.list.mockReturnValue([firstWorkspace, secondWorkspace]);

      const result = (await toolHandler({
        cwd: '/projects/shared-dir/src',
        title: 'Directory task',
      })) as {
        content: { type: string; text: string }[];
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Multiple workspaces match cwd');
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });

    it('should update title for the only running duplicate cwd match', async () => {
      const stoppedWorkspace = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const runningWorkspace = createDirectoryWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'running' })],
      });
      mockWorkspaceService.list.mockReturnValue([stoppedWorkspace, runningWorkspace]);

      const result = (await toolHandler({
        cwd: '/projects/shared-dir/src',
        title: 'Directory task',
      })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.update).toHaveBeenCalledWith('ws-2', {
        customName: 'Directory task',
      });
    });

    it('should return error when no matching workspace is found', async () => {
      mockWorkspaceService.list.mockReturnValue([]);

      const result = (await toolHandler({
        cwd: '/projects/missing',
        title: 'New title',
      })) as {
        content: { type: string; text: string }[];
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No matching workspace found');
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
    });

    it('should return error when workspace update fails', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.update.mockImplementation(() => {
        throw new Error('Failed to save');
      });

      const result = (await toolHandler({
        cwd: '/projects/my-app',
        title: 'New title',
      })) as {
        content: { type: string; text: string }[];
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Failed to save');
    });
  });

  // --------------------------------------------------------------------------
  // MCP spawn_agent_new_tab tool
  // --------------------------------------------------------------------------

  describe('MCP spawn_agent_new_tab tool', () => {
    let toolHandler: (params: Record<string, unknown>) => Promise<unknown>;

    beforeEach(() => {
      httpServerService.start();

      const req = createMockRequest('POST', '/api/v1/mcp');
      const res = createMockResponse();
      capturedHandler!(req, res);

      const spawnAgentCall = mockMcpTool.mock.calls.find(
        (call) => call[0] === 'spawn_agent_new_tab'
      );
      expect(spawnAgentCall).toBeTruthy();
      toolHandler = spawnAgentCall![3];
    });

    it('preserves trusted terminal and SSH host context through the CLI MCP adapter', async () => {
      mockMcpTool.mockClear();
      const workspace = createWorkspace({
        id: 'ssh-workspace-a',
        workingDirectory: 'ssh://ssh-a/home/dev/repo',
        backend: {
          kind: 'ssh',
          hostId: 'ssh-a',
          remoteDirectory: '/home/dev/repo',
          remoteRepoPath: '/home/dev/repo.git',
          remoteProjectRoot: '/home/dev',
          gitUrl: 'git@example/repo.git',
          branchName: 'feature',
          baseBranch: 'main',
        },
      });
      mockWorkspaceService.findWorkspaceByTerminalId.mockImplementation((id: string) =>
        id === 'terminal-a' ? workspace : undefined
      );
      mockWorkspaceService.addAgentTab.mockResolvedValue({ id: 'terminal-new' });

      const req = createMockRequest('POST', '/terminals/terminal-a/api/v1/cli/mcp', undefined, {
        'x-komla-workspace-id': workspace.id,
        'x-komla-ssh-host-id': 'ssh-a',
      });
      const res = createMockResponse();
      capturedHandler!(req, res);
      await Promise.resolve();
      const spawnAgentCall = mockMcpTool.mock.calls.find(
        (call) => call[0] === 'spawn_agent_new_tab'
      );
      const scopedHandler = spawnAgentCall![3] as (
        params: Record<string, unknown>
      ) => Promise<unknown>;

      await scopedHandler({ cwd: '/ambiguous/on/every/host', prompt: 'Continue' });

      expect(mockWorkspaceService.addAgentTab).toHaveBeenCalledWith(
        workspace.id,
        'Continue',
        undefined,
        undefined,
        { keepWorkspaceAgent: true }
      );
    });

    it('should spawn agent in matching workspace', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        name: 'My Workspace',
        customName: 'Auth Feature',
        workingDirectory: '/projects/my-app',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.addAgentTab.mockReturnValue({ id: 'term-1' });

      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      const result = (await toolHandler({
        cwd: '/projects/my-app',
        prompt: 'Fix the login bug',
      })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('Agent spawned successfully.');
      expect(mockWorkspaceService.addAgentTab).toHaveBeenCalledWith(
        'ws-1',
        'Fix the login bug',
        undefined,
        undefined,
        { keepWorkspaceAgent: true }
      );
      expect(win.webContents.send).toHaveBeenCalledWith('workspace:agent-tab-added', {
        workspaceId: 'ws-1',
        terminalId: 'term-1',
      });
    });

    it('waits for asynchronous SSH tab creation before reporting success', async () => {
      const workspace = createWorkspace({
        id: 'ssh-ws',
        workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      let resolveTerminal!: (terminal: { id: string }) => void;
      const terminalPromise = new Promise<{ id: string }>((resolve) => {
        resolveTerminal = resolve;
      });
      mockWorkspaceService.addAgentTab.mockReturnValue(terminalPromise);

      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      let settled = false;
      const resultPromise = toolHandler({ cwd: workspace.workingDirectory }).finally(() => {
        settled = true;
      });
      await Promise.resolve();

      expect(settled).toBe(false);
      expect(win.webContents.send).not.toHaveBeenCalled();

      resolveTerminal({ id: 'ssh-term' });
      const result = (await resultPromise) as { isError?: boolean };
      expect(result.isError).toBeUndefined();
      expect(win.webContents.send).toHaveBeenCalledWith('workspace:agent-tab-added', {
        workspaceId: 'ssh-ws',
        terminalId: 'ssh-term',
      });
    });

    it('reports asynchronous SSH tab creation failures without broadcasting', async () => {
      const workspace = createWorkspace({
        id: 'ssh-ws',
        workingDirectory: 'ssh://ssh-dev/home/dev/worktree',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.addAgentTab.mockRejectedValue(new Error('SSH tunnel failed'));

      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      const result = (await toolHandler({ cwd: workspace.workingDirectory })) as {
        content: Array<{ text: string }>;
        isError?: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('SSH tunnel failed');
      expect(win.webContents.send).not.toHaveBeenCalled();
    });

    it('should use MCP launch defaults instead of the workspace preset', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
        presetId: 'workspace-claude-preset',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.addAgentTab.mockReturnValue({ id: 'term-1' });
      mockConfigService.get.mockReturnValue({
        agentLaunchDefaultPresetId: 'codex-preset',
        agentLaunchDefaultLaunchModeId: 'plan-mode',
      });

      const result = (await toolHandler({
        cwd: '/projects/my-app',
        prompt: 'Fix the login bug',
      })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.addAgentTab).toHaveBeenCalledWith(
        'ws-1',
        'Fix the login bug',
        'plan-mode',
        'codex-preset',
        { keepWorkspaceAgent: true }
      );
    });

    it('should work without a prompt', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.addAgentTab.mockReturnValue({ id: 'term-2' });

      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      const result = (await toolHandler({
        cwd: '/projects/my-app',
      })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.addAgentTab).toHaveBeenCalledWith(
        'ws-1',
        undefined,
        undefined,
        undefined,
        { keepWorkspaceAgent: true }
      );
    });

    it('should spawn agent for a single directory workspace match', async () => {
      const workspace = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared-dir',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.addAgentTab.mockReturnValue({ id: 'term-1' });

      const result = (await toolHandler({
        cwd: '/projects/shared-dir',
        prompt: 'Review local changes',
      })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.addAgentTab).toHaveBeenCalledWith(
        'ws-1',
        'Review local changes',
        undefined,
        undefined,
        { keepWorkspaceAgent: true }
      );
    });

    it('should reject agent spawns when directory workspace cwd is ambiguous', async () => {
      const firstWorkspace = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const secondWorkspace = createDirectoryWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      mockWorkspaceService.list.mockReturnValue([firstWorkspace, secondWorkspace]);

      const result = (await toolHandler({
        cwd: '/projects/shared-dir/src',
        prompt: 'Review local changes',
      })) as {
        content: { type: string; text: string }[];
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Multiple workspaces match cwd');
      expect(mockWorkspaceService.addAgentTab).not.toHaveBeenCalled();
    });

    it('should spawn agent in the only running duplicate cwd match', async () => {
      const stoppedWorkspace = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const runningWorkspace = createDirectoryWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'running' })],
      });
      mockWorkspaceService.list.mockReturnValue([stoppedWorkspace, runningWorkspace]);
      mockWorkspaceService.addAgentTab.mockReturnValue({ id: 'term-1' });

      const result = (await toolHandler({
        cwd: '/projects/shared-dir/src',
        prompt: 'Review local changes',
      })) as {
        content: { type: string; text: string }[];
        isError?: boolean;
      };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.addAgentTab).toHaveBeenCalledWith(
        'ws-2',
        'Review local changes',
        undefined,
        undefined,
        { keepWorkspaceAgent: true }
      );
    });

    it('should return error when no matching workspace is found', async () => {
      mockWorkspaceService.list.mockReturnValue([]);

      const result = (await toolHandler({
        cwd: '/projects/missing',
        prompt: 'Do something',
      })) as {
        content: { type: string; text: string }[];
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No matching workspace found');
    });

    it('should return error when addAgentTab fails', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.addAgentTab.mockImplementation(() => {
        throw new Error('No active preset');
      });

      const result = (await toolHandler({
        cwd: '/projects/my-app',
        prompt: 'Fix bug',
      })) as {
        content: { type: string; text: string }[];
        isError: boolean;
      };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('No active preset');
    });
  });

  // --------------------------------------------------------------------------
  // MCP open_browser_preview tool
  // --------------------------------------------------------------------------

  describe('MCP open_browser_preview tool', () => {
    let toolHandler: (params: Record<string, unknown>) => Promise<unknown>;

    beforeEach(() => {
      httpServerService.start();

      const req = createMockRequest('POST', '/api/v1/mcp');
      const res = createMockResponse();
      capturedHandler!(req, res);

      const call = mockMcpTool.mock.calls.find((c) => c[0] === 'open_browser_preview');
      expect(call).toBeTruthy();
      toolHandler = call![3];
    });

    it("should open the workspace's browser in the main window when no URL is provided", async () => {
      const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
      mockWorkspaceService.list.mockReturnValue([workspace]);

      const result = (await toolHandler({
        cwd: '/projects/my-app',
      })) as { content: { text: string }[]; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
      expect(mockWindowService.sendToWindowOrNext).toHaveBeenCalledExactlyOnceWith(
        undefined,
        'workspace:open-dev-preview',
        { workspaceId: 'ws-1' }
      );
    });

    it('should open the URL in the window that shows the workspace', async () => {
      const workspace = createWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/my-app',
        windowId: 'window-2',
      });
      mockWorkspaceService.list.mockReturnValue([workspace]);
      mockWorkspaceService.get.mockReturnValue(workspace);

      const result = (await toolHandler({
        cwd: '/projects/my-app',
        url: 'http://localhost:8080',
      })) as { content: { text: string }[]; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
      expect(mockWindowService.sendToWindowOrNext).toHaveBeenCalledExactlyOnceWith(
        'window-2',
        'workspace:open-dev-preview',
        { workspaceId: 'ws-1', url: 'http://localhost:8080', urlExecutionLocation: 'workspace' }
      );
    });

    it('should reject a URL that is not a web page and broadcast nothing', async () => {
      const workspace = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/my-app' });
      mockWorkspaceService.list.mockReturnValue([workspace]);

      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      const result = (await toolHandler({
        cwd: '/projects/my-app',
        url: 'javascript:alert(1)',
      })) as { content: { text: string }[]; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(mockWorkspaceService.update).not.toHaveBeenCalled();
      expect(win.webContents.send).not.toHaveBeenCalled();
      expect(mockWindowService.sendToWindowOrNext).not.toHaveBeenCalled();
    });

    it('should open preview for the only running duplicate cwd match', async () => {
      const stoppedWorkspace = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const runningWorkspace = createDirectoryWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'running' })],
      });
      mockWorkspaceService.list.mockReturnValue([stoppedWorkspace, runningWorkspace]);

      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      const result = (await toolHandler({
        cwd: '/projects/shared-dir/src',
      })) as { content: { text: string }[]; isError?: boolean };

      expect(result.isError).toBeUndefined();
      expect(mockWindowService.sendToWindowOrNext).toHaveBeenCalledWith(
        undefined,
        'workspace:open-dev-preview',
        { workspaceId: 'ws-2' }
      );
    });

    it('should reject opening preview when duplicate cwd matches are not obvious', async () => {
      const firstWorkspace = createDirectoryWorkspace({
        id: 'ws-1',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      const secondWorkspace = createDirectoryWorkspace({
        id: 'ws-2',
        workingDirectory: '/projects/shared-dir',
        terminals: [createTerminal({ status: 'stopped' })],
      });
      mockWorkspaceService.list.mockReturnValue([firstWorkspace, secondWorkspace]);

      const win = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([win]);

      const result = (await toolHandler({
        cwd: '/projects/shared-dir/src',
      })) as { content: { text: string }[]; isError?: boolean };

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Multiple workspaces match cwd');
      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // MCP disabled tools (agentDisabledCapabilities config)
  // --------------------------------------------------------------------------

  describe('agentDisabledCapabilities', () => {
    function triggerMcpServerCreation() {
      const req = createMockRequest('POST', '/api/v1/mcp');
      const res = createMockResponse();
      capturedHandler!(req, res);
    }

    function registeredToolNames(): string[] {
      return mockMcpTool.mock.calls.map((args) => args[0] as string);
    }

    it('registers all default-on tools when no per-tool toggles are set', () => {
      mockConfigService.get.mockReturnValue({});
      httpServerService.start();
      triggerMcpServerCreation();

      expect(registeredToolNames().sort()).toEqual(
        [
          'spawn_agent_in_new_workspace',
          'set_workspace_title',
          'set_status_item',
          'spawn_agent_new_tab',
          'open_browser_preview',
        ].sort()
      );
    });

    it('skips registration for default-on tools listed in agentDisabledCapabilities', () => {
      mockConfigService.get.mockReturnValue({
        agentDisabledCapabilities: ['preview.open', 'agent.launch.tab'],
      });
      httpServerService.start();
      triggerMcpServerCreation();

      const names = registeredToolNames();
      expect(names).not.toContain('open_browser_preview');
      expect(names).not.toContain('spawn_agent_new_tab');
      expect(names).toContain('spawn_agent_in_new_workspace');
      expect(names).toContain('set_workspace_title');
    });

    it('skips every tool when all default-on tools are disabled', () => {
      mockConfigService.get.mockReturnValue({
        agentDisabledCapabilities: [
          'agent.launch.workspace',
          'workspace.title',
          'status.set',
          'agent.launch.tab',
          'preview.open',
        ],
      });
      httpServerService.start();
      triggerMcpServerCreation();

      expect(mockMcpTool).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // Route-level kill switches (disableMcpServer, disableNotificationEndpoint)
  // --------------------------------------------------------------------------

  describe('disableMcpServer', () => {
    beforeEach(() => {
      mockConfigService.get.mockReturnValue({ disableMcpServer: true });
      httpServerService.start();
    });

    it('returns 404 for POST /api/v1/mcp when disabled', async () => {
      const { res } = await sendRequest('POST', '/api/v1/mcp', '{}');
      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not found');
    });

    it('disables the installed stdio MCP adapter without disabling typed CLI commands', async () => {
      const { res } = await sendRequest('POST', '/api/v1/cli/mcp', '{}');

      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not found');
      expect(mockTransportHandleRequest).not.toHaveBeenCalled();
    });

    it('returns 404 for POST /api/v1/workspace when disabled', async () => {
      const { res } = await sendJsonRequest(
        'POST',
        '/api/v1/workspace',
        JSON.stringify({ prompt: 'hi' })
      );
      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not found');
    });

    it('still serves /health when MCP server is disabled', async () => {
      const { res } = await sendRequest('GET', '/api/v1/health');
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
    });

    it('still serves /notify when only MCP is disabled', async () => {
      // notify is gated by a separate flag — disabling MCP alone must not
      // silently break attention reporting.
      const ws = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/app' });
      mockWorkspaceService.list.mockReturnValue([ws]);
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/projects/app' })
      );
      expect(res.writeHead).not.toHaveBeenCalledWith(404);
    });
  });

  describe('disableNotificationEndpoint', () => {
    beforeEach(() => {
      mockConfigService.get.mockReturnValue({ disableNotificationEndpoint: true });
      httpServerService.start();
    });

    it('returns 404 for POST /api/v1/notify when disabled', async () => {
      const { res } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/projects/app' })
      );
      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not found');
    });

    it('still serves /mcp and /workspace when only notify is disabled', async () => {
      const { res: mcpRes } = await sendRequest('POST', '/api/v1/mcp', '{}');
      expect(mcpRes.writeHead).not.toHaveBeenCalledWith(404);

      const { res: wsRes } = await sendJsonRequest(
        'POST',
        '/api/v1/workspace',
        JSON.stringify({ prompt: 'hi' })
      );
      expect(wsRes.writeHead).not.toHaveBeenCalledWith(404);
    });
  });

  describe('agentDisabledCapabilities gating REST', () => {
    beforeEach(() => {
      // Disabling the spawn tool via the per-tool blacklist must close the
      // REST sibling too — otherwise the toggle is misleading.
      mockConfigService.get.mockReturnValue({
        agentDisabledCapabilities: ['agent.launch.workspace'],
      });
      httpServerService.start();
    });

    it('returns 404 for POST /api/v1/workspace when spawn tool is disabled', async () => {
      const { res } = await sendJsonRequest(
        'POST',
        '/api/v1/workspace',
        JSON.stringify({ prompt: 'hi' })
      );
      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not found');
    });

    it('still serves /mcp and /notify when only the spawn tool is blacklisted', async () => {
      const { res: mcpRes } = await sendRequest('POST', '/api/v1/mcp', '{}');
      expect(mcpRes.writeHead).not.toHaveBeenCalledWith(404);

      const ws = createWorkspace({ id: 'ws-1', workingDirectory: '/projects/app' });
      mockWorkspaceService.list.mockReturnValue([ws]);
      const { res: notifyRes } = await sendRequest(
        'POST',
        '/api/v1/notify',
        JSON.stringify({ cwd: '/projects/app' })
      );
      expect(notifyRes.writeHead).not.toHaveBeenCalledWith(404);
    });
  });

  // --------------------------------------------------------------------------
  // Unknown routes
  // --------------------------------------------------------------------------

  describe('unknown routes', () => {
    beforeEach(() => {
      httpServerService.start();
    });

    it('should return 404 for GET /', async () => {
      const { res } = await sendRequest('GET', '/');

      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not found');
    });

    it('should return 404 for POST /unknown', async () => {
      const { res } = await sendRequest('POST', '/unknown');

      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not found');
    });

    it('should return 404 for GET /api/v1/notify (wrong method)', async () => {
      const { res } = await sendRequest('GET', '/api/v1/notify');

      expect(res.writeHead).toHaveBeenCalledWith(404);
    });

    it('should return 404 for GET /api/workspace (wrong method)', async () => {
      const { res } = await sendRequest('GET', '/api/workspace');

      expect(res.writeHead).toHaveBeenCalledWith(404);
    });
  });
});
