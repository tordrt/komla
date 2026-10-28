import { createServer, type Server } from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Grab real fs functions before mocking, for temp-dir setup in tests
const realFs = await vi.importActual<typeof import('fs')>('fs');
const realOs = await vi.importActual<typeof import('os')>('os');

// Module-level mocks required for importing settings services
vi.mock('os', () => ({ homedir: vi.fn(() => '/mock/home') }));
vi.mock('fs', () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, exec: vi.fn(), execFileSync: vi.fn() };
});
vi.mock('electron', () => ({ app: { getPath: vi.fn(() => '/mock/home') } }));
vi.mock('../../../src/main/lib/wsl', () => ({ isWslMode: vi.fn(() => false) }));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: vi.fn(() => ({})) },
}));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));
vi.mock('../../../src/main/lib/atomic-write', () => ({
  writeFileAtomicSync: vi.fn(),
}));

/** Spawn the notify.js script with the given flags. */
function spawnNotifyScript(opts: {
  source: string;
  event: string;
  stdin?: string;
  closeStdin?: boolean;
  inputMode?: string;
  args?: string[];
  tmpDataDir: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: number | null }> {
  const { closeStdin = true, inputMode = 'stdin' } = opts;
  return new Promise((resolve, reject) => {
    const baseEnv = { ...process.env };
    delete baseEnv.KOMLA_NOTIFY_HOST;
    delete baseEnv.KOMLA_NOTIFY_PORT;
    const scriptPath = join(opts.tmpDataDir, 'notify.js');
    const nodeArgs = [
      scriptPath,
      '--source',
      opts.source,
      '--event',
      opts.event,
      '--input',
      inputMode,
      ...(opts.args ?? []),
    ];
    const proc: ChildProcess = spawn('node', nodeArgs, {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...baseEnv, ...(opts.env ?? {}) },
    });

    if (opts.stdin !== undefined) proc.stdin!.write(opts.stdin);
    if (closeStdin) proc.stdin!.end();

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Hook script did not exit within ${opts.timeoutMs ?? 15_000} ms`));
    }, opts.timeoutMs ?? 15_000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code });
    });
  });
}

describe('Hook script behavior', () => {
  let server: Server;
  let port: number;
  let receivedPayloads: Record<string, unknown>[];
  let tmpDataDir: string;

  beforeEach(async () => {
    vi.resetModules();
    receivedPayloads = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        try {
          receivedPayloads.push(JSON.parse(body));
        } catch {}
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    port = typeof addr === 'object' && addr !== null ? addr.port : 0;

    // Create a temp directory to act as KOMLA_DATA_DIR and write the port file
    tmpDataDir = realFs.mkdtempSync(join(realOs.tmpdir(), 'komla-hook-test-'));
    process.env.KOMLA_DATA_DIR = tmpDataDir;
    realFs.writeFileSync(join(tmpDataDir, 'port'), String(port));

    // Write the shared notify.js script
    const { generateNotifyScript } = await import('../../../src/main/services/notify-script');
    realFs.writeFileSync(
      join(tmpDataDir, 'notify.js'),
      generateNotifyScript(join(tmpDataDir, 'port'))
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    delete process.env.KOMLA_DATA_DIR;
    try {
      realFs.rmSync(tmpDataDir, { recursive: true, force: true });
    } catch {}
  });

  /** Give the event loop time to process in-flight HTTP on the server side. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

  /**
   * Write a wrong port to the port file so the hook connects to an unreachable server. Nothing
   * listens on port 1, while port + 1 is often the next test server's port in another worker.
   */
  function writeUnreachablePort(): void {
    realFs.writeFileSync(join(tmpDataDir, 'port'), '1');
  }

  function writePortContent(content: string): void {
    realFs.writeFileSync(join(tmpDataDir, 'port'), content);
  }

  // ── Claude Code ────────────────────────────────────────────────────

  describe('Claude Code hook', () => {
    it('sends notification with correct payload on normal stdin', async () => {
      const data = JSON.stringify({
        cwd: '/test/project',
        notification_type: 'idle_prompt',
        message: 'Task complete',
      });

      const { code } = await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        cwd: '/test/project',
        kind: 'idle',
        source: 'claude-code',
        message: 'Task complete',
      });
    });

    it('includes Komla workspace and terminal IDs from the environment', async () => {
      const data = JSON.stringify({
        cwd: '/test/project',
        notification_type: 'idle_prompt',
      });

      const { code } = await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: data,
        tmpDataDir,
        env: {
          KOMLA_WORKSPACE_ID: 'ws-1',
          KOMLA_TERMINAL_ID: 'term-1',
        },
      });
      await flush();

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        workspaceId: 'ws-1',
        terminalId: 'term-1',
        cwd: '/test/project',
      });
    });

    it('maps permission_prompt to input-required kind', async () => {
      const data = JSON.stringify({
        notification_type: 'permission_prompt',
        message: 'Approve?',
      });

      await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].kind).toBe('input-required');
    });

    it('maps unknown notification_type to generic kind', async () => {
      const data = JSON.stringify({ notification_type: 'something_else' });

      await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].kind).toBe('generic');
    });

    it('fires after 1s safety timeout when stdin stays open', async () => {
      const { code } = await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        closeStdin: false,
        tmpDataDir,
      });
      await flush();

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].source).toBe('claude-code');
    }, 10_000);

    it('exits with code 0 when server is unreachable', async () => {
      writeUnreachablePort();

      const { code } = await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: '{}',
        tmpDataDir,
      });

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(0);
    });

    it('exits before waiting for the notification response body', async () => {
      server.removeAllListeners('request');
      server.on('request', (req, res) => {
        let body = '';
        req.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          try {
            receivedPayloads.push(JSON.parse(body));
          } catch {}
          setTimeout(() => {
            res.writeHead(200);
            res.end();
          }, 1500);
        });
      });

      const startedAt = Date.now();
      const { code } = await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: '{}',
        tmpDataDir,
      });
      const elapsedMs = Date.now() - startedAt;
      await flush();

      expect(code).toBe(0);
      expect(elapsedMs).toBeLessThan(1000);
      expect(receivedPayloads).toHaveLength(1);
    });

    it('exits with code 0 when port file contains garbage', async () => {
      writePortContent('not-a-port');

      const { code } = await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: '{}',
        tmpDataDir,
      });

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(0);
    });

    it('exits with code 0 when port file is empty', async () => {
      writePortContent('');

      const { code } = await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: '{}',
        tmpDataDir,
      });

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(0);
    });

    it('sends exactly one notification even when both stdin end and timeout fire', async () => {
      const data = JSON.stringify({ message: 'once' });

      await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: data,
        tmpDataDir,
      });
      // Wait past the 1s setTimeout to ensure the done-guard prevented a second send
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(receivedPayloads).toHaveLength(1);
    }, 10_000);

    it('maps Stop event to turn-complete kind', async () => {
      const data = JSON.stringify({ message: 'Done working' });

      await spawnNotifyScript({
        source: 'claude-code',
        event: 'Stop',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        kind: 'turn-complete',
        source: 'claude-code',
        message: 'Done working',
      });
    });

    it('maps Stop event with no message to default message', async () => {
      await spawnNotifyScript({
        source: 'claude-code',
        event: 'Stop',
        stdin: '{}',
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].kind).toBe('turn-complete');
      expect(receivedPayloads[0].message).toBe('Claude finished');
    });

    it('caps long Stop messages below the server validation limit', async () => {
      const longMessage = 'A'.repeat(70_000);

      await spawnNotifyScript({
        source: 'claude-code',
        event: 'Stop',
        stdin: JSON.stringify({ message: longMessage }),
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      const msg = receivedPayloads[0].message as string;
      expect(msg.length).toBe(8192);
      expect(msg.endsWith('...')).toBe(true);
    });

    it('maps UserPromptSubmit event to prompt-submit kind', async () => {
      const data = JSON.stringify({ prompt: 'Fix the bug' });

      await spawnNotifyScript({
        source: 'claude-code',
        event: 'UserPromptSubmit',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        kind: 'prompt-submit',
        source: 'claude-code',
        message: 'Fix the bug',
      });
    });

    it('maps elicitation_dialog to input-required kind', async () => {
      const data = JSON.stringify({
        notification_type: 'elicitation_dialog',
        message: 'Choose an option',
      });

      await spawnNotifyScript({
        source: 'claude-code',
        event: 'Notification',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].kind).toBe('input-required');
    });
  });

  // ── Gemini ─────────────────────────────────────────────────────────

  describe('Gemini hook', () => {
    it('sends notification with gemini source and correct kind mapping', async () => {
      const data = JSON.stringify({
        cwd: '/gem/project',
        notification_type: 'ToolPermission',
        message: 'Allow tool?',
      });

      const { code } = await spawnNotifyScript({
        source: 'gemini',
        event: 'Notification',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        cwd: '/gem/project',
        kind: 'input-required',
        source: 'gemini',
        message: 'Allow tool?',
      });
    });

    it('maps Gemini BeforeTool to activity and preserves session metadata', async () => {
      await spawnNotifyScript({
        source: 'gemini',
        event: 'BeforeTool',
        stdin: JSON.stringify({ session_id: 'gemini-root', tool_name: 'read_file' }),
        tmpDataDir,
      });
      await flush();
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        kind: 'activity',
        source: 'gemini',
        hookInput: { session_id: 'gemini-root', hook_event_name: 'BeforeTool' },
      });
    });

    it('maps AfterAgent event to turn-complete kind', async () => {
      const data = JSON.stringify({
        cwd: '/gem/project',
        message: 'Agent finished',
      });

      await spawnNotifyScript({
        source: 'gemini',
        event: 'AfterAgent',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        kind: 'turn-complete',
        source: 'gemini',
        message: 'Agent finished',
      });
    });

    it('maps BeforeAgent event to prompt-submit kind with prompt message', async () => {
      const data = JSON.stringify({
        cwd: '/gem/project',
        prompt: 'Refactor the auth module',
      });

      await spawnNotifyScript({
        source: 'gemini',
        event: 'BeforeAgent',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        kind: 'prompt-submit',
        source: 'gemini',
        message: 'Refactor the auth module',
      });
    });

    it('maps Gemini error to message field', async () => {
      const data = JSON.stringify({
        error: 'Something went wrong',
      });

      await spawnNotifyScript({
        source: 'gemini',
        event: 'Notification',
        stdin: data,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].message).toBe('Something went wrong');
    });
  });

  // ── Codex (legacy argv / notify mechanism) ─────────────────────────

  describe('Codex hook (legacy argv)', () => {
    it('sends notification from argv data', async () => {
      const argvData = JSON.stringify({
        cwd: '/codex/project',
        message: 'Codex done',
        type: 'completed',
      });

      const { code } = await spawnNotifyScript({
        source: 'codex',
        event: 'Notification',
        inputMode: 'argv',
        args: [argvData],
        tmpDataDir,
      });
      await flush();

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        cwd: '/codex/project',
        kind: 'turn-complete',
        source: 'codex',
      });
    });

    it('exits with code 0 when server is unreachable', async () => {
      writeUnreachablePort();
      const { code } = await spawnNotifyScript({
        source: 'codex',
        event: 'Notification',
        inputMode: 'argv',
        args: ['{}'],
        tmpDataDir,
      });

      expect(code).toBe(0);
    });

    it('extracts cwd from input-messages', async () => {
      const argvData = JSON.stringify({
        'input-messages': [{ content: 'Working in <cwd>/my/project</cwd>' }],
        message: 'Done',
      });

      await spawnNotifyScript({
        source: 'codex',
        event: 'Notification',
        inputMode: 'argv',
        args: [argvData],
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].cwd).toBe('/my/project');
    });

    it('truncates long messages to 160 chars', async () => {
      const longMessage = 'A'.repeat(200);
      const argvData = JSON.stringify({
        cwd: '/codex/project',
        'last-assistant-message': longMessage,
      });

      await spawnNotifyScript({
        source: 'codex',
        event: 'Notification',
        inputMode: 'argv',
        args: [argvData],
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      const msg = receivedPayloads[0].message as string;
      expect(msg.length).toBe(160);
      expect(msg.endsWith('...')).toBe(true);
    });
  });

  // ── Codex (new hooks.json / stdin mechanism) ──────────────────────

  describe('Codex hook (hooks.json stdin)', () => {
    it('sends turn-complete from Stop event via stdin', async () => {
      const stdinData = JSON.stringify({
        session_id: 'sess-123',
        cwd: '/codex/project',
        hook_event_name: 'Stop',
        model: 'o3',
        turn_id: 'turn-1',
        last_assistant_message: 'All tests pass now.',
      });

      const { code } = await spawnNotifyScript({
        source: 'codex',
        event: 'Stop',
        stdin: stdinData,
        tmpDataDir,
      });
      await flush();

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        cwd: '/codex/project',
        kind: 'turn-complete',
        source: 'codex',
        message: 'All tests pass now.',
      });
    });

    it('sends prompt-submit from UserPromptSubmit event via stdin', async () => {
      const stdinData = JSON.stringify({
        session_id: 'sess-123',
        cwd: '/codex/project',
        hook_event_name: 'UserPromptSubmit',
        model: 'o3',
        turn_id: 'turn-1',
        prompt: 'Fix the failing test in auth.test.ts',
      });

      const { code } = await spawnNotifyScript({
        source: 'codex',
        event: 'UserPromptSubmit',
        stdin: stdinData,
        tmpDataDir,
      });
      await flush();

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        cwd: '/codex/project',
        kind: 'prompt-submit',
        source: 'codex',
        message: 'Fix the failing test in auth.test.ts',
      });
    });

    it('sends input-required from PermissionRequest event via stdin', async () => {
      const stdinData = JSON.stringify({
        session_id: 'sess-123',
        cwd: '/codex/project',
        hook_event_name: 'PermissionRequest',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_input: {
          command: 'npm test',
          description: 'Run tests outside the sandbox',
        },
      });

      const { code } = await spawnNotifyScript({
        source: 'codex',
        event: 'PermissionRequest',
        stdin: stdinData,
        tmpDataDir,
      });
      await flush();

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        cwd: '/codex/project',
        kind: 'input-required',
        source: 'codex',
        message: 'Run tests outside the sandbox',
      });
    });

    it('labels OpenCode permission request fallbacks correctly', async () => {
      const stdinData = JSON.stringify({
        cwd: '/opencode/project',
        tool_name: 'bash',
      });

      await spawnNotifyScript({
        source: 'opencode',
        event: 'PermissionRequest',
        stdin: stdinData,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        cwd: '/opencode/project',
        kind: 'input-required',
        source: 'opencode',
        message: 'OpenCode needs approval for bash',
      });
    });

    it('falls back to "Agent finished" when no message in Stop event', async () => {
      const stdinData = JSON.stringify({
        cwd: '/codex/project',
        hook_event_name: 'Stop',
      });

      await spawnNotifyScript({
        source: 'codex',
        event: 'Stop',
        stdin: stdinData,
        tmpDataDir,
      });
      await flush();

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0].message).toBe('Agent finished');
    });
  });

  // ── OpenCode ────────────────────────────────────────────────────────

  describe('OpenCode hook', () => {
    it('sends idle notification via argv', async () => {
      const argvData = JSON.stringify({
        cwd: '/opencode/project',
        kind: 'idle',
        source: 'opencode',
        message: 'OpenCode is idle',
      });

      const { code } = await spawnNotifyScript({
        source: 'opencode',
        event: 'Notification',
        inputMode: 'argv',
        args: [argvData],
        tmpDataDir,
      });
      await flush();

      expect(code).toBe(0);
      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toMatchObject({
        cwd: '/opencode/project',
        kind: 'idle',
        source: 'opencode',
        message: 'OpenCode is idle',
      });
    });
  });
});
