import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { templateExecutable } from '../../../src/main/services/agent-detection.service';
import { skipsPermissionPrompts } from '../../../src/shared/lib/launch-mode-permissions';
import { createClaudePreset } from '../../factories';

// Mock electron modules
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/mock/home'),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

// Mock fs module
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  // Atomic write operations
  openSync: vi.fn(() => 42),
  closeSync: vi.fn(),
  fsyncSync: vi.fn(),
  renameSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock('crypto', async (importOriginal) => ({
  ...(await importOriginal<typeof import('crypto')>()),
  randomUUID: vi.fn(() => 'fixed-uuid'),
}));

// Mock FileWatcher
vi.mock('./file-watcher', () => ({
  FileWatcher: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock atomic-write
vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomicSync: vi.fn(),
}));

// Mock paths
vi.mock('./paths', () => ({
  getKomlaBasePath: vi.fn(() => '/mock/home/.komla'),
}));

// Mock WSL detection so prompt escaping can be exercised in WSL mode
const { mockIsWslMode } = vi.hoisted(() => ({ mockIsWslMode: vi.fn(() => false) }));
vi.mock('../../../src/main/lib/wsl', () => ({
  isWslMode: mockIsWslMode,
}));

const { mockGetShell } = vi.hoisted(() => ({ mockGetShell: vi.fn(() => 'powershell.exe') }));
vi.mock('../../../src/main/lib/shell', () => ({
  getShell: mockGetShell,
}));

const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const { writeFileAtomicSync } = await import('../../../src/main/lib/atomic-write');
const mockWriteFileAtomicSync = vi.mocked(writeFileAtomicSync);
const { randomUUID: mockUuid } = await import('crypto');
const { BrowserWindow } = await import('electron');

// Commands here expect the POSIX printf escaping of a macOS or Linux desktop shell. A
// Windows host uses PowerShell escaping instead, which the 'on Windows' tests cover.
function usePosixDesktopShell(): void {
  const originalPlatform = process.platform;
  beforeEach(() => {
    if (originalPlatform === 'win32') {
      Object.defineProperty(process, 'platform', { value: 'linux' });
    }
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });
}

describe('AgentPresetService', () => {
  let agentPresetService: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.resetModules();

    // Setup default mocks for constructor — user presets only (no builtins)
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        _version: 2,
        activePresets: [{ presetId: 'claude-uuid', lastUsedAt: Date.now() }],
        presets: [
          {
            id: 'claude-uuid',
            name: 'Claude Code',
            openCommand: 'claude',
            continueCommand: 'claude --resume',
            promptCommand: 'claude {{prompt}}',
            launchModes: [],
            isBuiltin: false,
          },
          {
            id: 'custom-uuid',
            name: 'My Custom',
            openCommand: 'custom',
            continueCommand: 'custom --continue',
            promptCommand: 'custom {{prompt}}',
            launchModes: [],
            isBuiltin: false,
          },
        ],
      })
    );

    const { agentPresetService: service } =
      await import('../../../src/main/services/agent-preset.service');
    agentPresetService = service;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initialization', () => {
    it('should load config on construction', () => {
      expect(mockReadFileSync).toHaveBeenCalledWith(
        expect.stringContaining('agent-presets.json'),
        'utf-8'
      );
      expect(agentPresetService.getActiveId()).toBe('claude-uuid');
      expect(agentPresetService.list()).toHaveLength(2);
    });

    it('should create empty user config on first run', async () => {
      vi.resetModules();
      mockExistsSync.mockReturnValue(false);

      const { agentPresetService: _newService } =
        await import('../../../src/main/services/agent-preset.service');

      expect(mockMkdirSync).toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalledTimes(2); // Defaults and user config

      // User config should be empty (no builtins)
      const savedConfig = JSON.parse(mockWriteFileSync.mock.calls[1][1] as string);
      expect(savedConfig.presets).toHaveLength(0);
      expect(savedConfig.activePresets).toHaveLength(0);
      expect(savedConfig).not.toHaveProperty('activePresetId');
    });

    it('should write the defaults reference file on first run', async () => {
      vi.resetModules();
      mockExistsSync.mockReturnValue(false);
      mockUuid
        .mockReturnValueOnce('uuid-1')
        .mockReturnValueOnce('uuid-2')
        .mockReturnValueOnce('uuid-3')
        .mockReturnValueOnce('uuid-4')
        .mockReturnValueOnce('uuid-5')
        .mockReturnValueOnce('uuid-6');

      const { agentPresetService: _newService } =
        await import('../../../src/main/services/agent-preset.service');

      // First write is the defaults reference file
      const defaultsConfig = JSON.parse(mockWriteFileSync.mock.calls[0][1] as string);
      expect(defaultsConfig.presets.length).toBeGreaterThanOrEqual(6);
      expect(defaultsConfig.presets[0].name).toBe('Claude Code');
      expect(
        defaultsConfig.presets.every((preset: { name: string }) => !('utilityCommand' in preset))
      ).toBe(true);
    });
  });

  describe('templates', () => {
    usePosixDesktopShell();

    it('should return builtin templates via listTemplates', () => {
      const templates = agentPresetService.listTemplates();
      expect(templates.length).toBeGreaterThanOrEqual(6);
      expect(templates[0].name).toBe('Claude Code');
      expect(templates.find((t: any) => t.name === 'Codex')).toBeDefined();
      expect(templates.find((t: any) => t.name === 'Shell Only')).toBeDefined();
      // Templates should not have IDs
      for (const template of templates) {
        expect(template).not.toHaveProperty('id');
      }
    });

    it('warns that exactly the red built-in launch modes skip permission prompts', () => {
      const modes = agentPresetService
        .listTemplates()
        .flatMap((template: any) => template.launchModes);

      expect(modes.some((mode: any) => mode.color === 'red')).toBe(true);
      expect(
        modes
          .filter((mode: any) => skipsPermissionPrompts(mode) !== (mode.color === 'red'))
          .map((mode: any) => `${mode.name}: ${mode.arguments}`)
      ).toEqual([]);
    });

    it('does not include utility commands in built-in presets', () => {
      const presets = agentPresetService.listTemplates();
      expect(presets.every((preset) => !('utilityCommand' in preset))).toBe(true);
    });

    it('opens the Claude Code session picker when continuing', () => {
      const claude = agentPresetService
        .listTemplates()
        .find((template: any) => template.name === 'Claude Code');

      expect(agentPresetService.resolvePresetCommand(claude, 'continue')).toBe('claude --resume');
    });

    it('includes templates for the popular CLI coding agents', () => {
      const templates = agentPresetService.listTemplates();
      const names = templates.map((t: any) => t.name);
      for (const expected of [
        'Grok Build',
        'Antigravity CLI',
        'Cursor CLI',
        'GitHub Copilot CLI',
        'Amp',
        'Qwen Code',
        'Mistral Vibe',
        'Pi',
        'Goose',
        'Auggie',
        'Devin',
        'Hermes Agent',
        'Factory Droid',
        'Kiro CLI',
        'Kimi Code',
        'Kilo Code',
        'Cline',
        'Crush',
      ]) {
        expect(names).toContain(expected);
      }
      expect(names).not.toContain('Amazon Q Developer');
    });

    it('launches Cursor CLI as cursor-agent, since Grok Build also installs agent', () => {
      const templates = agentPresetService.listTemplates();
      const cursor = templates.find((template: any) => template.name === 'Cursor CLI');

      expect(cursor).toMatchObject({
        openCommand: 'cursor-agent {{launchMode}}',
        continueCommand: 'cursor-agent --continue {{launchMode}}',
        promptCommand: 'cursor-agent {{launchMode}} -- {{prompt}}',
      });
      // Agent detection looks for the executable each template launches.
      expect(templates.map((template: any) => templateExecutable(template.openCommand))).toEqual(
        expect.not.arrayContaining(['agent'])
      );
      expect(cursor?.launchModes).toEqual([
        expect.objectContaining({ name: 'Plan', arguments: '--mode plan' }),
        expect.objectContaining({ name: 'Ask', arguments: '--mode ask' }),
        expect.objectContaining({
          name: 'Force',
          arguments: '--force',
        }),
      ]);
    });

    it('distinguishes Codex workspace automation from unsandboxed YOLO mode', () => {
      const codex = agentPresetService
        .listTemplates()
        .find((template: any) => template.name === 'Codex');

      expect(codex).toMatchObject({
        openCommand: 'codex {{launchMode}}',
        continueCommand: 'codex resume {{launchMode}}',
        promptCommand: 'codex {{launchMode}} -- {{prompt}}',
      });
      expect(agentPresetService.resolvePresetCommand(codex, 'continue')).toBe('codex resume');
      expect(
        agentPresetService.resolvePresetCommand(codex, 'continue', codex.launchModes[0].id)
      ).toBe('codex resume --sandbox read-only');
      expect(codex?.launchModes).toEqual([
        expect.objectContaining({
          name: 'Read only',
          arguments: '--sandbox read-only',
        }),
        expect.objectContaining({
          name: 'Workspace auto',
          arguments: '--sandbox workspace-write --ask-for-approval never',
        }),
        expect.objectContaining({
          name: 'YOLO',
          arguments: '--dangerously-bypass-approvals-and-sandbox',
        }),
      ]);
    });

    it('offers documented reasoning levels for agents with an effort flag', () => {
      const templates = agentPresetService.listTemplates();
      const levelArgs = (name: string) =>
        templates
          .find((template: any) => template.name === name)
          ?.reasoningLevels?.map((level: any) => level.arguments);

      expect(levelArgs('Claude Code')).toEqual([
        '--effort low',
        '--effort medium',
        '--effort high',
        '--effort xhigh',
        '--effort max',
      ]);
      expect(levelArgs('Grok Build')).toEqual([
        '--effort low',
        '--effort medium',
        '--effort high',
        '--effort xhigh',
      ]);
      expect(levelArgs('Antigravity CLI')).toEqual([
        '--effort low',
        '--effort medium',
        '--effort high',
        '--effort xhigh',
        '--effort max',
      ]);
      expect(levelArgs('Hermes Agent')).toEqual([
        '--reasoning none',
        '--reasoning minimal',
        '--reasoning low',
        '--reasoning medium',
        '--reasoning high',
        '--reasoning xhigh',
        '--reasoning max',
        '--reasoning ultra',
      ]);
      const hermes = templates.find((template: any) => template.name === 'Hermes Agent');
      expect(hermes?.reasoningLevels[0].name).toBe('Off');
      expect(levelArgs('Kiro CLI')).toEqual([
        '--effort low',
        '--effort medium',
        '--effort high',
        '--effort xhigh',
        '--effort max',
      ]);
      expect(levelArgs('GitHub Copilot CLI')).toEqual([
        '--effort=none',
        '--effort=minimal',
        '--effort=low',
        '--effort=medium',
        '--effort=high',
        '--effort=xhigh',
        '--effort=max',
      ]);
      expect(levelArgs('Amp')).toEqual([
        '--mode low',
        '--mode medium',
        '--mode high',
        '--mode ultra',
      ]);
      expect(levelArgs('Pi')).toEqual([
        '--thinking off',
        '--thinking minimal',
        '--thinking low',
        '--thinking medium',
        '--thinking high',
        '--thinking xhigh',
        '--thinking max',
      ]);
      expect(levelArgs('Cline')).toEqual([
        '--thinking none',
        '--thinking low',
        '--thinking medium',
        '--thinking high',
        '--thinking xhigh',
      ]);
      for (const name of [
        'OpenCode',
        'Gemini',
        'Cursor CLI',
        'Qwen Code',
        'Auggie',
        'Factory Droid',
        'Kimi Code',
        'Kilo Code',
        'Crush',
        'Codex',
      ]) {
        expect(levelArgs(name)).toBeUndefined();
      }
    });

    it('uses documented Qwen Code prompt and approval mode flags', () => {
      const qwen = agentPresetService
        .listTemplates()
        .find((template: any) => template.name === 'Qwen Code');

      expect(qwen).toMatchObject({
        openCommand: 'qwen {{launchMode}}',
        continueCommand: 'qwen --continue {{launchMode}}',
        promptCommand: 'qwen {{launchMode}} --prompt-interactive={{prompt}}',
      });
      expect(qwen?.launchModes).toEqual([
        expect.objectContaining({
          name: 'Plan',
          arguments: '--approval-mode plan',
        }),
        expect.objectContaining({
          name: 'Manual',
          arguments: '--approval-mode default',
        }),
        expect.objectContaining({
          name: 'Accept edits',
          arguments: '--approval-mode auto-edit',
        }),
        expect.objectContaining({
          name: 'YOLO',
          arguments: '--approval-mode yolo',
        }),
      ]);
    });

    it('passes Gemini prompts by option, since Gemini drops them after --', () => {
      const gemini = agentPresetService
        .listTemplates()
        .find((template: any) => template.name === 'Gemini');

      expect(gemini).toMatchObject({
        openCommand: 'gemini --skip-trust {{launchMode}}',
        continueCommand: 'gemini --skip-trust {{launchMode}} --resume latest',
        promptCommand: 'gemini --skip-trust {{launchMode}} --prompt-interactive={{prompt}}',
      });
      expect(gemini?.launchModes).toEqual([
        expect.objectContaining({
          name: 'Plan',
          arguments: '--approval-mode plan',
        }),
        expect.objectContaining({
          name: 'Accept edits',
          arguments: '--approval-mode auto_edit',
        }),
        expect.objectContaining({
          name: 'YOLO',
          arguments: '--approval-mode yolo',
        }),
      ]);

      expect(agentPresetService.resolvePresetCommand(gemini, 'open')).toBe('gemini --skip-trust');
      expect(
        agentPresetService.resolvePresetCommand(gemini, 'open', gemini.launchModes[0].id)
      ).toBe('gemini --skip-trust --approval-mode plan');
      expect(
        agentPresetService.resolvePresetCommand(
          gemini,
          'prompt',
          gemini.launchModes[0].id,
          '--version'
        )
      ).toBe(
        `gemini --skip-trust --approval-mode plan --prompt-interactive="$(printf -- '--version')"`
      );
    });

    it('uses documented Antigravity CLI prompt, continue, and mode flags', () => {
      const antigravity = agentPresetService
        .listTemplates()
        .find((template: any) => template.name === 'Antigravity CLI');

      expect(antigravity).toMatchObject({
        openCommand: 'agy {{antigravityAutoTrustArgs}} {{launchMode}}',
        continueCommand: 'agy {{antigravityAutoTrustArgs}} --continue {{launchMode}}',
        promptCommand: 'agy {{antigravityAutoTrustArgs}} {{launchMode}} -i {{prompt}}',
      });
      expect(antigravity?.launchModes).toEqual([
        expect.objectContaining({
          name: 'Plan',
          arguments: '--mode plan',
        }),
        expect.objectContaining({
          name: 'Accept edits',
          arguments: '--mode accept-edits',
        }),
        expect.objectContaining({
          name: 'Dangerously skip permissions',
          arguments: '--dangerously-skip-permissions',
        }),
      ]);

      expect(
        agentPresetService.resolvePresetCommand(
          antigravity,
          'prompt',
          antigravity.launchModes[0].id,
          'Fix the tests'
        )
      ).toBe(`agy {{antigravityAutoTrustArgs}} --mode plan -i "$(printf -- 'Fix the tests')"`);
      expect(agentPresetService.resolvePresetCommand(antigravity, 'continue')).toBe(
        'agy {{antigravityAutoTrustArgs}} --continue'
      );
    });

    it('uses Hermes Agent chat prompt and YOLO flags and starts fresh when continuing', () => {
      const hermes = agentPresetService
        .listTemplates()
        .find((template: any) => template.name === 'Hermes Agent');

      expect(hermes).toMatchObject({
        openCommand: 'hermes chat {{launchMode}}',
        continueCommand: 'hermes chat {{launchMode}}',
        promptCommand: 'hermes chat {{launchMode}} -q {{prompt}}',
      });
      expect(hermes?.launchModes).toEqual([
        expect.objectContaining({
          name: 'YOLO',
          arguments: '--yolo',
        }),
      ]);

      expect(
        agentPresetService.resolvePresetCommand(
          hermes,
          'prompt',
          hermes.launchModes[0].id,
          'Fix the tests'
        )
      ).toBe(`hermes chat --yolo -q "$(printf -- 'Fix the tests')"`);
      expect(
        agentPresetService.resolvePresetCommand(hermes, 'continue', hermes.launchModes[0].id)
      ).toBe('hermes chat --yolo');
    });

    it('uses documented Factory Droid prompt, resume, spec, and autonomy flags', () => {
      const droid = agentPresetService
        .listTemplates()
        .find((template: any) => template.name === 'Factory Droid');

      expect(droid).toMatchObject({
        openCommand: 'droid {{launchMode}}',
        continueCommand: 'droid {{launchMode}} --resume',
        promptCommand: 'droid {{launchMode}} {{prompt}}',
      });
      expect(droid?.launchModes).toEqual([
        expect.objectContaining({
          name: 'Spec',
          arguments: '--use-spec',
        }),
        expect.objectContaining({
          name: 'Auto low',
          arguments: '--auto low',
        }),
        expect.objectContaining({
          name: 'Auto medium',
          arguments: '--auto medium',
        }),
        expect.objectContaining({
          name: 'Auto high',
          arguments: '--auto high',
        }),
      ]);

      expect(
        agentPresetService.resolvePresetCommand(
          droid,
          'prompt',
          droid.launchModes[0].id,
          'Fix the tests'
        )
      ).toBe(`droid --use-spec "$(printf -- 'Fix the tests')"`);
      expect(
        agentPresetService.resolvePresetCommand(droid, 'continue', droid.launchModes[0].id)
      ).toBe('droid --use-spec --resume');
    });

    it('uses documented Kiro CLI chat prompt, resume, trust, and effort flags', () => {
      const kiro = agentPresetService
        .listTemplates()
        .find((template: any) => template.name === 'Kiro CLI');

      expect(kiro).toMatchObject({
        openCommand: 'kiro-cli chat --trust-workspace {{launchMode}}',
        continueCommand: 'kiro-cli chat --trust-workspace --resume {{launchMode}}',
        promptCommand: 'kiro-cli chat --trust-workspace {{launchMode}} -- {{prompt}}',
      });
      expect(kiro?.launchModes).toEqual([
        expect.objectContaining({
          name: 'Spec',
          arguments: '--mode spec',
        }),
        expect.objectContaining({
          name: 'Trust all tools',
          arguments: '--trust-all-tools',
        }),
      ]);

      expect(
        agentPresetService.resolvePresetCommand(
          kiro,
          'prompt',
          kiro.launchModes[0].id,
          '- Fix the tests',
          'desktop',
          kiro.reasoningLevels[0].id
        )
      ).toBe(
        `kiro-cli chat --trust-workspace --mode spec --effort low -- "$(printf -- '- Fix the tests')"`
      );
      expect(agentPresetService.resolvePresetCommand(kiro, 'continue')).toBe(
        'kiro-cli chat --trust-workspace --resume'
      );
    });

    it('keeps Pi thinking flags ahead of prompts that start with a dash', () => {
      const pi = agentPresetService.listTemplates().find((template: any) => template.name === 'Pi');
      const off = pi.reasoningLevels[0].id;

      expect(
        agentPresetService.resolvePresetCommand(pi, 'prompt', null, '- Fix the tests', 'posix', off)
      ).toBe(`pi --thinking off -- "$(printf -- '- Fix the tests')"`);
      expect(
        agentPresetService.resolvePresetCommand(pi, 'prompt', null, '- Fix the tests', 'posix')
      ).toBe(`pi -- "$(printf -- '- Fix the tests')"`);
      expect(
        agentPresetService.resolvePresetCommand(pi, 'continue', null, undefined, 'posix', off)
      ).toBe('pi --thinking off -c');
      expect(agentPresetService.resolvePresetCommand(pi, 'open')).toBe('pi');
    });

    it('uses interactive Grok Build prompt commands and YOLO mode', () => {
      const grok = agentPresetService
        .listTemplates()
        .find((template: any) => template.name === 'Grok Build');

      expect(grok).toMatchObject({
        openCommand: 'grok {{launchMode}}',
        continueCommand: 'grok --continue {{launchMode}}',
        promptCommand: 'grok {{launchMode}} -- {{prompt}}',
        launchModes: [
          expect.objectContaining({ name: 'Plan', arguments: '--permission-mode plan' }),
          expect.objectContaining({ name: 'Auto', arguments: '--permission-mode auto' }),
          expect.objectContaining({
            name: 'YOLO',
            arguments: '--yolo',
          }),
        ],
      });
    });

    it('includes documented commands for newly covered CLI agents', () => {
      const templates = agentPresetService.listTemplates();

      // Amp seeds its prompt via piped stdin so the session stays interactive
      // (`-x` would run headless and exit).
      expect(templates.find((template: any) => template.name === 'Amp')).toMatchObject({
        openCommand: 'amp {{launchMode}}',
        continueCommand: 'amp {{launchMode}} threads continue',
        promptCommand: 'echo {{prompt}} | amp {{launchMode}}',
        launchModes: [
          expect.objectContaining({
            name: 'Dangerously allow all',
            arguments: '--dangerously-allow-all',
          }),
        ],
      });
      expect(templates.find((template: any) => template.name === 'Auggie')).toMatchObject({
        openCommand: 'auggie {{launchMode}}',
        continueCommand: 'auggie --resume {{launchMode}}',
        promptCommand: 'auggie {{launchMode}} -- {{prompt}}',
        launchModes: [
          expect.objectContaining({
            name: 'Ask',
            arguments: '--ask',
          }),
        ],
      });
      expect(templates.find((template: any) => template.name === 'Devin')).toMatchObject({
        openCommand: 'devin {{launchMode}}',
        continueCommand: 'devin --continue {{launchMode}}',
        promptCommand: 'devin {{launchMode}} -- {{prompt}}',
        launchModes: [
          expect.objectContaining({
            name: 'Accept edits',
            arguments: '--permission-mode accept-edits',
          }),
          expect.objectContaining({
            name: 'Bypass',
            arguments: '--permission-mode bypass',
          }),
        ],
      });
    });

    it('uses observed prompt and launch flags for OpenCode, Copilot, and Vibe', () => {
      const templates = agentPresetService.listTemplates();

      expect(templates.find((template: any) => template.name === 'OpenCode')).toMatchObject({
        openCommand: 'opencode {{launchMode}}',
        continueCommand: 'opencode --continue {{launchMode}}',
        promptCommand: 'opencode {{launchMode}} --prompt={{prompt}}',
        launchModes: [
          expect.objectContaining({
            name: 'Auto',
            arguments: '--auto',
          }),
        ],
      });
      expect(
        templates.find((template: any) => template.name === 'GitHub Copilot CLI')
      ).toMatchObject({
        openCommand: 'copilot {{launchMode}}',
        continueCommand: 'copilot {{launchMode}}',
        promptCommand: 'copilot {{launchMode}} --interactive={{prompt}}',
        launchModes: [
          expect.objectContaining({
            name: 'Plan',
            arguments: '--mode plan',
          }),
          expect.objectContaining({
            name: 'Autopilot',
            arguments: '--mode autopilot',
          }),
          expect.objectContaining({
            name: 'Allow all tools',
            arguments: '--allow-all',
          }),
        ],
      });
      // Vibe 3.0.0 removed its plan agent.
      expect(templates.find((template: any) => template.name === 'Mistral Vibe')).toMatchObject({
        openCommand: 'vibe --trust {{launchMode}}',
        continueCommand: 'vibe --continue --trust {{launchMode}}',
        promptCommand: 'vibe --trust {{launchMode}} -- {{prompt}}',
        launchModes: [
          expect.objectContaining({ name: 'Ask', arguments: '--agent ask' }),
          expect.objectContaining({ name: 'YOLO', arguments: '--yolo' }),
        ],
      });
    });

    it('gives every non-empty built-in template an open command', () => {
      const templates = agentPresetService.listTemplates();
      for (const template of templates) {
        if (template.name === 'Shell Only' || template.name === 'Custom') continue;
        expect(template.openCommand.trim().length).toBeGreaterThan(0);
        // Reusable launch modes must contain arguments rather than a full command.
        for (const mode of template.launchModes) {
          expect(mode.arguments?.trim().length).toBeGreaterThan(0);
          expect(mode.command).toBeUndefined();
          expect(template.openCommand).toContain('{{launchMode}}');
          expect(template.continueCommand).toContain('{{launchMode}}');
          // Agents that can't start with a prompt have no prompt command.
          if (template.promptCommand) expect(template.promptCommand).toContain('{{launchMode}}');
        }
      }
    });

    it('should list() only user presets, not templates', () => {
      const presets = agentPresetService.list();
      expect(presets).toHaveLength(2);
      // None should be builtin
      for (const preset of presets) {
        expect(preset.isBuiltin).toBe(false);
      }
    });
  });

  describe('loading', () => {
    it('is the version the landing videos seed their presets at', async () => {
      const { PRESET_CONFIG_VERSION } =
        await import('../../../src/main/services/agent-preset.service');
      // e2e/videos seeds a current presets file so no migration rewrites its scripted agents.
      const actualFs = await vi.importActual<typeof import('fs')>('fs');
      const fixture = actualFs.readFileSync(
        `${__dirname}/../../../e2e/videos/video-fixtures.ts`,
        'utf-8'
      );
      expect(fixture).toContain(`_version: ${PRESET_CONFIG_VERSION},`);
    });

    it('does not rewrite preset files created by a newer schema version', async () => {
      vi.resetModules();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          _version: 99,
          futureSetting: { preserve: true },
          activePresets: [],
          presets: [
            {
              id: 'future-preset',
              name: 'Future Agent',
              openCommand: 'future-agent',
              continueCommand: '',
              promptCommand: '',
              launchModes: [],
              isBuiltin: false,
            },
          ],
        })
      );
      mockWriteFileAtomicSync.mockClear();

      const { agentPresetService: futureService } =
        await import('../../../src/main/services/agent-preset.service');

      expect(futureService.get('future-preset')).toBeDefined();
      expect(mockWriteFileAtomicSync).not.toHaveBeenCalled();
    });

    it('gives hand-edited reasoning levels string names and arguments', async () => {
      vi.resetModules();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          _version: 1,
          activePresets: [],
          presets: [
            {
              id: 'hand-edited',
              name: 'Hand edited',
              openCommand: 'agent',
              continueCommand: '',
              promptCommand: '',
              launchModes: [],
              reasoningLevels: [{ id: 'high', name: 'High' }, { name: 'No id' }, null],
              isBuiltin: false,
            },
          ],
        })
      );

      const { agentPresetService: loadedService } =
        await import('../../../src/main/services/agent-preset.service');

      expect(loadedService.get('hand-edited').reasoningLevels).toEqual([
        { id: 'high', name: 'High', arguments: '' },
      ]);
    });

    it('should turn templates copied into the file into user presets (isBuiltin: false)', async () => {
      vi.resetModules();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          activePresets: [{ presetId: 'builtin-claude', lastUsedAt: 1000 }],
          presets: [
            {
              id: 'builtin-claude',
              name: 'Claude Code',
              openCommand: 'claude',
              continueCommand: 'claude --continue',
              promptCommand: 'claude {{prompt}}',
              launchModes: [],
              isBuiltin: true,
            },
            {
              id: 'user-custom',
              name: 'My Agent',
              openCommand: 'myagent',
              continueCommand: '',
              promptCommand: '',
              launchModes: [],
              isBuiltin: false,
            },
          ],
        })
      );

      const { agentPresetService: migratedService } =
        await import('../../../src/main/services/agent-preset.service');

      const presets = migratedService.list();
      expect(presets).toHaveLength(2);
      // All presets should now have isBuiltin: false
      for (const preset of presets) {
        expect(preset.isBuiltin).toBe(false);
      }
      // The change is saved immediately
      expect(mockWriteFileAtomicSync).toHaveBeenCalled();
      const savedConfig = JSON.parse(mockWriteFileAtomicSync.mock.calls[0][1] as string);
      expect(savedConfig.presets.every((p: any) => p.isBuiltin === false)).toBe(true);
    });

    it('should remove stale activePresets entries on load', async () => {
      vi.resetModules();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          activePresets: [
            { presetId: 'existing-uuid', lastUsedAt: 1000 },
            { presetId: 'deleted-uuid', lastUsedAt: 500 },
          ],
          presets: [
            {
              id: 'existing-uuid',
              name: 'My Agent',
              openCommand: 'agent',
              continueCommand: '',
              promptCommand: '',
              launchModes: [],
              isBuiltin: false,
            },
          ],
        })
      );

      const { agentPresetService: migratedService } =
        await import('../../../src/main/services/agent-preset.service');

      const activePresets = migratedService.getActivePresets();
      expect(activePresets).toHaveLength(1);
      expect(activePresets[0].presetId).toBe('existing-uuid');
      // Should have saved due to stale entry removal
      expect(mockWriteFileAtomicSync).toHaveBeenCalled();
    });

  });

  describe('CRUD operations', () => {
    it('should get a preset by id', () => {
      const preset = agentPresetService.get('custom-uuid');
      expect(preset?.name).toBe('My Custom');
    });

    it('should create a new preset', () => {
      mockUuid.mockReturnValue('new-uuid');
      const newPreset = agentPresetService.create({
        name: 'Brand New',
        openCommand: 'new',
        continueCommand: 'new --cont',
        promptCommand: 'new {{prompt}}',
        launchModes: [],
        isBuiltin: false,
      });

      expect(newPreset.id).toBe('new-uuid');
      expect(agentPresetService.get('new-uuid')).toBeDefined();

      vi.advanceTimersByTime(600);
      expect(mockWriteFileAtomicSync).toHaveBeenCalled();
    });

    it('creates presets and activates them with the first as the default', () => {
      mockUuid.mockReturnValueOnce('codex-uuid').mockReturnValueOnce('amp-uuid');
      vi.advanceTimersByTime(1000);
      const preset = (name: string) => ({
        name,
        openCommand: name.toLowerCase(),
        continueCommand: '',
        promptCommand: '',
        launchModes: [],
        isBuiltin: false,
      });

      mockWriteFileAtomicSync.mockClear();

      const created = agentPresetService.createActive([preset('Codex'), preset('Amp')]);

      expect(created.map((p: { id: string }) => p.id)).toEqual(['codex-uuid', 'amp-uuid']);
      expect(
        agentPresetService.getActivePresets().map((entry: { presetId: string }) => entry.presetId)
      ).toEqual(['codex-uuid', 'amp-uuid', 'claude-uuid']);
      expect(agentPresetService.getActive()?.name).toBe('Codex');

      vi.advanceTimersByTime(600);
      expect(mockWriteFileAtomicSync).toHaveBeenCalledTimes(1);
    });

    it('should update an existing preset', () => {
      agentPresetService.update('custom-uuid', { name: 'Updated Name' });
      expect(agentPresetService.get('custom-uuid')?.name).toBe('Updated Name');

      vi.advanceTimersByTime(600);
      expect(mockWriteFileAtomicSync).toHaveBeenCalled();
    });

    it('should reorder presets', () => {
      agentPresetService.reorder('custom-uuid', 0);

      expect(agentPresetService.list().map((preset: { id: string }) => preset.id)).toEqual([
        'custom-uuid',
        'claude-uuid',
      ]);

      vi.advanceTimersByTime(600);
      expect(mockWriteFileAtomicSync).toHaveBeenCalled();
    });

    it('should throw when reordering a missing preset', () => {
      expect(() => agentPresetService.reorder('missing', 0)).toThrow('Preset missing not found');
    });

    it('should delete a preset', () => {
      agentPresetService.delete('custom-uuid');
      expect(agentPresetService.get('custom-uuid')).toBeUndefined();
    });

    it('should persist a deleted preset immediately', () => {
      mockWriteFileAtomicSync.mockClear();

      agentPresetService.delete('custom-uuid');

      expect(mockWriteFileAtomicSync).toHaveBeenCalledOnce();
      const savedConfig = JSON.parse(mockWriteFileAtomicSync.mock.calls[0][1]);
      expect(savedConfig.presets).toEqual([expect.objectContaining({ id: 'claude-uuid' })]);
    });

    it('should preserve the preset when deletion cannot be persisted', () => {
      mockWriteFileAtomicSync.mockImplementationOnce(() => {
        throw new Error('disk full');
      });

      expect(() => agentPresetService.delete('custom-uuid')).toThrow('disk full');
      expect(agentPresetService.get('custom-uuid')).toBeDefined();
    });

    it('should delete the active preset when another active preset can take over', () => {
      vi.advanceTimersByTime(1);
      agentPresetService.addActivePreset('custom-uuid');

      agentPresetService.delete('custom-uuid');

      expect(agentPresetService.get('custom-uuid')).toBeUndefined();
      expect(agentPresetService.getActiveId()).toBe('claude-uuid');
    });

    it('should throw error when deleting the last active preset', () => {
      expect(() => agentPresetService.delete('claude-uuid')).toThrow(
        'Cannot delete the last active preset'
      );
    });

    it('should throw error when deleting non-existent preset', () => {
      expect(() => agentPresetService.delete('non-existent')).toThrow(
        'Preset non-existent not found'
      );
    });
  });

  describe('active preset management', () => {
    it('should set active preset', () => {
      // Advance fake timers so the setActive call gets a higher lastUsedAt than the migration
      vi.advanceTimersByTime(1);
      agentPresetService.setActive('custom-uuid');
      expect(agentPresetService.getActiveId()).toBe('custom-uuid');
      expect(agentPresetService.getActive()?.name).toBe('My Custom');
    });

    it('should store launch mode when setting active preset with a mode', () => {
      agentPresetService.setActive('custom-uuid', 'mode-1');
      const entry = agentPresetService
        .getActivePresets()
        .find((e: any) => e.presetId === 'custom-uuid')!;
      expect(entry.lastLaunchModeId).toBe('mode-1');
    });

    it('should preserve launch mode when setting active preset without a mode', () => {
      agentPresetService.setActive('custom-uuid', 'mode-1');
      agentPresetService.setActive('custom-uuid');
      const entry = agentPresetService
        .getActivePresets()
        .find((e: any) => e.presetId === 'custom-uuid')!;
      expect(entry.lastLaunchModeId).toBe('mode-1');
    });

    it('should throw when setting non-existent preset as active', () => {
      expect(() => agentPresetService.setActive('missing')).toThrow('Preset missing not found');
    });
  });

  describe('getClaudeCodePreset', () => {
    it('should return user preset named Claude Code if it exists', () => {
      const preset = agentPresetService.getClaudeCodePreset();
      expect(preset).toBeDefined();
      expect(preset.name).toBe('Claude Code');
      expect(preset.id).toBe('claude-uuid');
    });

    it('should fall back to template when no user Claude Code preset exists', async () => {
      vi.resetModules();
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          activePresetId: 'other-uuid',
          presets: [
            {
              id: 'other-uuid',
              name: 'Other Agent',
              openCommand: 'other',
              continueCommand: '',
              promptCommand: '',
              launchModes: [],
              isBuiltin: false,
            },
          ],
        })
      );

      const { agentPresetService: svc } =
        await import('../../../src/main/services/agent-preset.service');

      const preset = svc.getClaudeCodePreset();
      expect(preset).toBeDefined();
      expect(preset.name).toBe('Claude Code');
      // Template has no id
      expect(preset).not.toHaveProperty('id');
    });
  });

  describe('resolveCommand', () => {
    usePosixDesktopShell();

    it('composes launch mode arguments into a prompt command', () => {
      const preset = {
        id: 'claude',
        name: 'Claude Code',
        openCommand: 'claude {{launchMode}}',
        continueCommand: 'claude --resume {{launchMode}}',
        promptCommand: 'claude {{launchMode}} {{prompt}}',
        launchModes: [
          {
            id: 'plan',
            name: 'Plan',
            arguments: '--permission-mode plan',
          },
        ],
        isBuiltin: false,
      };

      const result = agentPresetService.resolvePresetCommand(
        preset,
        'prompt',
        'plan',
        'review this'
      );

      expect(result).toBe(`claude --permission-mode plan "$(printf -- 'review this')"`);
    });

    it('composes reasoning arguments after launch mode arguments for every intent', () => {
      const preset = {
        id: 'claude',
        name: 'Claude Code',
        openCommand: 'claude {{launchMode}}',
        continueCommand: 'claude --resume {{launchMode}}',
        promptCommand: 'claude {{launchMode}} {{prompt}}',
        launchModes: [{ id: 'plan', name: 'Plan', arguments: '--permission-mode plan' }],
        reasoningLevels: [{ id: 'high', name: 'High', arguments: '--effort high' }],
        isBuiltin: false,
      };

      expect(
        agentPresetService.resolvePresetCommand(preset, 'prompt', 'plan', 'go', undefined, 'high')
      ).toBe(`claude --permission-mode plan --effort high "$(printf -- 'go')"`);
      expect(
        agentPresetService.resolvePresetCommand(preset, 'open', null, undefined, undefined, 'high')
      ).toBe('claude --effort high');
      expect(
        agentPresetService.resolvePresetCommand(
          preset,
          'continue',
          'plan',
          undefined,
          undefined,
          'high'
        )
      ).toBe('claude --resume --permission-mode plan --effort high');
    });

    it('ignores reasoning level ids the preset does not define', () => {
      const preset = {
        id: 'custom',
        name: 'Custom',
        openCommand: 'custom {{launchMode}}',
        continueCommand: '',
        promptCommand: '',
        launchModes: [],
        isBuiltin: false,
      };

      expect(
        agentPresetService.resolvePresetCommand(preset, 'open', null, undefined, undefined, 'gone')
      ).toBe('custom');
    });

    it('does not treat launch mode arguments as a command when the prompt command is empty', () => {
      const preset = {
        id: 'custom',
        name: 'Custom',
        openCommand: 'custom {{launchMode}}',
        continueCommand: '',
        promptCommand: '',
        launchModes: [{ id: 'fast', name: 'Fast', arguments: '--fast' }],
        isBuiltin: false,
      };

      expect(agentPresetService.resolvePresetCommand(preset, 'prompt', 'fast', 'review this')).toBe(
        ''
      );
    });

    it('should return empty string for empty command', () => {
      expect(agentPresetService.resolveCommand('', 'hello')).toBe('');
    });

    it('should return empty string for whitespace-only command', () => {
      expect(agentPresetService.resolveCommand('   ', 'hello')).toBe('');
    });

    it('should return command as-is when no prompt provided', () => {
      expect(agentPresetService.resolveCommand('claude')).toBe('claude');
    });

    it('should strip {{prompt}} when no prompt provided', () => {
      expect(agentPresetService.resolveCommand('claude {{prompt}}')).toBe('claude');
    });

    it('should strip {{prompt}} with surrounding whitespace when no prompt', () => {
      expect(agentPresetService.resolveCommand('claude --flag {{prompt}}')).toBe('claude --flag');
    });

    it('should substitute {{prompt}} with double-quoted escaped prompt', () => {
      const result = agentPresetService.resolveCommand('claude {{prompt}}', 'hello world');
      // POSIX: claude "$(printf -- 'hello world')"
      expect(result).toMatch(/^claude ".*hello world.*"$/);
    });

    it('should append double-quoted escaped prompt when no placeholder', () => {
      const result = agentPresetService.resolveCommand('claude --continue', 'hello world');
      expect(result).toMatch(/^claude --continue ".*hello world.*"$/);
    });

    it('should handle prompts with single quotes using printf escaping', () => {
      const result = agentPresetService.resolveCommand('claude {{prompt}}', "it's a test");
      // POSIX: single quotes are escaped as end-quote, escaped-quote, re-open: '\''
      expect(result).toBe(`claude "$(printf -- 'it'\\''s a test')"`);
    });

    it('should handle prompts with newlines using printf \\n', () => {
      const result = agentPresetService.resolveCommand('claude {{prompt}}', 'line1\nline2');
      expect(result).toBe(`claude "$(printf -- 'line1\\nline2')"`);
    });

    it('should keep replacement patterns in prompts literal', () => {
      const result = agentPresetService.resolveCommand('claude {{prompt}}', "use $& and $' here");
      expect(result).toBe(`claude "$(printf -- 'use $& and $'\\'' here')"`);
    });

    it('should handle prompts with backslashes', () => {
      const result = agentPresetService.resolveCommand('claude {{prompt}}', 'path\\to\\file');
      expect(result).toBe(`claude "$(printf -- 'path\\\\to\\\\file')"`);
    });

    it('should treat empty string prompt as a prompt, not strip placeholder', () => {
      const result = agentPresetService.resolveCommand('claude {{prompt}}', '');
      // Should substitute, not strip - result should contain quotes
      expect(result).toContain('claude');
      expect(result).toContain('"');
    });

    describe('on Windows', () => {
      const originalPlatform = process.platform;

      afterEach(() => {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
        mockIsWslMode.mockReturnValue(false);
        mockGetShell.mockReturnValue('powershell.exe');
      });

      it('should use PowerShell escaping in PowerShell mode', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockIsWslMode.mockReturnValue(false);
        const result = agentPresetService.resolveCommand('claude {{prompt}}', 'line1\nline2');
        // PowerShell: newlines escaped as `n inside double quotes
        expect(result).toBe('claude "line1`nline2"');
      });

      it('escapes double quotes in prompts for Windows PowerShell 5.1 native arguments', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockIsWslMode.mockReturnValue(false);
        const result = agentPresetService.resolveCommand(
          'claude {{prompt}}',
          'Rename "foo bar" to baz'
        );
        expect(result).toBe('claude "Rename \\`"foo bar\\`" to baz"');
      });

      it('leaves double quotes to PowerShell 7 native argument passing', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockIsWslMode.mockReturnValue(false);
        mockGetShell.mockReturnValue('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
        const result = agentPresetService.resolveCommand(
          'claude {{prompt}}',
          'Rename "foo bar" to baz'
        );
        expect(result).toBe('claude "Rename `"foo bar`" to baz"');
      });

      it('keeps dollar signs in prompts out of replacement patterns', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockIsWslMode.mockReturnValue(false);
        const result = agentPresetService.resolveCommand(
          'claude --x {{prompt}} --y',
          'pay $$ now $\u201chi\u201d'
        );
        expect(result).toBe('claude --x "pay `$`$ now `$`\u201chi`\u201d" --y');
      });

      it('escapes typographic double quotes that PowerShell treats as string delimiters', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockIsWslMode.mockReturnValue(false);
        const result = agentPresetService.resolveCommand(
          'claude {{prompt}}',
          'say \u201chi\u201d now'
        );
        expect(result).toBe('claude "say `\u201chi`\u201d now"');
      });

      it('should use POSIX printf escaping in WSL mode', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockIsWslMode.mockReturnValue(true);
        // WSL runs commands through bash, so prompts need POSIX escaping
        const result = agentPresetService.resolveCommand('claude {{prompt}}', 'line1\nline2');
        expect(result).toBe(`claude "$(printf -- 'line1\\nline2')"`);
      });

      it('should use POSIX escaping for a remote shell on native Windows', () => {
        Object.defineProperty(process, 'platform', { value: 'win32' });
        mockIsWslMode.mockReturnValue(false);

        const result = agentPresetService.resolveCommand(
          'claude {{prompt}}',
          'cost is $5 `today`\nnext',
          'posix'
        );

        expect(result).toBe(`claude "$(printf -- 'cost is \$5 \`today\`\\nnext')"`);
      });
    });

    it('builds POSIX prompt templates for a remote host to fill in', () => {
      const preset = createClaudePreset({
        id: 'claude',
        promptCommand: 'claude {{launchMode}} {{prompt}} --verbose',
        launchModes: [{ id: 'yolo', name: 'YOLO', arguments: '--dangerously-skip-permissions' }],
      });

      expect(agentPresetService.resolvePosixPromptTemplate(preset, 'yolo')).toEqual({
        promptCommand: 'claude --dangerously-skip-permissions {{prompt}} --verbose',
        openCommand: 'claude --dangerously-skip-permissions',
      });
      expect(
        agentPresetService.resolvePosixPromptTemplate(createClaudePreset({ promptCommand: '' }))
      ).toBeUndefined();
    });

    it('expands auto-trust arguments in POSIX prompt templates', () => {
      const templates = agentPresetService.listTemplates();
      const preset = (name: string) => templates.find((template: any) => template.name === name);

      expect(agentPresetService.resolvePosixPromptTemplate(preset('Antigravity CLI'))).toEqual({
        promptCommand: 'agy --add-dir "$PWD" -i {{prompt}}',
        openCommand: 'agy --add-dir "$PWD"',
      });
    });
  });

  describe('active presets', () => {
    it('should add a preset to active list', () => {
      const preset = agentPresetService.list()[1]; // second preset
      agentPresetService.addActivePreset(preset.id);
      const activePresets = agentPresetService.getActivePresets();
      expect(activePresets.some((e: any) => e.presetId === preset.id)).toBe(true);
    });

    it('should not add duplicate active preset', () => {
      const activePresets = agentPresetService.getActivePresets();
      const firstId = activePresets[0].presetId;
      const countBefore = activePresets.length;
      agentPresetService.addActivePreset(firstId);
      expect(agentPresetService.getActivePresets().length).toBe(countBefore);
    });

    it('should remove a preset from active list', () => {
      const preset = agentPresetService.list()[1];
      agentPresetService.addActivePreset(preset.id);
      agentPresetService.removeActivePreset(preset.id);
      const activePresets = agentPresetService.getActivePresets();
      expect(activePresets.some((e: any) => e.presetId === preset.id)).toBe(false);
    });

    it('should not remove last active preset', () => {
      const activePresets = agentPresetService.getActivePresets();
      expect(activePresets.length).toBe(1);
      expect(() => agentPresetService.removeActivePreset(activePresets[0].presetId)).toThrow(
        'Cannot remove the last active preset'
      );
    });

    it('should update lastUsedAt when recording usage', () => {
      const activePresets = agentPresetService.getActivePresets();
      const presetId = activePresets[0].presetId;
      const before = activePresets[0].lastUsedAt;
      agentPresetService.recordPresetUsage(presetId);
      const after = agentPresetService
        .getActivePresets()
        .find((e: any) => e.presetId === presetId)!.lastUsedAt;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it('should store lastLaunchModeId when recording usage with a launch mode', () => {
      const activePresets = agentPresetService.getActivePresets();
      const presetId = activePresets[0].presetId;
      agentPresetService.recordPresetUsage(presetId, 'plan-mode');
      const entry = agentPresetService
        .getActivePresets()
        .find((e: any) => e.presetId === presetId)!;
      expect(entry.lastLaunchModeId).toBe('plan-mode');
    });

    it('should store lastReasoningLevelId only when a reasoning level is passed', () => {
      const presetId = agentPresetService.getActivePresets()[0].presetId;
      const entry = () =>
        agentPresetService.getActivePresets().find((e: any) => e.presetId === presetId)!;

      agentPresetService.recordPresetUsage(presetId, null, 'high');
      expect(entry().lastReasoningLevelId).toBe('high');
      agentPresetService.recordPresetUsage(presetId, null);
      expect(entry().lastReasoningLevelId).toBe('high');
      agentPresetService.recordPresetUsage(presetId, null, null);
      expect(entry().lastReasoningLevelId).toBeNull();
    });

    it('should clear lastLaunchModeId when recording usage without a launch mode', () => {
      const activePresets = agentPresetService.getActivePresets();
      const presetId = activePresets[0].presetId;
      // First set a launch mode
      agentPresetService.recordPresetUsage(presetId, 'plan-mode');
      // Then clear it
      agentPresetService.recordPresetUsage(presetId);
      const entry = agentPresetService
        .getActivePresets()
        .find((e: any) => e.presetId === presetId)!;
      expect(entry.lastLaunchModeId).toBeNull();
    });

    it('should repoint activePresetId when removing the currently active preset', () => {
      // Add second preset to active list so we can remove one
      const secondPreset = agentPresetService.list()[1]; // 'My Custom'
      agentPresetService.addActivePreset(secondPreset.id);

      // Active preset is 'claude-uuid' (set by config)
      expect(agentPresetService.getActiveId()).toBe('claude-uuid');

      // Remove the currently active preset
      agentPresetService.removeActivePreset('claude-uuid');

      // activePresetId should have been repointed, not left stale
      expect(agentPresetService.getActiveId()).not.toBe('claude-uuid');
      expect(agentPresetService.getActive()?.id).toBe(secondPreset.id);

      // Should now be able to delete the removed preset (was previously blocked)
      expect(() => agentPresetService.delete('claude-uuid')).not.toThrow();
      expect(agentPresetService.get('claude-uuid')).toBeUndefined();
    });

    it('should clean up stale entries when preset is deleted', () => {
      mockUuid.mockReturnValue('temp-uuid');
      const newPreset = agentPresetService.create({
        name: 'Temp',
        openCommand: '',
        continueCommand: '',
        promptCommand: '',
        launchModes: [],
        isBuiltin: false,
      });
      agentPresetService.addActivePreset(newPreset.id);
      agentPresetService.delete(newPreset.id);
      expect(
        agentPresetService.getActivePresets().some((e: any) => e.presetId === newPreset.id)
      ).toBe(false);
    });
  });

  describe('notifications', () => {
    it('should notify renderer when config is saved', () => {
      const mockSend = vi.fn();
      vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
        { isDestroyed: () => false, webContents: { send: mockSend } } as any,
      ]);

      // Manually trigger notifyRenderer since it's private
      // @ts-ignore
      agentPresetService.notifyRenderer();

      expect(mockSend).toHaveBeenCalledWith('agent-presets:changed', expect.any(Object));
    });
  });
});
