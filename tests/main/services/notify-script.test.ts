import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/mock/home' } }));
vi.mock('../../../src/main/lib/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { generateNotifyScript } from '../../../src/main/services/notify-script';
import { buildOpenCodeNotifyPlugin } from '../../../src/main/services/opencode-settings.service';

describe('generateNotifyScript', () => {
  it('generates valid JavaScript', () => {
    const script = generateNotifyScript('/mock/.komla/port');
    // Strip the shebang line before parsing — Node ignores it but new Function() does not
    const body = script.replace(/^#!.*\n/, '');
    expect(() => new Script(body)).not.toThrow();
  });

  it('embeds the port file path', () => {
    const script = generateNotifyScript('/custom/path/port');
    expect(script).toContain('/custom/path/port');
  });

  it('uses forward slashes for Windows paths', () => {
    const script = generateNotifyScript('C:\\Users\\test\\.komla\\port');
    expect(script).toContain('C:/Users/test/.komla/port');
    expect(script).not.toContain('\\\\');
  });

  it('contains all agent kind mappings', () => {
    const script = generateNotifyScript('/mock/port');
    expect(script).toContain('permission_prompt');
    expect(script).toContain('elicitation_dialog');
    expect(script).toContain('idle_prompt');
    expect(script).toContain('ToolPermission');
    expect(script).toContain('turn-complete');
    expect(script).toContain('input-required');
  });

  it('handles all event types', () => {
    const script = generateNotifyScript('/mock/port');
    expect(script).toContain('"Stop"');
    expect(script).toContain('"UserPromptSubmit"');
    expect(script).toContain('"PermissionRequest"');
    expect(script).toContain('"BeforeAgent"');
    expect(script).toContain('"AfterAgent"');
  });

  it('defaults to IPv4 loopback but supports KOMLA_NOTIFY_HOST override', () => {
    const script = generateNotifyScript('/mock/port');
    expect(script).toContain('KOMLA_NOTIFY_HOST');
    expect(script).toContain('"127.0.0.1"');
    expect(script).not.toContain('"localhost"');
  });
});

describe('notify.js', () => {
  const directories: string[] = [];
  let server: Server | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  /** A local Komla recording what notify.js posts, and a folder holding notify.js. */
  async function startKomla() {
    const bodies: Record<string, any>[] = [];
    let received: (body: Record<string, any>) => void = () => {};
    const firstBody = new Promise<Record<string, any>>((resolve) => (received = resolve));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        bodies.push(JSON.parse(body));
        received(bodies[0]);
        res.end('{"success":true}');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const dir = await mkdtemp(join(tmpdir(), 'komla-notify-'));
    directories.push(dir);
    const script = join(dir, 'notify.js');
    await writeFile(script, generateNotifyScript(join(dir, 'port')));
    return { port: (server.address() as AddressInfo).port, dir, script, bodies, firstBody };
  }

  /** The environment of a hook outside any Komla terminal, reporting to the local Komla. */
  function hookEnv(port: number) {
    const env = { ...process.env, KOMLA_NOTIFY_PORT: String(port) };
    delete env.KOMLA_TERMINAL_ID;
    delete env.KOMLA_WORKSPACE_ID;
    delete env.KOMLA_NOTIFY_HOST;
    // Tests run by an agent mustn't look like a hook another runner runs.
    for (const name of [
      'GROK_HOOK_EVENT',
      'CURSOR_VERSION',
      'CURSOR_PROJECT_DIR',
      'DEVIN_PROJECT_DIR',
      'CLAUDE_JOB_DIR',
      'CLAUDE_CODE_ENTRYPOINT',
    ]) {
      delete env[name];
    }
    return env;
  }

  /** Runs notify.js against a local Komla, returning what it posted (if anything) and printed. */
  async function runNotify(args: string[], hookInput = '', extraEnv: Record<string, string> = {}) {
    const { port, script, bodies } = await startKomla();
    const env = { ...hookEnv(port), ...extraEnv };
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(process.execPath, [script, ...args], { env }, (error, out) =>
        error ? reject(error) : resolve(out)
      );
      child.stdin?.end(hookInput);
    });
    // The script exits once its request is sent, so wait until Komla has read it.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    return { posted: bodies[0], stdout };
  }

  it('reports an OpenCode failure with the message and folder the plugin passes', async () => {
    const { posted } = await runNotify(
      [
        '--source',
        'opencode',
        '--event',
        'StopFailure',
        '--cwd',
        '/work/app',
        '--message',
        'Rate limited',
      ],
      JSON.stringify({
        cwd: '/elsewhere',
        source: 'opencode',
        sessionID: 's1',
        error: 'Rate limited',
      })
    );

    expect(posted).toMatchObject({
      kind: 'error',
      source: 'opencode',
      cwd: '/work/app',
      message: 'Rate limited',
      hookInput: { hook_event_name: 'StopFailure', sessionID: 's1' },
    });
  });

  it.each([
    ['opencode', 'Interrupt'],
    ['claude-code', 'SessionEnd'],
  ])('reports %s %s as interrupted', async (source, event) => {
    const { posted } = await runNotify(['--source', source, '--event', event], '{}');

    expect(posted.kind).toBe('interrupted');
    expect(posted.hookInput.hook_event_name).toBe(event);
  });

  it('reports a failed Claude turn as an error with its details', async () => {
    const { posted } = await runNotify(
      ['--source', 'claude-code', '--event', 'StopFailure'],
      JSON.stringify({ session_id: 's1', last_assistant_message: ' ', error_details: 'Overloaded' })
    );

    expect(posted).toMatchObject({ kind: 'error', message: 'Overloaded' });
  });

  it('forwards the whole hook input, as the CLI does', async () => {
    const tasks = [{ type: 'subagent', status: 'running' }];
    const { posted } = await runNotify(
      ['--source', 'claude-code', '--event', 'Stop'],
      JSON.stringify({ session_id: 's1', prompt_id: 'p1', background_tasks: tasks })
    );

    expect(posted.kind).toBe('turn-complete');
    expect(posted.hookInput).toEqual({
      hook_event_name: 'Stop',
      session_id: 's1',
      prompt_id: 'p1',
      background_tasks: tasks,
    });
  });

  it('keeps only the identifying fields of an oversized hook input', async () => {
    const { posted } = await runNotify(
      ['--source', 'claude-code', '--event', 'Stop'],
      JSON.stringify({ session_id: 's1', transcript: 'x'.repeat(70 * 1024), message: 'Done' })
    );

    expect(posted.hookInput).toEqual({
      hook_event_name: 'Stop',
      session_id: 's1',
      message: 'Done',
    });
  });

  it('keeps the request id of an oversized permission request', async () => {
    const { posted } = await runNotify(
      ['--source', 'opencode', '--event', 'PermissionRequest'],
      JSON.stringify({ permissionID: 'per_1', tool_input: { command: 'x'.repeat(70 * 1024) } })
    );

    expect(posted.hookInput).toEqual({
      hook_event_name: 'PermissionRequest',
      permissionID: 'per_1',
    });
  });

  it("sends nothing for another agent's hook that Grok runs, which reports Grok's turn", async () => {
    const grok = { GROK_HOOK_EVENT: 'stop' };
    const claude = await runNotify(
      ['--source', 'claude-code', '--event', 'Stop'],
      JSON.stringify({ session_id: 's1' }),
      grok
    );
    expect(claude.posted).toBeUndefined();

    const own = await runNotify(
      ['--source', 'grok-build', '--event', 'Stop'],
      JSON.stringify({ session_id: 's1' }),
      grok
    );
    expect(own.posted).toMatchObject({ source: 'grok-build' });

    const byHand = await runNotify(['--source', 'agent', 'Deploy done'], '', grok);
    expect(byHand.posted).toMatchObject({ source: 'agent' });
  });

  it.each([
    ['Cursor', { CURSOR_VERSION: '3.1.0', CURSOR_PROJECT_DIR: '/repo' }, 'cursor'],
    ['Devin', { DEVIN_PROJECT_DIR: '/repo' }, 'devin'],
  ])("sends nothing for Claude's hooks that %s runs", async (_, runner, own) => {
    const claude = await runNotify(
      ['--source', 'claude-code', '--event', 'Stop'],
      JSON.stringify({ session_id: 's1' }),
      runner
    );
    expect(claude.posted).toBeUndefined();

    const ownHook = await runNotify(
      ['--source', own, '--event', 'Stop'],
      JSON.stringify({ session_id: 's1' }),
      runner
    );
    expect(ownHook.posted).toMatchObject({ source: own });
  });

  it.each([
    ['a background session', { CLAUDE_JOB_DIR: '/home/u/.claude/jobs/69f07811' }],
    ['print mode', { CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }],
  ])('sends nothing for Claude in %s', async (_, claudeEnv) => {
    const claude = await runNotify(
      ['--source', 'claude-code', '--event', 'Stop'],
      JSON.stringify({ session_id: 's1' }),
      claudeEnv
    );
    expect(claude.posted).toBeUndefined();

    const interactive = await runNotify(
      ['--source', 'claude-code', '--event', 'Stop'],
      JSON.stringify({ session_id: 's1' }),
      { CLAUDE_CODE_ENTRYPOINT: 'cli' }
    );
    expect(interactive.posted).toMatchObject({ kind: 'turn-complete' });
  });

  it("says what Claude's permission prompt asks, and reads its tool ends as activity", async () => {
    const question = await runNotify(
      ['--source', 'claude-code', '--event', 'PermissionRequest'],
      JSON.stringify({
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Red or blue?', header: 'Color' }] },
      })
    );
    expect(question.posted).toMatchObject({ kind: 'input-required', message: 'Red or blue?' });

    const edit = await runNotify(
      ['--source', 'claude-code', '--event', 'PermissionRequest'],
      JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: '/a' } })
    );
    expect(edit.posted).toMatchObject({ message: 'Claude needs approval for Edit' });

    for (const event of ['PostToolUse', 'PostToolUseFailure']) {
      const ended = await runNotify(
        ['--source', 'claude-code', '--event', event],
        JSON.stringify({ tool_name: 'Bash' })
      );
      expect(ended.posted).toMatchObject({ kind: 'activity' });
    }
  });

  it("forwards a tool end without the tool's output, which may be large", async () => {
    const { posted } = await runNotify(
      ['--source', 'claude-code', '--event', 'PostToolUse'],
      JSON.stringify({
        session_id: 's1',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: { stdout: 'x'.repeat(70 * 1024) },
      })
    );

    expect(posted.hookInput).toEqual({
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });
  });

  it('ends the turn on a manual compact and ignores an automatic one', async () => {
    const manual = await runNotify(
      ['--source', 'claude-code', '--event', 'PostCompact'],
      JSON.stringify({ session_id: 's1', trigger: 'manual' })
    );
    expect(manual.posted).toMatchObject({
      kind: 'turn-complete',
      message: 'Compacted the conversation',
      hookInput: { trigger: 'manual' },
    });

    const automatic = await runNotify(
      ['--source', 'claude-code', '--event', 'PostCompact'],
      JSON.stringify({ session_id: 's1', trigger: 'auto' })
    );
    expect(automatic.posted).toBeUndefined();
  });

  it.each([
    ['PreInvocation', {}, 'prompt-submit', '{}'],
    ['PreInvocation', { invocationNum: 2 }, 'activity', '{}'],
    ['PostToolUse', {}, 'activity', '{}'],
    ['Stop', {}, 'activity', '{"decision":"stop"}'],
    ['Stop', { fullyIdle: true }, 'turn-complete', '{"decision":"stop"}'],
  ])('answers Antigravity %s %j and reports it as %s', async (event, input, kind, reply) => {
    const { posted, stdout } = await runNotify(
      ['--source', 'antigravity', '--event', event],
      JSON.stringify({ ...input, workspacePaths: ['/work/agy'] })
    );

    expect(stdout.trim()).toBe(reply);
    expect(posted).toMatchObject({ kind, cwd: '/work/agy' });
  });

  it('sends the hook input once it parses, though the hook runner leaves stdin open', async () => {
    const { port, script, firstBody } = await startKomla();
    const child = spawn(
      process.execPath,
      [script, '--source', 'antigravity', '--event', 'PostToolUse'],
      { env: hookEnv(port) }
    );
    try {
      // Antigravity's reply shows notify.js has started, and so begun its 1 s wait for stdin.
      await once(child.stdout, 'data');
      const written = Date.now();
      child.stdin.write(JSON.stringify({ workspacePaths: ['/work/agy'] }));

      expect(await firstBody).toMatchObject({ kind: 'activity', cwd: '/work/agy' });
      expect(Date.now() - written).toBeLessThan(500);
    } finally {
      child.kill();
    }
  });

  it('lets the OpenCode plugin report through notify.js when Windows blocks the CLI', async () => {
    const { port, dir, script, firstBody } = await startKomla();
    vi.stubEnv('KOMLA_NOTIFY_PORT', String(port));
    vi.stubEnv('KOMLA_NOTIFY_HOST', '');
    vi.stubEnv('KOMLA_TERMINAL_ID', '');
    vi.stubEnv('KOMLA_WORKSPACE_ID', '');
    const nodePathFile = join(dir, 'node-path');
    await writeFile(nodePathFile, process.execPath);
    const pluginFile = join(dir, 'komla-notify.mjs');
    await writeFile(
      pluginFile,
      buildOpenCodeNotifyPlugin('/missing/komla', { nodePathFile, script })
    );
    const { default: definition } = await import(pathToFileURL(pluginFile).href);
    const plugin = await definition.server();

    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 's1' } } });

    expect(await firstBody).toMatchObject({
      kind: 'turn-complete',
      source: 'opencode',
      message: 'OpenCode finished',
      hookInput: { hook_event_name: 'Stop', sessionID: 's1' },
    });
  });

  it("routes OpenCode 2 reports by the session's folder, not the ids of the service's terminal", async () => {
    const { port, dir, script, firstBody } = await startKomla();
    vi.stubEnv('KOMLA_NOTIFY_PORT', String(port));
    vi.stubEnv('KOMLA_NOTIFY_HOST', '');
    // The shared service has the environment of the terminal that started it.
    vi.stubEnv('KOMLA_TERMINAL_ID', 'term-first');
    vi.stubEnv('KOMLA_WORKSPACE_ID', 'workspace-first');
    const nodePathFile = join(dir, 'node-path');
    await writeFile(nodePathFile, process.execPath);
    const pluginFile = join(dir, 'komla-notify.mjs');
    await writeFile(
      pluginFile,
      buildOpenCodeNotifyPlugin('/missing/komla', { nodePathFile, script })
    );
    const { default: definition } = await import(pathToFileURL(pluginFile).href);
    const controller = new AbortController();
    const cleanup = await definition.setup({
      location: { directory: '/work/service' },
      session: {
        get: async () => ({ location: { directory: '/work/app' } }),
        hook: async () => ({ dispose: async () => {} }),
      },
      tool: { hook: async () => ({ dispose: async () => {} }) },
      event: {
        async *subscribe() {
          yield { id: 'evt_1', type: 'session.execution.succeeded', data: { sessionID: 's1' } };
          await new Promise((resolve) => controller.signal.addEventListener('abort', resolve));
        },
      },
    });

    try {
      const body = await firstBody;
      expect(body).toMatchObject({
        kind: 'turn-complete',
        source: 'opencode',
        cwd: '/work/app',
        hookInput: { hook_event_name: 'Stop', sessionID: 's1' },
      });
      expect(body.terminalId).toBeUndefined();
      expect(body.workspaceId).toBeUndefined();
    } finally {
      cleanup();
      controller.abort();
    }
  });
});
