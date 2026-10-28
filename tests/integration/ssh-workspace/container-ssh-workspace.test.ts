/**
 * Real-SSH integration tests backed by a disposable Debian container.
 *
 * `docker exec` is used only for fixture setup and assertions. Every Komla
 * operation below connects through the container's actual OpenSSH server
 * using the same service paths as the app.
 *
 * Run with: npm run test:integration
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createWorkspace } from '../../factories';
import { mockElectron } from '../../mocks/electron';

import {
  setupTestContainer,
  teardownTestContainer,
  type SshWorkspaceTestTarget,
  type TestContainerHandle,
} from './container-fixture';

import type { SshHost, SshWorkspaceBackend, Workspace } from '../../../src/shared/types';

vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/services/http-server.service', () => ({
  httpServerService: { getActualPort: () => 54183, waitForActualPort: async () => 54183 },
}));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: { getMainWindowId: () => 'main-window' },
}));

const execFileAsync = promisify(execFile);

type SshWorkspaceModule = typeof import('../../../src/main/services/ssh-workspace.service');
type SshWorkspaceGitModule = typeof import('../../../src/main/services/workspace-git/ssh-git');
type SshPortForwardModule = typeof import('../../../src/main/services/ssh-port-forward.service');
type SshHostModule = typeof import('../../../src/main/services/ssh-host.service');
type DatabaseModule = typeof import('../../../src/main/services/database.service');
type LocalMirrorModule = typeof import('../../../src/main/services/local-mirror.service');
type RemoteCompanionModule = typeof import('../../../src/main/services/remote-companion.service');

let container: TestContainerHandle;
let target: SshWorkspaceTestTarget;
let sshWorkspaceModule: SshWorkspaceModule;
let sshWorkspaceGitModule: SshWorkspaceGitModule;
let sshPortForwardModule: SshPortForwardModule;
let sshHostModule: SshHostModule;
let databaseModule: DatabaseModule;
let localMirrorModule: LocalMirrorModule;
let remoteCompanionModule: RemoteCompanionModule;

beforeAll(async () => {
  container = await setupTestContainer();
  target = container.target;

  // Import only after the fixture has selected its isolated KOMLA_DATA_DIR.
  [
    sshWorkspaceModule,
    sshWorkspaceGitModule,
    sshPortForwardModule,
    sshHostModule,
    databaseModule,
    localMirrorModule,
    remoteCompanionModule,
  ] = await Promise.all([
    import('../../../src/main/services/ssh-workspace.service'),
    import('../../../src/main/services/workspace-git/ssh-git'),
    import('../../../src/main/services/ssh-port-forward.service'),
    import('../../../src/main/services/ssh-host.service'),
    import('../../../src/main/services/database.service'),
    import('../../../src/main/services/local-mirror.service'),
    import('../../../src/main/services/remote-companion.service'),
  ]);
  sshHostModule.sshHostService.save(target.host);
}, 15 * 60_000);

afterAll(async () => {
  if (sshPortForwardModule) {
    await sshPortForwardModule.sshPortForwardService.dispose();
  }
  if (localMirrorModule) {
    await localMirrorModule.localMirrorService.remove('ssh-integration-mirror').catch(() => {});
  }
  if (sshHostModule && target) {
    sshHostModule.sshHostService.delete(target.host.id);
  }
  if (databaseModule) {
    databaseModule.databaseService.close();
  }
  if (container) {
    await teardownTestContainer(container);
  }
});

describe('SSH remote workspace through Docker OpenSSH', () => {
  it(
    'uploads a local .env into the remote worktree through workspace Setup',
    async () => {
      const dataDir = process.env.KOMLA_DATA_DIR;
      if (!dataDir) throw new Error('KOMLA_DATA_DIR is required for SSH integration tests');

      const sourcePath = join(dataDir, 'setup upload $source');
      mkdirSync(sourcePath, { recursive: true });
      await execFileAsync('git', ['init', '-q', '-b', 'main', sourcePath]);
      writeFileSync(join(sourcePath, 'README.md'), 'setup upload integration fixture\n');
      await execFileAsync('git', [
        '-C',
        sourcePath,
        '-c',
        'user.name=Komla Integration',
        '-c',
        'user.email=integration@komla.test',
        'add',
        'README.md',
      ]);
      await execFileAsync('git', [
        '-C',
        sourcePath,
        '-c',
        'user.name=Komla Integration',
        '-c',
        'user.email=integration@komla.test',
        'commit',
        '-q',
        '-m',
        'Initial setup upload fixture',
      ]);
      await execFileAsync('git', ['-C', sourcePath, 'remote', 'add', 'origin', target.originUrl]);

      const expectedContents = 'SECRET_VALUE=from local project folder\n';
      writeFileSync(join(sourcePath, '.env'), expectedContents);

      const identityFile = target.host.identityFile;
      if (!identityFile) throw new Error('SSH integration identity file is required');
      const agentOutput = (await execFileAsync('ssh-agent', ['-s'])).stdout;
      const authSock = /SSH_AUTH_SOCK=([^;]+)/.exec(agentOutput)?.[1];
      const agentPid = /SSH_AGENT_PID=([^;]+)/.exec(agentOutput)?.[1];
      if (!authSock || !agentPid) throw new Error('Could not start the SSH integration agent');

      const askpass = join(dataDir, 'setup-upload-askpass');
      writeFileSync(askpass, ['#!/bin/sh', "printf '%s\\n' yes", ''].join('\n'));
      chmodSync(askpass, 0o700);

      const previousSshEnvironment = {
        SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
        SSH_AGENT_PID: process.env.SSH_AGENT_PID,
        SSH_ASKPASS: process.env.SSH_ASKPASS,
        SSH_ASKPASS_REQUIRE: process.env.SSH_ASKPASS_REQUIRE,
        DISPLAY: process.env.DISPLAY,
      };
      process.env.SSH_AUTH_SOCK = authSock;
      process.env.SSH_AGENT_PID = agentPid;
      process.env.SSH_ASKPASS = askpass;
      process.env.SSH_ASKPASS_REQUIRE = 'force';
      process.env.DISPLAY = 'komla-ssh-integration';
      await execFileAsync('ssh-add', [identityFile], { env: process.env });

      const [{ projectService }, { workspaceService }] = await Promise.all([
        import('../../../src/main/services/project.service'),
        import('../../../src/main/services/workspace.service'),
      ]);
      let projectId: string | undefined;
      let workspaceId: string | undefined;
      try {
        const project = await projectService.create({
          kind: 'git',
          name: 'SSH setup upload integration',
          repositoryPath: sourcePath,
          defaultBranchPrefix: '',
          baseBranch: 'main',
        });
        projectId = project.id;
        await projectService.update(project.id, {
          setupSteps: [
            {
              id: 'upload-env',
              name: 'Upload .env to SSH workspace',
              command:
                // Use the test agent even if the user's ssh_config pins another IdentityAgent.
                'scp -o IdentityAgent=SSH_AUTH_SOCK -P {{sshPort}} "{{localProjectPath}}/.env" "{{sshTarget}}:{{workspacePath}}/.env"',
              placement: 'background',
              destination: 'ssh-local-copy',
              trigger: 'workspace-creation',
            },
          ],
        });

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: project.id,
          branchName: 'integration/setup-upload',
          useExactBranchName: true,
          initialCommand: 'exit',
          location: { kind: 'ssh', hostId: target.host.id },
        });
        workspaceId = workspace.id;

        try {
          await expect
            .poll(
              () =>
                workspaceService
                  .get(workspace.id)
                  ?.setupActivities?.find((activity) => activity.stepId === 'upload-env')?.state,
              { timeout: 15_000 }
            )
            .toBe('succeeded');
        } catch {
          const activity = workspaceService
            .get(workspace.id)
            ?.setupActivities?.find((candidate) => candidate.stepId === 'upload-env');
          throw new Error(`Upload Setup did not succeed: ${JSON.stringify(activity)}`);
        }

        const uploaded = await container.exec(['cat', `${workspace.backend.remoteDirectory}/.env`]);
        expect(uploaded.stdout).toBe(expectedContents);
      } finally {
        if (workspaceId) {
          await workspaceService.delete(workspaceId, true, true).catch(() => undefined);
        }
        if (projectId) await projectService.delete(projectId).catch(() => undefined);
        await execFileAsync('ssh-agent', ['-k'], { env: process.env }).catch(() => undefined);
        for (const [key, value] of Object.entries(previousSshEnvironment)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
    2 * 60_000
  );

  it(
    'keeps a successful visible Setup step open as an interactive remote shell',
    async () => {
      const dataDir = process.env.KOMLA_DATA_DIR;
      if (!dataDir) throw new Error('KOMLA_DATA_DIR is required for SSH integration tests');

      const sourcePath = join(dataDir, 'visible setup source');
      mkdirSync(sourcePath, { recursive: true });
      await execFileAsync('git', ['init', '-q', '-b', 'main', sourcePath]);
      writeFileSync(join(sourcePath, 'README.md'), 'visible setup integration fixture\n');
      await execFileAsync('git', [
        '-C',
        sourcePath,
        '-c',
        'user.name=Komla Integration',
        '-c',
        'user.email=integration@komla.test',
        'add',
        'README.md',
      ]);
      await execFileAsync('git', [
        '-C',
        sourcePath,
        '-c',
        'user.name=Komla Integration',
        '-c',
        'user.email=integration@komla.test',
        'commit',
        '-q',
        '-m',
        'Initial visible setup fixture',
      ]);
      await execFileAsync('git', ['-C', sourcePath, 'remote', 'add', 'origin', target.originUrl]);

      const [{ projectService }, { workspaceService }, { ptyService }] = await Promise.all([
        import('../../../src/main/services/project.service'),
        import('../../../src/main/services/workspace.service'),
        import('../../../src/main/services/pty.service'),
      ]);
      let projectId: string | undefined;
      let workspaceId: string | undefined;
      try {
        const project = await projectService.create({
          kind: 'git',
          name: 'Visible SSH setup integration',
          repositoryPath: sourcePath,
          defaultBranchPrefix: '',
          baseBranch: 'main',
        });
        projectId = project.id;
        await projectService.update(project.id, {
          setupSteps: [
            {
              id: 'visible-setup',
              name: 'Visible SSH setup',
              command: 'printf ready > .komla-visible-setup-ready',
              placement: 'tab',
              destination: 'ssh-workspace-repository',
              trigger: 'workspace-creation',
            },
          ],
        });

        const workspace = await workspaceService.create({
          mode: 'worktree',
          projectId: project.id,
          branchName: 'integration/visible-setup',
          useExactBranchName: true,
          initialCommand: 'exit',
          location: { kind: 'ssh', hostId: target.host.id },
        });
        workspaceId = workspace.id;
        const setupTerminal = workspace.terminals.find(
          (terminal) => terminal.name === 'Visible SSH setup'
        );
        if (!setupTerminal) throw new Error('Visible Setup terminal was not created');

        await waitForContainerCondition([
          'test',
          '-f',
          `${workspace.backend.remoteDirectory}/.komla-visible-setup-ready`,
        ]);
        await expect
          .poll(
            async () =>
              (
                await sshWorkspaceModule.sshWorkspaceService.findTerminalSessions(
                  workspace.backend,
                  [setupTerminal.id]
                )
              ).has(setupTerminal.id),
            { timeout: 10_000 }
          )
          .toBe(true);

        ptyService.write(
          setupTerminal.id,
          'printf interactive > .komla-visible-setup-interactive\r'
        );
        await waitForContainerCondition([
          'test',
          '-f',
          `${workspace.backend.remoteDirectory}/.komla-visible-setup-interactive`,
        ]);
      } finally {
        if (workspaceId) {
          await workspaceService.delete(workspaceId, true, true).catch(() => undefined);
        }
        if (projectId) await projectService.delete(projectId).catch(() => undefined);
      }
    },
    2 * 60_000
  );

  it(
    'prepares the host and completes the remote workspace lifecycle',
    async () => {
      const { sshWorkspaceService } = sshWorkspaceModule;
      const setup = await sshWorkspaceService.verifyAndPrepareHost(target.host);

      expect(setup).toMatchObject({
        ok: true,
        prepared: true,
        resolvedBasePath: target.resolvedBasePath,
        git: { status: 'available' },
        monitoring: { status: 'available', missingRequirements: [] },
        tmux: { status: 'available' },
        localMirror: { localRsync: 'available', remoteRsync: 'available' },
      });
      expect(setup.notifyScriptPath).toBe(`${target.resolvedBasePath}/helpers/notify.sh`);

      const plan = sshWorkspaceService.createWorkspacePlan({
        hostId: target.host.id,
        gitUrl: target.originUrl,
        projectId: 'ssh-integration-project',
        projectName: 'ssh-integration-project',
        branchName: 'agent/real-ssh-test',
        baseBranch: 'main',
        resolvedBasePath: setup.resolvedBasePath,
      });
      const backend = plan.backend;

      const firstSetup = await sshWorkspaceService.ensureWorkspaceReady(backend);
      expect(firstSetup).toEqual({
        createdBranch: true,
        createdWorktree: true,
      });
      await expect(sshWorkspaceService.ensureWorkspaceReady(backend)).resolves.toEqual({
        createdBranch: false,
        createdWorktree: false,
      });

      const branch = await container.exec([
        'git',
        '-C',
        backend.remoteDirectory,
        'branch',
        '--show-current',
      ]);
      expect(branch.stdout.trim()).toBe('agent/real-ssh-test');

      const terminalId = 'ssh-integration-terminal';
      const terminalCommand = sshWorkspaceService.buildTerminalCommand(
        backend,
        'printf "%s|%s" "$KOMLA_TERMINAL_ID" "$PWD" > .komla-terminal-proof',
        terminalId,
        'ssh-integration-workspace',
        'start'
      );
      await execFileAsync('/bin/sh', ['-lc', terminalCommand], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });

      const terminalProof = await container.exec([
        'cat',
        `${backend.remoteDirectory}/.komla-terminal-proof`,
      ]);
      expect(terminalProof.stdout).toBe(`${terminalId}|${backend.remoteDirectory}`);

      await sshWorkspaceService.deleteWorkspace(backend, true, backend.branchName);
      const worktreeExists = await container.exec(['test', '-e', backend.remoteDirectory], {
        allowFailure: true,
      });
      expect(worktreeExists.exitCode).not.toBe(0);
      const branchExists = await container.exec(
        [
          'git',
          `--git-dir=${backend.remoteRepoPath}`,
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${backend.branchName}`,
        ],
        { allowFailure: true }
      );
      expect(branchExists.exitCode).not.toBe(0);
    },
    2 * 60_000
  );

  it('checks out an existing branch with upstream tracking through real SSH', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const branchName = 'integration/existing';
    const originPath = `${target.remoteHome}/.komla-ssh-integration-fixture/origin.git`;
    await container.exec(['git', `--git-dir=${originPath}`, 'branch', branchName, 'main']);

    const plan = sshWorkspaceService.createWorkspacePlan({
      hostId: target.host.id,
      gitUrl: target.originUrl,
      projectId: 'ssh-integration-existing',
      projectName: 'ssh-integration-existing',
      branchName,
      baseBranch: 'deleted-base',
      checkoutExistingBranch: true,
      resolvedBasePath: target.resolvedBasePath,
    });
    const backend = plan.backend;

    try {
      await expect(sshWorkspaceService.ensureWorkspaceReady(backend)).resolves.toEqual({
        createdBranch: false,
        createdWorktree: true,
      });
      const upstream = await container.exec([
        'git',
        '-C',
        backend.remoteDirectory,
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
      ]);
      expect(upstream.stdout.trim()).toBe(`origin/${branchName}`);

      await container.exec([
        'sh',
        '-lc',
        'printf "existing branch push\n" > "$1/existing.txt"; git -C "$1" add existing.txt; git -C "$1" commit -q -m "Update existing branch"; git -C "$1" push -q',
        'sh',
        backend.remoteDirectory,
      ]);
      const pushed = await container.exec([
        'git',
        `--git-dir=${originPath}`,
        'show',
        `${branchName}:existing.txt`,
      ]);
      expect(pushed.stdout).toBe('existing branch push\n');
    } finally {
      await sshWorkspaceService.deleteWorkspace(backend, true, branchName).catch(() => {});
    }
  }, 60_000);

  it('carries host-scoped HTTP traffic through the real reverse SSH tunnel', async () => {
    const { sshWorkspaceService, remoteKomlaDataPort } = sshWorkspaceModule;
    const { sshPortForwardService } = sshPortForwardModule;
    await sshWorkspaceService.verifyAndPrepareHost(target.host);
    const backend = await createPreparedWorkspace('settings-identity');
    const terminalId = 'ssh-integration-settings-terminal';
    const workspaceId = 'ssh-integration-settings-workspace';
    let server: Server | undefined;
    let received:
      | {
          path?: string;
          terminalId?: string;
          workspaceId?: string;
          hostId?: string;
        }
      | undefined;

    try {
      server = createServer((request, response) => {
        const scopedMatch = /^\/terminals\/([^/]+)(\/settings\/.*)$/.exec(request.url ?? '');
        if (scopedMatch) {
          received = {
            path: request.url,
            terminalId: decodeURIComponent(scopedMatch[1]),
            workspaceId: request.headers['x-komla-workspace-id'] as string | undefined,
            hostId: request.headers['x-komla-ssh-host-id'] as string | undefined,
          };
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end('{"scope":"current-project","actions":[]}');
      });
      await listenOnLoopback(server);
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Could not determine the host integration server port');
      }

      await sshPortForwardService.ensureKomlaDataTunnel(target.host.id, address.port);
      const remoteUrl = `http://127.0.0.1:${remoteKomlaDataPort(target.host.id)}/from-container`;

      const responsePath = '/tmp/ssh-integration-settings-response.json';
      const terminalCommand = sshWorkspaceService.buildTerminalCommand(
        backend,
        `curl -fsS "$KOMLA_API_URL/settings/actions?scope=current-project" > ${responsePath}`,
        terminalId,
        workspaceId,
        'start'
      );
      await execFileAsync('/bin/sh', ['-lc', terminalCommand], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      // A command can finish before Komla attaches to its tmux session, which then
      // shows no output, so read the response on the host instead of from the terminal.
      await vi.waitFor(async () => {
        const saved = await container.exec(['cat', responsePath], { allowFailure: true });
        expect(saved.stdout).toBe('{"scope":"current-project","actions":[]}');
      });
      expect(received).toEqual({
        path: `/terminals/${terminalId}/settings/actions?scope=current-project`,
        terminalId,
        workspaceId: undefined,
        hostId: target.host.id,
      });

      // Any process on the host can reach the tunnel, so the gateway only
      // forwards the routes the remote helper uses.
      const direct = await container.exec(
        ['curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', remoteUrl],
        { allowFailure: true }
      );
      expect(direct.stdout).toBe('404');
      const health = await container.exec(
        [
          'curl',
          '-sS',
          '-o',
          '/dev/null',
          '-w',
          '%{http_code}',
          `http://127.0.0.1:${remoteKomlaDataPort(target.host.id)}/api/v1/health`,
        ],
        { allowFailure: true }
      );
      expect(health.stdout).toBe('200');
    } finally {
      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]).catch(() => {});
      await sshWorkspaceService.deleteWorkspace(backend, true, backend.branchName).catch(() => {});
      await sshPortForwardService.stopKomlaDataTunnel(target.host.id);
      if (server) await closeServer(server);
    }
  }, 60_000);

  it('delivers notifications from the installed remote helper through the real SSH tunnel', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const { sshPortForwardService } = sshPortForwardModule;
    await sshWorkspaceService.verifyAndPrepareHost(target.host);
    const backend = await createPreparedWorkspace('notification-helper');
    const workspaceId = 'ssh-integration-notification-workspace';
    const terminalId = 'ssh-integration-notification-terminal';
    let server: Server | undefined;

    try {
      const deliveries: StatusDelivery[] = [];
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          deliveries.push({
            path: request.url,
            payload: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            hostId: request.headers['x-komla-ssh-host-id'] as string | undefined,
          });
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"success":true}');
        });
      });
      await listenOnLoopback(server);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected integration port');

      await sshPortForwardService.ensureKomlaDataTunnel(target.host.id, address.port);
      const notifyScriptPath = `${target.resolvedBasePath}/helpers/notify.sh`;
      const terminalCommand = sshWorkspaceService.buildTerminalCommand(
        backend,
        `printf '%s' '{"prompt":"Review remote workspace"}' | sh '${notifyScriptPath}' --source claude-code --event UserPromptSubmit`,
        terminalId,
        workspaceId,
        'start'
      );
      await execFileAsync('/bin/sh', ['-lc', terminalCommand], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });

      const delivery = await waitForStatusDelivery(
        deliveries,
        (candidate) => candidate.path === '/api/v1/notify'
      );
      expect(delivery.hostId).toBe(target.host.id);
      expect(delivery.payload).toMatchObject({
        terminalId,
        cwd: backend.remoteDirectory,
        kind: 'prompt-submit',
        source: 'claude-code',
        message: 'UserPromptSubmit',
        hookInput: { prompt: 'Review remote workspace' },
      });
    } finally {
      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]).catch(() => {});
      await sshPortForwardService.stopKomlaDataTunnel(target.host.id);
      if (server) await closeServer(server);
    }
  }, 60_000);

  it('runs hooks and status commands on the SSH host, where they reach Komla through the real tunnel', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const { sshPortForwardService } = sshPortForwardModule;
    const { runWorkspaceCommand } = await import('../../../src/main/services/workspace-command');
    await sshWorkspaceService.verifyAndPrepareHost(target.host);
    await remoteCompanionModule.remoteCompanionService.ensureInstalled(
      target.host,
      target.resolvedBasePath
    );
    const backend = await createPreparedWorkspace('hook');
    const workspace = {
      ...createWorkspace({ id: 'ssh-integration-hook', terminals: [] }),
      backend,
    };
    const outputPath = '/tmp/ssh-integration-hook.txt';
    let server: Server | undefined;

    try {
      const commands: Array<{ body: string; hostId?: string }> = [];
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          if (request.url?.startsWith('/api/v1/commands?')) {
            commands.push({
              body: Buffer.concat(chunks).toString('utf8'),
              hostId: request.headers['x-komla-ssh-host-id'] as string | undefined,
            });
          }
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"success":true,"result":{"status":"set"}}');
        });
      });
      await listenOnLoopback(server);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected integration port');
      await sshPortForwardService.ensureKomlaDataTunnel(target.host.id, address.port);

      await expect(
        runWorkspaceCommand(
          workspace,
          `komla status set hook "Ran on $KOMLA_EVENT" >/dev/null 2>&1; printf '%s|%s|%s|%s' "$KOMLA_EVENT" "$KOMLA_WORKSPACE_ID" "$PWD" "$(command -v komla)" > ${outputPath}; echo chatter`,
          {
            env: { KOMLA_EVENT: 'agent.done', KOMLA_WORKSPACE_ID: workspace.id },
            timeoutMs: 30_000,
          }
        )
      ).resolves.toBe('');

      const saved = await container.exec(['cat', outputPath]);
      expect(saved.stdout).toBe(
        `agent.done|${workspace.id}|${backend.remoteDirectory}|${target.resolvedBasePath}/helpers/komla`
      );
      await vi.waitFor(() => expect(commands).toHaveLength(1));
      expect(commands[0].hostId).toBe(target.host.id);
      expect(commands[0].body).toContain('status.set');
      expect(commands[0].body).toContain('Ran on agent.done');

      // A status command keeps what it printed.
      await expect(
        runWorkspaceCommand(workspace, 'git branch --show-current', {
          timeoutMs: 15_000,
          maxOutput: 1024,
        })
      ).resolves.toBe(`${backend.branchName}\n`);
      await expect(
        runWorkspaceCommand(workspace, 'echo first >&2; echo "say: not found" >&2; exit 127', {
          timeoutMs: 30_000,
        })
      ).rejects.toThrow('say: not found');

      // Past its timeout, the host stops the command and what it started.
      const pidPath = '/tmp/ssh-integration-hook-child.pid';
      await expect(
        runWorkspaceCommand(workspace, `sleep 60 & echo $! > ${pidPath}; wait`, {
          timeoutMs: 1000,
        })
      ).rejects.toMatchObject({ timedOut: true });
      const pid = (await container.exec(['cat', pidPath])).stdout.trim();
      await waitForContainerCondition(['sh', '-c', `! kill -0 ${pid} 2>/dev/null`]);
    } finally {
      await sshPortForwardService.stopKomlaDataTunnel(target.host.id);
      await sshWorkspaceService.deleteWorkspace(backend, true, backend.branchName).catch(() => {});
      if (server) await closeServer(server);
    }
  }, 90_000);

  it('forwards a local preview to an HTTP server on the SSH host', async () => {
    const { sshPortForwardService } = sshPortForwardModule;
    const fixtureRoot = `${target.remoteHome}/.komla-ssh-integration-fixture`;
    const portResult = await container.exec([
      'python3',
      '-c',
      'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()',
    ]);
    const remotePort = Number(portResult.stdout.trim());
    const backend = await createPreparedWorkspace('preview');

    try {
      await container.exec([
        'sh',
        '-lc',
        'printf "preview-from-container" > "$1/preview.txt"; nohup python3 -m http.server "$2" --bind 127.0.0.1 --directory "$1" > "$1/preview.log" 2>&1 & echo $! > "$1/preview.pid"',
        'sh',
        fixtureRoot,
        String(remotePort),
      ]);
      await waitForContainerCondition([
        'curl',
        '-fsS',
        `http://127.0.0.1:${remotePort}/preview.txt`,
      ]);

      const forward = await sshPortForwardService.startPreviewForward({
        workspaceId: 'ssh-integration-preview',
        tabId: 'tab-1',
        backend,
        remotePort,
      });
      const response = await fetch(`${forward.localUrl}/preview.txt`);
      expect(await response.text()).toBe('preview-from-container');

      await sshPortForwardService.stopPreviewForward('ssh-integration-preview');
      await expect(
        fetch(`${forward.localUrl}/preview.txt`, { signal: AbortSignal.timeout(2_000) })
      ).rejects.toThrow();
    } finally {
      await sshPortForwardService.stopPreviewForward('ssh-integration-preview');
      await container.exec(
        [
          'sh',
          '-lc',
          'if [ -f "$1/preview.pid" ]; then kill "$(cat "$1/preview.pid")" 2>/dev/null || true; fi',
          'sh',
          fixtureRoot,
        ],
        { allowFailure: true }
      );
    }
  }, 60_000);

  it('runs GUI apps on virtual desktops of their own and shows them through SSH forwards', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const { sshPortForwardService } = sshPortForwardModule;
    await sshWorkspaceService.verifyAndPrepareHost(target.host);
    await remoteCompanionModule.remoteCompanionService.ensureInstalled(
      target.host,
      target.resolvedBasePath
    );
    const backend = await createPreparedWorkspace('desktop');
    const terminalId = 'ssh-integration-desktop-terminal';
    const secondTerminalId = 'ssh-integration-desktop-terminal-2';
    const previewId = 'ssh-integration-desktop-preview';
    const operations: Array<{
      path?: string;
      body: { type?: string; url?: string; vncPort?: number };
    }> = [];
    let server: Server | undefined;
    const startProcesses: Array<ReturnType<typeof execFile>> = [];
    const helper = `${target.resolvedBasePath}/helpers/komla`;
    // The app keeps running, and with it the terminal's tmux attachment.
    const startApp = (terminal: string, displayFile: string) =>
      startProcesses.push(
        execFile(
          '/bin/sh',
          [
            '-lc',
            sshWorkspaceService.buildTerminalCommand(
              backend,
              `komla desktop run -- sh -c 'echo "$DISPLAY" > ${displayFile}; exec sleep 120'`,
              terminal,
              'ssh-integration-desktop-workspace',
              'start'
            ),
          ],
          { timeout: 60_000, maxBuffer: 1024 * 1024 }
        )
      );
    const savedDisplay = (displayFile: string) =>
      vi.waitFor(async () => {
        const saved = await container.exec(['cat', `${backend.remoteDirectory}/${displayFile}`], {
          allowFailure: true,
        });
        expect(saved.stdout.trim()).toMatch(/^:\d+$/);
        return Number(saved.stdout.trim().slice(1));
      });

    try {
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          if (request.method === 'POST') {
            operations.push({
              path: request.url,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          }
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end('{"ok":true,"result":{"desktop":{"viewer":"preview"}}}');
        });
      });
      await listenOnLoopback(server);
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected integration port');
      await sshPortForwardService.ensureKomlaDataTunnel(target.host.id, address.port);

      startApp(terminalId, 'desktop-display.txt');

      const desktop = await vi.waitFor(
        () => {
          const operation = operations.find(({ body }) => body.type === 'desktop.open');
          expect(operation).toBeDefined();
          return operation!;
        },
        { timeout: 30_000 }
      );
      expect(desktop.path).toBe(`/terminals/${terminalId}/api/v1/commands`);
      const url = new URL(desktop.body.url!);
      expect(url.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(url.pathname).toBe('/vnc.html');
      const display = await savedDisplay('desktop-display.txt');
      expect(Number(url.port)).toBe(6080 + display);
      expect(desktop.body.vncPort).toBe(5900 + display);
      // Apps started by hand, as from another SSH shell, use the display and cookie status prints.
      const manual = await container.exec([
        'sh',
        '-c',
        `eval "$(${helper} desktop status | sed -n 's/^Apps you start yourself: //p')" && test -s "$XAUTHORITY" && echo "$DISPLAY"`,
      ]);
      expect(manual.stdout.trim()).toBe(`:${display}`);

      const forward = await sshPortForwardService.startPreviewForward({
        workspaceId: previewId,
        tabId: 'tab-1',
        backend,
        remotePort: Number(url.port),
      });
      const page = await fetch(`${forward.localUrl}${url.pathname}${url.search}`);
      expect(await page.text()).toContain('noVNC');
      // noVNC connects over a WebSocket on the same port, and the VNC server greets it first.
      const greeting = await new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(`${forward.localUrl.replace(/^http/, 'ws')}/websockify`, [
          'binary',
        ]);
        socket.binaryType = 'arraybuffer';
        socket.onmessage = (event) => {
          resolve(Buffer.from(event.data as ArrayBuffer).toString('latin1'));
          socket.close();
        };
        socket.onerror = () => reject(new Error('noVNC WebSocket failed'));
      });
      expect(greeting).toMatch(/^RFB 003\.00\d\n$/);

      // A VNC app such as Screen Sharing connects to the VNC port itself.
      const vncPort = await sshPortForwardService.startVncForward(
        target.host.id,
        desktop.body.vncPort!
      );
      const vncGreeting = await new Promise<string>((resolve, reject) => {
        const socket = createConnection(vncPort, '127.0.0.1');
        socket.once('data', (data) => {
          resolve(data.toString('latin1'));
          socket.destroy();
        });
        socket.once('error', reject);
      });
      expect(vncGreeting).toMatch(/^RFB 003\.00\d\n$/);

      // Another app, here in another terminal, gets a desktop of its own.
      startApp(secondTerminalId, 'desktop-display-2.txt');
      const secondDesktop = await vi.waitFor(
        () => {
          const opened = operations.filter(({ body }) => body.type === 'desktop.open');
          expect(opened).toHaveLength(2);
          return opened[1]!;
        },
        { timeout: 30_000 }
      );
      const secondDisplay = await savedDisplay('desktop-display-2.txt');
      expect(secondDisplay).not.toBe(display);
      expect(secondDesktop.path).toBe(`/terminals/${secondTerminalId}/api/v1/commands`);
      expect(Number(new URL(secondDesktop.body.url!).port)).toBe(6080 + secondDisplay);
      // Its tab in the same workspace gets a forward of its own beside the first tab's, which the
      // first tab finds running when shown again. The first tab's connection stays up meanwhile.
      const firstTabSocket = new WebSocket(
        `${forward.localUrl.replace(/^http/, 'ws')}/websockify`,
        ['binary']
      );
      let firstTabSocketClosed = false;
      firstTabSocket.onclose = () => {
        firstTabSocketClosed = true;
      };
      await new Promise<void>((resolve, reject) => {
        firstTabSocket.onmessage = () => resolve();
        firstTabSocket.onerror = () => reject(new Error('noVNC WebSocket failed'));
      });
      const secondForward = await sshPortForwardService.startPreviewForward({
        workspaceId: previewId,
        tabId: 'tab-2',
        backend,
        remotePort: 6080 + secondDisplay,
      });
      expect(firstTabSocketClosed).toBe(false);
      expect(firstTabSocket.readyState).toBe(WebSocket.OPEN);
      firstTabSocket.close();
      for (const shown of [forward, secondForward]) {
        const served = await fetch(`${shown.localUrl}/vnc.html`);
        expect(await served.text()).toContain('noVNC');
      }
      await expect(
        sshPortForwardService.startPreviewForward({
          workspaceId: previewId,
          tabId: 'tab-1',
          backend,
          remotePort: Number(url.port),
        })
      ).resolves.toEqual(forward);

      // Closing the first terminal ends its app, and with it only that app's desktop.
      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]);
      await vi.waitFor(
        async () => {
          const status = await container.exec([helper, 'desktop', 'status']);
          expect(status.stdout).not.toContain(`Virtual desktop :${display} `);
          expect(status.stdout).toContain(`Virtual desktop :${secondDisplay} `);
        },
        { timeout: 15_000 }
      );
    } finally {
      await sshWorkspaceService
        .killTerminalSessions(backend, [terminalId, secondTerminalId])
        .catch(() => {});
      for (const child of startProcesses) child.kill('SIGTERM');
      await container.exec([helper, 'desktop', 'stop'], { allowFailure: true });
      await sshPortForwardService.stopPreviewForward(previewId);
      await sshPortForwardService.stopVncForward(target.host.id);
      await sshWorkspaceService.deleteWorkspace(backend, true, backend.branchName).catch(() => {});
      await sshPortForwardService.stopKomlaDataTunnel(target.host.id);
      if (server) await closeServer(server);
    }
  }, 120_000);

  it('forwards a local preview to an IPv6-only HTTP server on the SSH host', async () => {
    const { sshPortForwardService } = sshPortForwardModule;
    const fixtureRoot = `${target.remoteHome}/.komla-ssh-integration-fixture`;
    const portResult = await container.exec([
      'python3',
      '-c',
      'import socket; s=socket.socket(socket.AF_INET6); s.bind(("::1", 0)); print(s.getsockname()[1]); s.close()',
    ]);
    const remotePort = Number(portResult.stdout.trim());
    const backend = await createPreparedWorkspace('preview-ipv6');

    try {
      await container.exec([
        'sh',
        '-lc',
        'printf "preview-from-ipv6" > "$1/preview-ipv6.txt"; nohup python3 -m http.server "$2" --bind ::1 --directory "$1" > "$1/preview-ipv6.log" 2>&1 & echo $! > "$1/preview-ipv6.pid"',
        'sh',
        fixtureRoot,
        String(remotePort),
      ]);
      await waitForContainerCondition([
        'curl',
        '-g',
        '-fsS',
        `http://[::1]:${remotePort}/preview-ipv6.txt`,
      ]);

      const forward = await sshPortForwardService.startPreviewForward({
        workspaceId: 'ssh-integration-preview-ipv6',
        tabId: 'tab-1',
        backend,
        remotePort,
      });
      const response = await fetch(`${forward.localUrl}/preview-ipv6.txt`);
      expect(await response.text()).toBe('preview-from-ipv6');
    } finally {
      await sshPortForwardService.stopPreviewForward('ssh-integration-preview-ipv6');
      await container.exec(
        [
          'sh',
          '-lc',
          'if [ -f "$1/preview-ipv6.pid" ]; then kill "$(cat "$1/preview-ipv6.pid")" 2>/dev/null || true; fi',
          'sh',
          fixtureRoot,
        ],
        { allowFailure: true }
      );
    }
  }, 60_000);

  it('exposes a configured local service on the SSH host through a reverse forward', async () => {
    const { sshPortForwardService } = sshPortForwardModule;
    const portResult = await container.exec([
      'python3',
      '-c',
      'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()',
    ]);
    const remotePort = Number(portResult.stdout.trim());
    let server: Server | undefined;

    try {
      server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/plain' });
        response.end('configured-forward-from-host');
      });
      await listenOnLoopback(server);
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Could not determine the configured-forward service port');
      }

      const host: SshHost = {
        ...target.host,
        portForwards: [
          {
            id: 'ssh-integration-configured-forward',
            name: 'Integration HTTP server',
            localPort: address.port,
            remotePort,
            enabled: true,
          },
        ],
      };
      await sshPortForwardService.reconcileHostPortForwards(host);

      expect(sshPortForwardService.getHostPortForwardStatus(host.id)).toEqual({
        hostId: host.id,
        state: 'connected',
      });
      const response = await container.exec(['curl', '-fsS', `http://127.0.0.1:${remotePort}`]);
      expect(response.stdout).toBe('configured-forward-from-host');

      await sshPortForwardService.stopHostPortForwards(host.id);
      expect(sshPortForwardService.getHostPortForwardStatus(host.id).state).toBe('stopped');
      const stoppedResponse = await container.exec(
        ['curl', '-fsS', '--max-time', '2', `http://127.0.0.1:${remotePort}`],
        { allowFailure: true }
      );
      expect(stoppedResponse.exitCode).not.toBe(0);
    } finally {
      await sshPortForwardService.stopHostPortForwards(target.host.id);
      if (server) await closeServer(server);
    }
  }, 60_000);

  it('exposes a configured SSH host service through a local forward', async () => {
    const { sshPortForwardService } = sshPortForwardModule;
    const fixtureRoot = `${target.remoteHome}/.komla-ssh-integration-fixture`;
    const portResult = await container.exec([
      'python3',
      '-c',
      'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()',
    ]);
    const remotePort = Number(portResult.stdout.trim());
    const portReservation = createServer();
    await listenOnLoopback(portReservation);
    const address = portReservation.address();
    if (!address || typeof address === 'string') {
      await closeServer(portReservation);
      throw new Error('Could not determine the configured local-forward port');
    }
    const localPort = address.port;
    await closeServer(portReservation);

    try {
      await container.exec([
        'sh',
        '-lc',
        'printf "configured-forward-from-container" > "$1/configured-forward.txt"; nohup python3 -m http.server "$2" --bind 127.0.0.1 --directory "$1" > "$1/configured-forward.log" 2>&1 & echo $! > "$1/configured-forward.pid"',
        'sh',
        fixtureRoot,
        String(remotePort),
      ]);
      await waitForContainerCondition([
        'curl',
        '-fsS',
        `http://127.0.0.1:${remotePort}/configured-forward.txt`,
      ]);

      const host: SshHost = {
        ...target.host,
        portForwards: [
          {
            id: 'ssh-integration-configured-local-forward',
            name: 'Remote integration HTTP server',
            direction: 'remote-to-local',
            localPort,
            remotePort,
            enabled: true,
          },
        ],
      };
      await sshPortForwardService.reconcileHostPortForwards(host);

      expect(sshPortForwardService.getHostPortForwardStatus(host.id)).toEqual({
        hostId: host.id,
        state: 'connected',
      });
      const response = await fetch(`http://127.0.0.1:${localPort}/configured-forward.txt`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(await response.text()).toBe('configured-forward-from-container');

      await sshPortForwardService.stopHostPortForwards(host.id);
      expect(sshPortForwardService.getHostPortForwardStatus(host.id).state).toBe('stopped');
      await expect(
        fetch(`http://127.0.0.1:${localPort}/configured-forward.txt`, {
          signal: AbortSignal.timeout(2_000),
        })
      ).rejects.toThrow();
    } finally {
      await sshPortForwardService.stopHostPortForwards(target.host.id);
      await container.exec(
        [
          'sh',
          '-lc',
          'if [ -f "$1/configured-forward.pid" ]; then kill "$(cat "$1/configured-forward.pid")" 2>/dev/null || true; fi',
          'sh',
          fixtureRoot,
        ],
        { allowFailure: true }
      );
    }
  }, 60_000);

  it('discovers, reconnects to, and kills a persistent tmux terminal', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const backend = await createPreparedWorkspace('tmux');
    const terminalId = 'ssh-integration-persistent-terminal';
    const proofPath = `${backend.remoteDirectory}/.komla-persistent-terminal`;
    const startCommand = sshWorkspaceService.buildTerminalCommand(
      backend,
      'printf ready > .komla-persistent-terminal; while :; do sleep 1; done',
      terminalId,
      'ssh-integration-tmux-workspace',
      'start'
    );
    const startProcess = execFile('/bin/sh', ['-lc', startCommand], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    let startExited = false;
    const startExit = new Promise<void>((resolve) =>
      startProcess.once('exit', () => {
        startExited = true;
        resolve();
      })
    );
    let reconnectProcess: ReturnType<typeof execFile> | undefined;

    try {
      await waitForContainerCondition(['test', '-f', proofPath]);
      await expect(
        sshWorkspaceService.findTerminalSessions(backend, [terminalId, 'not-running'])
      ).resolves.toEqual(new Set([terminalId]));

      const reconnectCommand = sshWorkspaceService.buildTerminalCommand(
        backend,
        null,
        terminalId,
        'ssh-integration-tmux-workspace',
        'reconnect'
      );
      let reconnectExited = false;
      reconnectProcess = execFile('/bin/sh', ['-lc', reconnectCommand], {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      });
      reconnectProcess.once('exit', () => {
        reconnectExited = true;
      });
      await delay(500);
      expect(reconnectExited).toBe(false);

      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]);
      await expect(
        sshWorkspaceService.findTerminalSessions(backend, [terminalId])
      ).resolves.toEqual(new Set());
      await Promise.race([startExit, delay(5_000)]);
      expect(startExited).toBe(true);
    } finally {
      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]).catch(() => {});
      startProcess.kill('SIGTERM');
      reconnectProcess?.kill('SIGTERM');
    }
  }, 60_000);

  it('keeps a persistent tmux terminal attached on two devices, routed to the one used last', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const backend = await createPreparedWorkspace('tmux-shared');
    const terminalId = 'ssh-integration-shared-terminal';
    const attach = (action: 'start' | 'reconnect', device: string) => {
      const command = sshWorkspaceService.buildTerminalLaunchCommand(
        backend,
        null,
        terminalId,
        'ssh-integration-tmux-shared-workspace',
        action,
        {
          companion: {
            installationKey: `key-${device}`,
            hookInbox: `/tmp/komla-shared-inbox-${device}`,
            tmuxSocket: `komla-companion-${device}`,
            sessionName: `komla-companion-${device}`,
          },
        }
      ).command;
      const child = execFile('/bin/sh', ['-lc', command], {
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      });
      let exited = false;
      child.once('exit', () => {
        exited = true;
      });
      return { child, exited: () => exited };
    };
    const tmux = async (script: string) =>
      (await container.exec(['sh', '-lc', script, 'sh', `komla-${terminalId}`])).stdout.trim();
    const clientCount = () => tmux('tmux -L komla-v1 list-clients -t "=$1" 2>/dev/null | wc -l');
    const routedTo = () =>
      tmux(
        'printf "%s %s" "$(tmux -L komla-v1 show-environment -t "=$1" KOMLA_COMPANION_INBOX)" "$(tmux -L komla-v1 show-options -qv -t "$1" @komla_installation_key)"'
      );
    const routedToDevice = (device: string) =>
      `KOMLA_COMPANION_INBOX=/tmp/komla-shared-inbox-${device} key-${device}`;
    const first = attach('start', 'a');
    let second: ReturnType<typeof attach> | undefined;

    try {
      await expect.poll(clientCount, { timeout: 20_000 }).toBe('1');
      second = attach('reconnect', 'b');
      await expect.poll(clientCount, { timeout: 20_000 }).toBe('2');
      expect(await routedTo()).toBe(routedToDevice('b'));

      first.child.stdin?.write('printf first > .komla-shared-first\r');
      await waitForContainerCondition([
        'test',
        '-f',
        `${backend.remoteDirectory}/.komla-shared-first`,
      ]);
      await expect.poll(routedTo, { timeout: 5_000 }).toBe(routedToDevice('a'));

      second.child.stdin?.write('printf second > .komla-shared-second\r');
      await waitForContainerCondition([
        'test',
        '-f',
        `${backend.remoteDirectory}/.komla-shared-second`,
      ]);
      await expect.poll(routedTo, { timeout: 5_000 }).toBe(routedToDevice('b'));
      expect(first.exited()).toBe(false);
      expect(second.exited()).toBe(false);
      expect(await clientCount()).toBe('2');
    } finally {
      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]).catch(() => {});
      first.child.kill('SIGTERM');
      second?.child.kill('SIGTERM');
    }
  }, 90_000);

  it('carries OSC 7501 program statuses out of a managed tmux terminal', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    await remoteCompanionModule.remoteCompanionService.ensureInstalled(
      target.host,
      target.resolvedBasePath
    );
    const backend = await createPreparedWorkspace('program-status');
    const terminalId = 'ssh-integration-program-status';
    const programPath = `${backend.remoteDirectory}/.komla-program-status.py`;
    // Asks as Claude Code does, with Device Attributes right behind, which tmux answers itself,
    // then reports whether the OSC 7501 answer came first.
    await container.exec([
      'python3',
      '-c',
      'import sys; open(sys.argv[1], "w").write(sys.argv[2])',
      programPath,
      [
        'import os, select, time, tty',
        'tty.setraw(0)',
        "os.write(1, b'\\x1b]7501;?\\x1b\\\\\\x1b[c')",
        "reply = b''",
        'deadline = time.time() + 5',
        "while time.time() < deadline and not reply.endswith(b'c'):",
        '    if select.select([0], [], [], 0.1)[0]: reply += os.read(0, 100)',
        "answer = 'answered' if reply.startswith(b'\\x1b]7501;?') else 'unanswered'",
        "os.write(1, ('\\x1b]7501;state=working:app=' + answer + '\\x1b\\\\').encode())",
        "os.write(1, ('\\x1b]7501;state=blocked:app=' + answer + ':kind=permission\\x1b\\\\').encode())",
        'time.sleep(30)',
      ].join('\n'),
    ]);
    const startCommand = sshWorkspaceService.buildTerminalCommand(
      backend,
      'python3 .komla-program-status.py',
      terminalId,
      'ssh-integration-program-status-workspace',
      'start'
    );
    const startProcess = execFile('/bin/sh', ['-lc', startCommand], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    let output = '';
    startProcess.stdout?.on('data', (chunk: string) => (output += chunk));
    let reconnectProcess: ReturnType<typeof execFile> | undefined;
    const waitForReport = async (read: () => string) => {
      const deadline = Date.now() + 15_000;
      while (!read().includes('\x1b]7501;state=blocked') && Date.now() < deadline) {
        await delay(100);
      }
    };

    try {
      // The program may report before Komla attaches, and the proxy repeats it once it has.
      await waitForReport(() => output);

      expect(output).toContain('\x1b]7501;state=blocked:app=answered:kind=permission\x1b\\');
      expect(output).not.toContain('7501;?');

      // A reconnect gets the prompt the program still waits on.
      reconnectProcess = execFile(
        '/bin/sh',
        [
          '-lc',
          sshWorkspaceService.buildTerminalCommand(
            backend,
            null,
            terminalId,
            'ssh-integration-program-status-workspace',
            'reconnect'
          ),
        ],
        { timeout: 60_000, maxBuffer: 1024 * 1024 }
      );
      let reconnectOutput = '';
      reconnectProcess.stdout?.on('data', (chunk: string) => (reconnectOutput += chunk));
      await waitForReport(() => reconnectOutput);

      expect(reconnectOutput).toContain(
        '\x1b]7501;state=blocked:app=answered:kind=permission\x1b\\'
      );
    } finally {
      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]).catch(() => {});
      startProcess.kill('SIGTERM');
      reconnectProcess?.kill('SIGTERM');
    }
  }, 60_000);

  it('finds the ports a managed tmux terminal listens on and probes them over SSH', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const [{ createDevPreviewServiceDetector }, remotePorts] = await Promise.all([
      import('../../../src/main/services/dev-preview-services/detector'),
      import('../../../src/main/services/dev-preview-services/remote-listening-ports'),
    ]);
    const backend = await createPreparedWorkspace('services');
    const terminalId = 'ssh-integration-services-terminal';
    const portsResult = await container.exec([
      'python3',
      '-c',
      'import socket\nfor _ in range(2):\n s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()',
    ]);
    const [httpPort, tcpPort] = portsResult.stdout.trim().split('\n').map(Number);
    const tcpServerPath = `${backend.remoteDirectory}/.komla-tcp-server.py`;
    // Answers every connection with a Redis-style error instead of HTTP.
    await container.exec([
      'python3',
      '-c',
      'import sys; open(sys.argv[1], "w").write(sys.argv[2])',
      tcpServerPath,
      [
        'import socket, sys',
        's = socket.socket()',
        "s.bind(('127.0.0.1', int(sys.argv[1])))",
        's.listen()',
        'while True:',
        '    c, _ = s.accept()',
        "    c.sendall(b'-ERR unknown command\\r\\n')",
        '    c.close()',
      ].join('\n'),
    ]);
    const startCommand = sshWorkspaceService.buildTerminalCommand(
      backend,
      `python3 -m http.server ${httpPort} --bind 127.0.0.1 & python3 .komla-tcp-server.py ${tcpPort} & while :; do sleep 1; done`,
      terminalId,
      'ssh-integration-services-workspace',
      'start'
    );
    const startProcess = execFile('/bin/sh', ['-lc', startCommand], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    const runOnHost =
      (hostId: string) =>
      (command: string): Promise<string> =>
        sshWorkspaceService.run(sshWorkspaceService.getHost(hostId), command, {
          purpose: { kind: 'interactive' },
          timeout: 10_000,
        });
    const detector = createDevPreviewServiceDetector({
      getWorkspace: () => ({
        backend,
        terminals: [{ id: terminalId, name: 'services', status: 'running', createdAt: 0 }],
      }),
      getTerminalPid: () => undefined,
      getBackgroundPids: () => [],
      komlaPid: process.pid,
      collectListeningPorts: async () => ({ processes: [], listeners: [] }),
      probeHttpScheme: async () => null,
      isLoopbackPortOpen: async () => false,
      collectRemoteListeningPorts: (hostId) =>
        remotePorts.collectRemoteListeningPorts(runOnHost(hostId)),
      probeRemoteHttpSchemes: (hostId, ports) =>
        remotePorts.probeRemoteHttpSchemes(runOnHost(hostId), ports),
    });

    // A server the user started over SSH, outside Komla's tmux sessions.
    const otherPort = 8765;
    await runOnHost(backend.hostId)(
      `nohup python3 -m http.server ${otherPort} --bind 127.0.0.1 >/dev/null 2>&1 &`
    );

    try {
      await waitForContainerCondition(['curl', '-fsS', `http://127.0.0.1:${httpPort}/`]);
      await waitForContainerCondition(['curl', '-fsS', `http://127.0.0.1:${otherPort}/`]);
      await waitForContainerCondition(['sh', '-c', `ss -ltn | grep -q '127.0.0.1:${tcpPort} '`]);

      const result = await detector.detect('ssh-integration-services-workspace', [], [1]);

      expect([...result.services].sort((a, b) => a.port - b.port)).toEqual(
        [
          {
            port: httpPort,
            scheme: 'http',
            pid: expect.any(Number),
            processName: 'python3',
            terminalId,
            executionLocation: 'workspace',
          },
          {
            port: tcpPort,
            scheme: null,
            pid: expect.any(Number),
            processName: 'python3',
            terminalId,
            executionLocation: 'workspace',
          },
        ].sort((a, b) => a.port - b.port)
      );
      expect(result.remoteOpenPorts).toEqual([]);
      expect(result.otherServers).toEqual([
        { port: otherPort, scheme: 'http', processName: 'python3', executionLocation: 'workspace' },
      ]);

      // Once the terminal prints its URL, its other port belongs to the same server.
      const printed = await detector.detect('ssh-integration-services-workspace', [], [httpPort]);

      expect(printed.services.map(({ port }) => port)).toEqual([httpPort]);
      expect(printed.remoteOpenPorts).toEqual([httpPort]);
    } finally {
      await runOnHost(backend.hostId)(`pkill -f 'http.server ${otherPort}'`).catch(() => {});
      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]).catch(() => {});
      startProcess.kill('SIGTERM');
    }
  }, 60_000);

  it('keeps the initial tmux attachment interactive after an agent command fails', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const backend = await createPreparedWorkspace('agent-fallback');
    const terminalId = 'ssh-integration-agent-fallback';
    const proofPath = `${backend.remoteDirectory}/.komla-agent-fallback-input`;
    const terminalCommand = sshWorkspaceService.buildTerminalCommand(
      backend,
      'komla-command-that-does-not-exist',
      terminalId,
      'ssh-integration-agent-fallback-workspace',
      'start'
    );
    const terminalProcess = execFile('/bin/sh', ['-lc', terminalCommand], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });

    try {
      await waitForContainerCondition([
        'sh',
        '-lc',
        'tmux -L komla-v1 has-session -t "=komla-$1"',
        'sh',
        terminalId,
      ]);
      expect(terminalProcess.exitCode).toBeNull();
      terminalProcess.stdin?.write('printf typed > .komla-agent-fallback-input\r');
      await waitForContainerCondition(['test', '-f', proofPath]);
      expect((await container.exec(['cat', proofPath])).stdout).toBe('typed');
    } finally {
      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]).catch(() => {});
      terminalProcess.kill('SIGTERM');
    }
  }, 60_000);

  it('passes an agent hyperlink through the managed tmux to the attached terminal', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const backend = await createPreparedWorkspace('hyperlinks');
    const terminalId = 'ssh-integration-hyperlinks';
    const envPath = `${backend.remoteDirectory}/.komla-hyperlink-env`;
    const fileUrl = `file://${backend.remoteDirectory}/shot.png`;
    const terminalCommand = sshWorkspaceService.buildTerminalCommand(
      backend,
      [
        `printf '%s' "$FORCE_HYPERLINK" > .komla-hyperlink-env`,
        `printf '\\033]8;;%s\\033\\\\shot.png\\033]8;;\\033\\\\\\n' '${fileUrl}'`,
        'while :; do sleep 1; done',
      ].join('; '),
      terminalId,
      'ssh-integration-hyperlinks-workspace',
      'start'
    );
    const terminalProcess = execFile('/bin/sh', ['-lc', terminalCommand], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    let output = '';
    terminalProcess.stdout?.on('data', (chunk: string) => {
      output += chunk;
    });

    try {
      await waitForContainerCondition(['test', '-f', envPath]);
      expect((await container.exec(['cat', envPath])).stdout).toBe('1');
      await expect
        .poll(() => output.match(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)/)?.[1], { timeout: 10_000 })
        .toBe(fileUrl);
    } finally {
      await sshWorkspaceService.killTerminalSessions(backend, [terminalId]).catch(() => {});
      terminalProcess.kill('SIGTERM');
    }
  }, 60_000);

  it('synchronizes a local mirror through the production rsync transport', async () => {
    const { localMirrorService } = localMirrorModule;
    const backend = await createPreparedWorkspace('mirror');
    const workspaceId = 'ssh-integration-mirror';

    try {
      await container.exec([
        'sh',
        '-lc',
        'printf "*.ignored\n.env\ndependencies/\n" > "$1/.gitignore"; printf first > "$1/visible.txt"; printf remote-secret > "$1/.env"; printf ignored > "$1/private.ignored"; mkdir -p "$1/dependencies/remote-only"; printf remote > "$1/dependencies/remote-only/file"',
        'sh',
        backend.remoteDirectory,
      ]);
      const mirrorPath = await localMirrorService.prepare(workspaceId, backend);
      expect(readFileSync(`${mirrorPath}/visible.txt`, 'utf8')).toBe('first');
      expect(existsSync(`${mirrorPath}/.env`)).toBe(false);
      expect(existsSync(`${mirrorPath}/private.ignored`)).toBe(false);
      expect(existsSync(`${mirrorPath}/dependencies/remote-only/file`)).toBe(false);
      expect(existsSync(`${mirrorPath}/.git`)).toBe(false);

      mkdirSync(`${mirrorPath}/dependencies/local-only`, { recursive: true });
      writeFileSync(`${mirrorPath}/dependencies/local-only/file`, 'local');
      writeFileSync(`${mirrorPath}/.env`, 'local secret');
      writeFileSync(`${mirrorPath}/local.ignored`, 'local ignored');

      await container.exec([
        'sh',
        '-lc',
        'rm "$1/visible.txt"; printf updated-remote-secret > "$1/.env"; printf second > "$1/updated.txt"',
        'sh',
        backend.remoteDirectory,
      ]);
      await localMirrorService.prepare(workspaceId, backend);
      expect(existsSync(`${mirrorPath}/visible.txt`)).toBe(false);
      expect(readFileSync(`${mirrorPath}/.env`, 'utf8')).toBe('local secret');
      expect(readFileSync(`${mirrorPath}/updated.txt`, 'utf8')).toBe('second');
      expect(readFileSync(`${mirrorPath}/dependencies/local-only/file`, 'utf8')).toBe('local');
      expect(readFileSync(`${mirrorPath}/local.ignored`, 'utf8')).toBe('local ignored');
    } finally {
      await localMirrorService.remove(workspaceId, backend);
    }
  }, 60_000);

  it('runs representative Git mutations through real SSH commands', async () => {
    const { sshWorkspaceGit } = sshWorkspaceGitModule;
    const backend = await createPreparedWorkspace('git');

    await container.exec([
      'sh',
      '-lc',
      'printf changed > "$1/README.md"; printf untracked > "$1/untracked.txt"',
      'sh',
      backend.remoteDirectory,
    ]);
    await sshWorkspaceGit.restoreFile(backend, 'README.md', 'modified');
    expect((await container.exec(['cat', `${backend.remoteDirectory}/README.md`])).stdout).toBe(
      'ssh workspace integration fixture\n'
    );
    await expect(sshWorkspaceGit.discardAllChanges(backend)).resolves.toEqual({
      success: true,
      message: 'Discarded all changes',
    });
    expect(
      (
        await container.exec(['test', '-e', `${backend.remoteDirectory}/untracked.txt`], {
          allowFailure: true,
        })
      ).exitCode
    ).not.toBe(0);

    await container.exec([
      'sh',
      '-lc',
      'printf "integration commit\n" > "$1/integration.txt"; git -C "$1" add integration.txt; git -C "$1" commit -q -m "SSH integration mutation"',
      'sh',
      backend.remoteDirectory,
    ]);
    const beforePush = await sshWorkspaceGit.getBranchQuickStatus(backend, 'main');
    expect(beforePush).toMatchObject({ currentBranch: backend.branchName, aheadTargetBranch: 1 });
    await expect(sshWorkspaceGit.push(backend)).resolves.toMatchObject({ success: true });
    const pushed = await container.exec([
      'git',
      `--git-dir=${target.remoteHome}/.komla-ssh-integration-fixture/origin.git`,
      'show',
      `${backend.branchName}:integration.txt`,
    ]);
    expect(pushed.stdout).toBe('integration commit\n');
  }, 60_000);

  it('merges origin into a diverged target and pulls it without checking it out', async () => {
    const { sshWorkspaceGit } = sshWorkspaceGitModule;
    const fixture = await startCompanionObservedWorkspace('target-diverge');
    const { backend } = fixture;
    try {
      const origin = `${target.remoteHome}/.komla-ssh-integration-fixture/origin.git`;
      const commitTo = (where: 'local' | 'origin', file: string) =>
        container.exec([
          'sh',
          '-lc',
          [
            'set -e',
            'tmp=$(mktemp -d)',
            'if [ "$1" = local ]; then git -C "$2" worktree add -q "$tmp/c" main; else git clone -q "$3" "$tmp/c"; fi',
            'cd "$tmp/c"',
            'printf "%s\\n" "$4" > "$4"',
            'git add "$4"',
            'git -c user.name=t -c user.email=t@example.com commit -q -m "$4"',
            'if [ "$1" = local ]; then git -C "$2" worktree remove "$tmp/c"; else git push -q origin HEAD:main; fi',
          ].join('\n'),
          'sh',
          where,
          backend.remoteRepoPath,
          origin,
          file,
        ]);
      const rev = async (ref: string) =>
        (
          await container.exec(['git', '-C', backend.remoteRepoPath, 'rev-parse', ref])
        ).stdout.trim();

      await commitTo('local', 'local.txt');
      await commitTo('origin', 'remote.txt');
      const local = await rev('main');

      await expect(sshWorkspaceGit.mergeTargetBranchFromRemote(backend)).resolves.toEqual({
        success: true,
        message: 'Merged origin/main into main',
      });
      const parents = (
        await container.exec([
          'git',
          '-C',
          backend.remoteRepoPath,
          'rev-list',
          '--parents',
          '-n',
          '1',
          'main',
        ])
      ).stdout.trim();
      expect(parents.split(' ').slice(1)).toEqual([local, await rev('origin/main')]);
      const branch = await container.exec([
        'git',
        '-C',
        backend.remoteDirectory,
        'branch',
        '--show-current',
      ]);
      expect(branch.stdout.trim()).toBe(backend.branchName);

      await commitTo('origin', 'later.txt');
      await expect(sshWorkspaceGit.pullTargetBranch(backend)).resolves.toMatchObject({
        success: true,
      });
      expect(
        (await container.exec(['git', '-C', backend.remoteRepoPath, 'show', 'main:later.txt']))
          .stdout
      ).toBe('later.txt\n');
      const worktrees = await container.exec([
        'git',
        '-C',
        backend.remoteRepoPath,
        'worktree',
        'list',
        '--porcelain',
      ]);
      expect(worktrees.stdout).not.toContain('branch refs/heads/main');
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('handles absolute and shell-sensitive remote base paths literally', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const fixtureRoot = `${target.remoteHome}/.komla-ssh-integration-fixture`;
    const sentinel = `${target.remoteHome}/KOMLA_SSH_PATH_INJECTION`;
    const cases = [
      {
        id: 'ssh-integration-special-path',
        basePath:
          "~/.komla-ssh-integration-fixture/literal $HOME ; touch KOMLA_SSH_PATH_INJECTION 'quote'",
        expected: `${fixtureRoot}/literal $HOME ; touch KOMLA_SSH_PATH_INJECTION 'quote'`,
      },
      {
        id: 'ssh-integration-absolute-path',
        basePath: `${fixtureRoot}/absolute-base`,
        expected: `${fixtureRoot}/absolute-base`,
      },
    ];

    await container.exec(['rm', '-f', sentinel]);
    for (const pathCase of cases) {
      const host: SshHost = { ...target.host, id: pathCase.id, basePath: pathCase.basePath };
      const setup = await sshWorkspaceService.verifyAndPrepareHost(host);
      expect(setup.resolvedBasePath).toBe(pathCase.expected);
      expect(
        (await container.exec(['test', '-x', `${pathCase.expected}/helpers/notify.sh`])).exitCode
      ).toBe(0);
    }
    expect(
      (await container.exec(['test', '-e', sentinel], { allowFailure: true })).exitCode
    ).not.toBe(0);
  }, 60_000);

  it('rejects a base path whose existing symlink resolves to the remote home', async () => {
    const { sshWorkspaceService } = sshWorkspaceModule;
    const linkPath = `${target.remoteHome}/.komla-ssh-integration-fixture/unsafe-home-link`;
    await container.exec(['ln', '-s', target.remoteHome, linkPath]);
    const host: SshHost = {
      ...target.host,
      id: 'ssh-integration-unsafe-path',
      basePath: '~/.komla-ssh-integration-fixture/unsafe-home-link',
    };

    await expect(sshWorkspaceService.verifyAndPrepareHost(host)).rejects.toThrow(
      'refusing to use an unsafe remote data path'
    );
  }, 60_000);
});

describe('Komla Remote Companion through Docker OpenSSH', () => {
  it('updates ahead counts through the watcher after a CLI target merge', async () => {
    const fixture = await startCompanionObservedWorkspace('target-status');
    try {
      await waitForCompanionSnapshot(fixture.deliveries, fixture.workspaceId);
      await container.exec([
        'git',
        '-C',
        fixture.backend.remoteDirectory,
        '-c',
        'user.name=Komla Test',
        '-c',
        'user.email=komla@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'ahead of target',
      ]);
      const ahead = await waitForCompanionSnapshot(
        fixture.deliveries,
        fixture.workspaceId,
        (delivery) => delivery.payload.aheadTargetBranch === 1
      );
      const result = await sshWorkspaceGitModule.sshWorkspaceGit.mergeToTargetBranch(
        fixture.backend
      );
      expect(result.success).toBe(true);
      await waitForCompanionSnapshot(
        fixture.deliveries,
        fixture.workspaceId,
        (delivery) =>
          companionSequence(delivery) > companionSequence(ahead) &&
          delivery.payload.aheadTargetBranch === 0
      );
      const repeated = await sshWorkspaceGitModule.sshWorkspaceGit.mergeToTargetBranch(
        fixture.backend
      );
      expect(repeated).toMatchObject({ success: true, message: 'main is already up to date' });
      const snapshot = await sshWorkspaceGitModule.sshWorkspaceGit.getSnapshot(
        fixture.backend,
        'main'
      );
      expect(snapshot.branch.aheadTargetBranch).toBe(0);
      expect(snapshot.observedAt).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('confirms unchanged retained status after reconnect without restarting the companion', async () => {
    const fixture = await startCompanionRecovery('companion-reconnect');
    try {
      await fixture.observation.reconcile();
      await vi.waitFor(
        () => expect(fixture.status.read(fixture.workspace.id)?.confirmation.kind).toBe('current'),
        { timeout: 20_000 }
      );
      const original = fixture.status.read(fixture.workspace.id)!;
      const pid = await fixture.companionPid();
      expect(fixture.scans).toEqual([fixture.backend.remoteDirectory]);

      // Recreate desktop status/observation state while leaving remote tmux alive.
      await sshPortForwardModule.sshPortForwardService.stopKomlaDataTunnel(target.host.id);
      await fixture.reopen();
      expect(fixture.status.read(fixture.workspace.id)?.confirmation.kind).toBe('stale');
      await fixture.observation.reconcile();
      await vi.waitFor(
        () => expect(fixture.status.read(fixture.workspace.id)?.confirmation.kind).toBe('current'),
        { timeout: 20_000 }
      );

      expect(fixture.status.read(fixture.workspace.id)?.workingTree).toEqual(original.workingTree);
      expect(fixture.status.read(fixture.workspace.id)?.branch).toEqual(original.branch);
      expect(fixture.scans).toEqual([
        fixture.backend.remoteDirectory,
        fixture.backend.remoteDirectory,
      ]);
      expect(await fixture.companionPid()).toBe(pid);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('does not rescan existing workspaces when real remote panes and workspaces reuse the tunnel', async () => {
    const fixture = await startCompanionRecovery('companion-reuse');
    try {
      await fixture.observation.reconcile();
      await vi.waitFor(
        () => expect(fixture.status.read(fixture.workspace.id)?.confirmation.kind).toBe('current'),
        { timeout: 20_000 }
      );
      const pid = await fixture.companionPid();
      await fixture.addTerminal(fixture.workspace, 'extra-pane');
      await fixture.observation.reconcile();
      expect(await fixture.companionPid()).toBe(pid);

      const backend = await createPreparedWorkspace('companion-reuse-extra');
      const workspace = createWorkspace({
        id: 'companion-reuse-extra',
        backend,
        baseBranch: 'main',
        terminals: [],
      });
      fixture.workspaces.push(workspace);
      await fixture.addTerminal(workspace, 'extra-workspace');
      await fixture.observation.reconcile();
      await waitForCompanionSnapshot(fixture.deliveries, workspace.id);
      // The running companion reloads its workspace list instead of restarting.
      expect(await fixture.companionPid()).toBe(pid);
      // Drain the background connection callback, if one was incorrectly emitted.
      await delay(250);
      expect(fixture.scans).toEqual([fixture.backend.remoteDirectory]);
    } finally {
      await fixture.cleanup();
    }
  }, 120_000);

  it('searches SSH workspace contents with the installed companion', async () => {
    const backend = await createPreparedWorkspace('content-search');
    await container.exec([
      'sh',
      '-lc',
      [
        'cd "$1"',
        'mkdir -p src',
        "printf 'call(alpha,\\n  beta)\\n' > src/app.ts",
        "printf 'ALPHA\\n' > .hidden.txt",
        "printf 'alpha\\n' > \"notes it's.txt\"",
        "printf 'ignored.log\\n' >> .gitignore",
        "printf 'alpha\\n' > ignored.log",
        "printf 'alpha\\000\\n' > binary.bin",
      ].join('; '),
      'sh',
      backend.remoteDirectory,
    ]);
    const { workspaceFileService } =
      await import('../../../src/main/services/workspace-file.service');
    const workspace = createWorkspace({ id: 'content-search', backend, terminals: [] });
    vi.spyOn(
      workspaceFileService as unknown as { getWorkspace: (id: string) => Workspace },
      'getWorkspace'
    ).mockReturnValue(workspace);

    const found = await workspaceFileService.searchContent(workspace.id, 'alpha');
    expect(found.map((match) => match.path).sort()).toEqual([
      '.hidden.txt',
      "notes it's.txt",
      'src/app.ts',
    ]);
    await expect(workspaceFileService.searchContent(workspace.id, 'alpha, beta')).resolves.toEqual([
      {
        path: 'src/app.ts',
        lineNumber: 1,
        lineContent: 'call(alpha,   beta)',
        matches: [{ start: 5, end: 18 }],
      },
    ]);
  }, 60_000);

  it('fails closed when the companion artifact is missing', async () => {
    const { RemoteCompanionService } = remoteCompanionModule;
    const { sshWorkspaceService } = sshWorkspaceModule;
    const emptyRoot = mkdtempSync(join(tmpdir(), 'komla-companion-missing-'));
    const service = new RemoteCompanionService({
      resourceRoot: () => emptyRoot,
      run: (host, command) => sshWorkspaceService.run(host, command),
      upload: (host, command, sourcePath) =>
        sshWorkspaceService.runWithFileInput(host, command, sourcePath),
    });

    const architecture = (await container.exec(['uname', '-m'])).stdout.trim();
    const expectedTarget = remoteCompanionModule.resolveRemoteCompanionTarget(
      'Linux',
      architecture
    );
    await expect(service.ensureInstalled(target.host, target.resolvedBasePath)).rejects.toThrow(
      `Komla Remote Companion artifact is missing for ${expectedTarget}`
    );
  }, 60_000);

  it('installs a content-addressed companion binary and a stable helper symlink', async () => {
    const { remoteCompanionService } = remoteCompanionModule;
    const remotePath = await remoteCompanionService.ensureInstalled(
      target.host,
      target.resolvedBasePath
    );

    expect(remotePath).toMatch(
      new RegExp(
        `^${escapeRegExp(target.resolvedBasePath)}/helpers/bin/protocol-1/[a-f0-9]{64}/komla$`
      )
    );
    const version = await container.exec([remotePath, 'version']);
    expect(JSON.parse(version.stdout)).toEqual({
      name: 'komla',
      version: '0.1.0',
      protocolVersion: 1,
    });
    const stable = await container.exec(['readlink', `${target.resolvedBasePath}/helpers/komla`]);
    expect(stable.stdout.trim()).toBe(remotePath);
    const reused = await remoteCompanionService.ensureInstalled(
      target.host,
      target.resolvedBasePath
    );
    expect(reused).toBe(remotePath);
  }, 60_000);

  it.skipIf(process.env.KOMLA_SSH_EXEC_CHANNEL === '0')(
    'runs commands through the SSH Exec Channel and recovers when the channel dies',
    async () => {
      const { remoteCompanionService } = remoteCompanionModule;
      const { sshWorkspaceService } = sshWorkspaceModule;
      await remoteCompanionService.ensureInstalled(target.host, target.resolvedBasePath);
      // Whatever ran the command's shell: the channel, or sshd and the login shell.
      const runner = () =>
        sshWorkspaceService.run(target.host, "tr '\\0' ' ' < /proc/$PPID/cmdline");
      await vi.waitFor(async () => expect(await runner()).toContain('__exec-channel'), {
        timeout: 15_000,
        interval: 100,
      });

      // Interactive commands get a channel of their own.
      const parent = (kind: 'background' | 'interactive') =>
        sshWorkspaceService.run(target.host, "echo $PPID; tr '\\0' ' ' < /proc/$PPID/cmdline", {
          purpose: { kind },
        });
      await vi.waitFor(
        async () => expect(await parent('interactive')).toContain('__exec-channel'),
        { timeout: 15_000, interval: 100 }
      );
      const [background, interactive] = await Promise.all([
        parent('background'),
        parent('interactive'),
      ]);
      expect(background.split('\n')[0]).not.toBe(interactive.split('\n')[0]);

      // A saved file's contents reach the interactive channel as the command's input.
      const saved = `${target.resolvedBasePath}/exec-channel-saved`;
      await expect(
        sshWorkspaceService.runWithInput(
          target.host,
          `cat > '${saved}'; tr '\\0' ' ' < /proc/$PPID/cmdline`,
          'saved through the channel'
        )
      ).resolves.toContain('__exec-channel');
      expect((await container.exec(['cat', saved])).stdout).toBe('saved through the channel');

      // A command the channel lost fails as a dropped ssh does, and nothing runs it again.
      const marker = `${target.resolvedBasePath}/exec-channel-runs`;
      // Caught now, since it may fail before the kill below returns.
      const failed = sshWorkspaceService
        .run(target.host, `echo run >> '${marker}'; sleep 30`)
        .catch((error: unknown) => error);
      const runs = async () =>
        (await container.exec(['cat', marker], { allowFailure: true })).stdout;
      await vi.waitFor(async () => expect(await runs()).toBe('run\n'), { timeout: 15_000 });
      await container.exec(['pkill', '-f', '__exec-channel']);
      expect(await failed).toMatchObject({ code: 255 });
      expect(await runs()).toBe('run\n');

      // The next command runs as its own ssh exec while a new channel opens.
      await expect(runner()).resolves.not.toContain('__exec-channel');
      await vi.waitFor(async () => expect(await runner()).toContain('__exec-channel'), {
        timeout: 15_000,
        interval: 100,
      });
    },
    60_000
  );

  it('fetches origin in the background on the host, and stops a fetch that hangs', async () => {
    const { sshWorkspaceGit } = sshWorkspaceGitModule;
    const backend = await createPreparedWorkspace('background-fetch');
    const repo = backend.remoteRepoPath;
    if (process.env.KOMLA_SSH_EXEC_CHANNEL !== '0') {
      await remoteCompanionModule.remoteCompanionService.ensureInstalled(
        target.host,
        target.resolvedBasePath
      );
      await vi.waitFor(
        async () =>
          expect(
            await sshWorkspaceModule.sshWorkspaceService.run(
              target.host,
              "tr '\\0' ' ' < /proc/$PPID/cmdline"
            )
          ).toContain('__exec-channel'),
        { timeout: 15_000, interval: 100 }
      );
    }
    const fetch = (timeoutMs = 20_000) =>
      sshWorkspaceGit.fetchOriginWithoutPrompts(target.host.id, repo, timeoutMs);

    // Catches up on what earlier tests pushed.
    await fetch();
    await expect(fetch()).resolves.toBe(false);
    await container.exec([
      'sh',
      '-lc',
      [
        'set -e',
        'tmp=$(mktemp -d)',
        'git clone -q "$1" "$tmp/c"',
        'git -C "$tmp/c" commit -q --allow-empty -m "pushed elsewhere"',
        'git -C "$tmp/c" push -q origin HEAD:main',
        'rm -rf "$tmp"',
      ].join('\n'),
      'sh',
      `${target.remoteHome}/.komla-ssh-integration-fixture/origin.git`,
    ]);
    await expect(fetch()).resolves.toBe(true);

    // A remote that never answers: git's ssh records its pid and hangs.
    const fakeSsh = `${target.resolvedBasePath}/background-fetch-ssh`;
    const pidFile = `${target.resolvedBasePath}/background-fetch-ssh.pid`;
    const originUrl = (
      await container.exec(['git', '-C', repo, 'remote', 'get-url', 'origin'])
    ).stdout.trim();
    await container.exec([
      'sh',
      '-c',
      [
        `printf '#!/bin/sh\\necho $$ > %s\\nexec sleep 60\\n' "$3" > "$2"`,
        'chmod +x "$2"',
        'git -C "$1" config core.sshCommand "$2"',
        'git -C "$1" remote set-url origin ssh://git.example.invalid/repo.git',
      ].join('\n'),
      'sh',
      repo,
      fakeSsh,
      pidFile,
    ]);
    try {
      const startedAt = Date.now();
      // Stopped by the host's watchdog, before Komla's own timeout.
      await expect(fetch(2_000)).rejects.toMatchObject({ code: 143 });
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      const pid = (await container.exec(['cat', pidFile])).stdout.trim();
      await waitForContainerCondition(['sh', '-c', '! kill -0 "$1" 2>/dev/null', 'sh', pid]);
    } finally {
      await container.exec([
        'sh',
        '-c',
        'git -C "$1" config --unset core.sshCommand; git -C "$1" remote set-url origin "$2"',
        'sh',
        repo,
        originUrl,
      ]);
    }
  }, 90_000);

  it('starts a companion session and delivers an initial repository snapshot through the tunnel', async () => {
    const fixture = await startCompanionObservedWorkspace('companion-initial');
    try {
      const snapshot = await waitForCompanionSnapshot(fixture.deliveries, fixture.workspaceId);
      expect(snapshot.hostId).toBe(target.host.id);
      expect(snapshot.payload).toMatchObject({
        protocolVersion: 1,
        kind: 'repository-snapshot',
        workspaceId: fixture.workspaceId,
        cwd: fixture.backend.remoteDirectory,
      });
      expect(snapshot.payload.sequence).toBeGreaterThan(0);
      await waitForContainerCondition([
        'tmux',
        '-L',
        fixture.companionTmuxSocket,
        'has-session',
        '-t',
        `=${fixture.companionSession}`,
      ]);
    } finally {
      await fixture.cleanup();
    }
  }, 90_000);

  it('delivers a new companion snapshot after a working-tree change', async () => {
    const fixture = await startDirectCompanion('companion-watch');
    try {
      const initial = await waitForRecordedCompanionPost(fixture.recordPath, (post) =>
        post.path.endsWith('/ssh-workspace-status')
      );
      await container.exec([
        'sh',
        '-lc',
        'printf "companion watcher update\\n" >> "$1/README.md"; printf "untracked from companion\\n" > "$1/companion-watch.txt"',
        'sh',
        fixture.backend.remoteDirectory,
      ]);
      const changed = await waitForRecordedCompanionPost(fixture.recordPath, (post) => {
        const status = decodeCompanionStatus(post);
        return companionSequence(post) > companionSequence(initial) && status.includes('README.md');
      });
      expect(changed.payload.cwd).toBe(fixture.backend.remoteDirectory);
      expect(decodeCompanionStatus(changed)).toContain('companion-watch.txt');
      // The first snapshot can't know what changed. This one names the files and, with a new
      // file listed, carries a new fingerprint.
      expect(initial.payload.changedPaths).toBeUndefined();
      expect(changed.payload.changedPaths).toEqual(
        expect.arrayContaining(['README.md', 'companion-watch.txt'])
      );
      expect(changed.payload.fileListHash).toMatch(/^[0-9a-f]{64}$/);
      expect(changed.payload.fileListHash).not.toBe(initial.payload.fileListHash);
    } finally {
      await fixture.cleanup();
    }
  }, 90_000);

  it('forwards a pending terminal hook from the companion mailbox', async () => {
    const fixture = await startDirectCompanion('companion-hook');
    try {
      await waitForRecordedCompanionPost(fixture.recordPath, (post) =>
        post.path.endsWith('/ssh-workspace-status')
      );
      await container.exec([
        'sh',
        '-lc',
        [
          `cd ${shellQuote(fixture.backend.remoteDirectory)}`,
          `export KOMLA_TERMINAL_ID=${shellQuote(fixture.terminalId)}`,
          `export KOMLA_COMPANION_INBOX=${shellQuote(fixture.inbox)}`,
          'export KOMLA_COMPANION_SESSION=komla-direct-keep',
          'export KOMLA_COMPANION_TMUX_SOCKET=komla-v1',
          `printf '%s' '{"prompt":"Review companion hook"}' | ${shellQuote(
            `${target.resolvedBasePath}/helpers/notify.sh`
          )} --source claude-code --event UserPromptSubmit`,
        ].join(' && '),
      ]);
      const delivery = await waitForRecordedCompanionPost(
        fixture.recordPath,
        (post) => post.path.endsWith('/notify') && post.payload.kind === 'prompt-submit'
      );
      expect(delivery.payload).toMatchObject({
        terminalId: fixture.terminalId,
        cwd: fixture.backend.remoteDirectory,
        kind: 'prompt-submit',
        source: 'claude-code',
        message: 'UserPromptSubmit',
        hookInput: { prompt: 'Review companion hook' },
      });
    } finally {
      await fixture.cleanup();
    }
  }, 90_000);
});

async function createPreparedWorkspace(suffix: string): Promise<SshWorkspaceBackend> {
  const { sshWorkspaceService } = sshWorkspaceModule;
  const plan = sshWorkspaceService.createWorkspacePlan({
    hostId: target.host.id,
    gitUrl: target.originUrl,
    projectId: `ssh-integration-${suffix}`,
    projectName: `ssh-integration-${suffix}`,
    branchName: `agent/real-ssh-${suffix}`,
    baseBranch: 'main',
    resolvedBasePath: target.resolvedBasePath,
  });
  await sshWorkspaceService.ensureWorkspaceReady(plan.backend);
  return plan.backend;
}

async function waitForContainerCondition(command: string[], timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await container.exec(command, { allowFailure: true });
    if (result.exitCode === 0) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for container command: ${command.join(' ')}`);
}

interface StatusDelivery {
  path?: string;
  payload: Record<string, unknown>;
  hostId?: string;
}

async function waitForStatusDelivery(
  deliveries: StatusDelivery[],
  predicate: (delivery: StatusDelivery) => boolean,
  timeoutMs = 15_000
): Promise<StatusDelivery> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const delivery = deliveries.find(predicate);
    if (delivery) return delivery;
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for SSH workspace status delivery. received=${JSON.stringify(
      deliveries.slice(-8).map((delivery) => ({
        path: delivery.path,
        kind: delivery.payload.kind,
        workspaceId: delivery.payload.workspaceId,
        sequence: companionSequence(delivery) || undefined,
      }))
    )}`
  );
}

interface CompanionObservedWorkspace {
  backend: SshWorkspaceBackend;
  workspaceId: string;
  terminalId: string;
  companionSession: string;
  companionTmuxSocket: string;
  installationId: string;
  localPort: number;
  deliveries: StatusDelivery[];
  cleanup: () => Promise<void>;
}

async function startCompanionObservedWorkspace(
  suffix: string
): Promise<CompanionObservedWorkspace> {
  const { sshWorkspaceService, remoteKomlaDataPort } = sshWorkspaceModule;
  const { sshPortForwardService } = sshPortForwardModule;
  const { remoteCompanionService } = remoteCompanionModule;
  await sshWorkspaceService.verifyAndPrepareHost(target.host);
  const backend = await createPreparedWorkspace(suffix);
  const workspaceId = `ssh-integration-${suffix}-workspace`;
  const terminalId = `ssh-integration-${suffix}-terminal`;
  const installationId = `ssh-integration-${suffix}`;
  let companionSession = `komla-companion-${createHash('sha256')
    .update(installationId)
    .digest('hex')
    .slice(0, 16)}`;
  const { server, deliveries } = createCompanionProtocolServer();
  let terminalProcess: ReturnType<typeof execFile> | undefined;
  let companionTmuxSocket = 'komla-v1';
  let companionInbox = `${target.resolvedBasePath}/helpers/companion-inbox`;
  const cleanup = async () => {
    await sshWorkspaceService.killTerminalSessions(backend, [terminalId]).catch(() => {});
    terminalProcess?.kill('SIGTERM');
    await container
      .exec(['tmux', '-L', companionTmuxSocket, 'kill-session', '-t', `=${companionSession}`], {
        allowFailure: true,
      })
      .catch(() => {});
    await container
      .exec(['rm', '-rf', companionInbox], {
        allowFailure: true,
      })
      .catch(() => {});
    await sshPortForwardService.stopKomlaDataTunnel(target.host.id);
    await closeServer(server);
  };

  try {
    await listenOnLoopback(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected integration port');
    await sshPortForwardService.ensureKomlaDataTunnel(target.host.id, address.port);
    await remoteCompanionService.ensureInstalled(target.host, target.resolvedBasePath);
    const terminalCommand = sshWorkspaceService.buildTerminalCommand(
      backend,
      'while :; do sleep 1; done',
      terminalId,
      workspaceId,
      'start'
    );
    terminalProcess = execFile('/bin/sh', ['-lc', terminalCommand], {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
    await waitForContainerCondition([
      'tmux',
      '-L',
      'komla-v1',
      'has-session',
      '-t',
      `=komla-${terminalId}`,
    ]);
    const runtime = await remoteCompanionService.ensureRunning(target.host, {
      remoteBasePath: target.resolvedBasePath,
      endpoint: `http://127.0.0.1:${remoteKomlaDataPort(target.host.id)}/api/v1/ssh-workspace-status`,
      installationId,
      workspaces: [
        {
          workspaceId,
          workingTree: backend.remoteDirectory,
          targetBranch: 'main',
        },
      ],
    });
    if (!runtime) throw new Error('Expected a running Remote Companion');
    companionTmuxSocket = runtime.tmuxSocket;
    companionSession = runtime.sessionName;
    companionInbox = runtime.hookInbox;
    return {
      backend,
      workspaceId,
      terminalId,
      companionSession,
      companionTmuxSocket,
      installationId,
      localPort: address.port,
      deliveries,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function startCompanionRecovery(suffix: string) {
  const fixture = await startCompanionObservedWorkspace(suffix);
  const { RemoteWorkspaceObservationService } =
    await import('../../../src/main/services/remote-workspace-observation.service');
  const { WorkspaceStatusService } =
    await import('../../../src/main/services/workspace-status.service');
  const { sshWorkspaceService } = sshWorkspaceModule;
  const { sshPortForwardService } = sshPortForwardModule;
  const { remoteCompanionService, resolveRemoteCompanionRuntime } = remoteCompanionModule;
  const workspace = createWorkspace({
    id: fixture.workspaceId,
    backend: fixture.backend,
    baseBranch: 'main',
    terminals: [
      {
        id: fixture.terminalId,
        name: 'Remote',
        status: 'stopped',
        remoteSessionActive: true,
        createdAt: Date.now(),
      },
    ],
  });
  const workspaces: Workspace[] = [workspace];
  const scans: string[] = [];
  const attachments: ReturnType<typeof execFile>[] = [];
  const extraTerminals: { backend: SshWorkspaceBackend; id: string }[] = [];
  const createStatus = () =>
    new WorkspaceStatusService({
      listWorkspaces: () => workspaces,
      getWorkspace: (id) => workspaces.find((item) => item.id === id),
      saveWorkspaces: () => undefined,
      broadcastWorkspaceUpdate: () => undefined,
      publishWorkingTreeChange: () => undefined,
      requestLocalCopySync: () => undefined,
      restartLocalWatcher: async () => undefined,
      now: Date.now,
      getSshSnapshot: (backend, branch) => {
        // Record actual calls without mocking the SSH transport or installed CLI.
        scans.push(backend.remoteDirectory);
        return sshWorkspaceGitModule.sshWorkspaceGit.getSnapshot(backend, branch);
      },
    });
  let status = createStatus();
  const createObservation = () =>
    new RemoteWorkspaceObservationService({
      listWorkspaces: () => workspaces,
      waitForKomlaPort: async () => fixture.localPort,
      ensureKomlaDataTunnel: (hostId, port, connected) =>
        sshPortForwardService.ensureKomlaDataTunnel(hostId, port, connected),
      stopKomlaDataTunnelsExcept: (ids) => sshPortForwardService.stopKomlaDataTunnelsExcept(ids),
      getHost: (id) => sshWorkspaceService.getHost(id),
      ensureRemoteNotificationScript: (backend) =>
        sshWorkspaceService.ensureRemoteNotificationScript(backend),
      ensureRemoteCompanion: (host, options) => remoteCompanionService.ensureRunning(host, options),
      invalidateRemoteCompanion: (id) => remoteCompanionService.invalidateHost(id),
      companionInstallationId: () => fixture.installationId,
      resolveCompanionRuntime: resolveRemoteCompanionRuntime,
      markRemoteDisconnected: async (workspaceIds) => {
        await status.change({ kind: 'remote-source-unreachable', workspaceIds });
      },
      refreshWorkspaceStatus: (workspaceId) =>
        status.change({ kind: 'refresh-requested', workspaceId }),
      isWorkspaceDeleting: () => false,
    });
  let observation = createObservation();
  await waitForCompanionSnapshot(fixture.deliveries, fixture.workspaceId);
  await sshPortForwardService.stopKomlaDataTunnel(target.host.id);
  return {
    ...fixture,
    workspace,
    workspaces,
    scans,
    get status() {
      return status;
    },
    get observation() {
      return observation;
    },
    async reopen() {
      status = createStatus();
      await status.change({ kind: 'restore' });
      observation = createObservation();
    },
    async companionPid() {
      // The observation derives its own runtime from the workspace, not the fixture's.
      const runtime = observation.companionForHost(target.host.id);
      if (!runtime) throw new Error('Remote Companion is not running');
      const result = await container.exec([
        'tmux',
        '-L',
        runtime.tmuxSocket,
        'list-panes',
        '-t',
        `=${runtime.sessionName}`,
        '-F',
        '#{pane_pid}',
      ]);
      const pid = result.stdout.trim();
      if (!pid) throw new Error('Remote Companion session not found');
      return pid;
    },
    async addTerminal(item: Workspace, suffix: string) {
      const backend = item.backend;
      if (backend?.kind !== 'ssh') throw new Error('Expected SSH workspace');
      const id = `${fixture.terminalId}-${suffix}`;
      extraTerminals.push({ backend, id });
      const command = sshWorkspaceService.buildTerminalCommand(
        backend,
        'while :; do sleep 1; done',
        id,
        item.id,
        'start'
      );
      attachments.push(
        execFile('/bin/sh', ['-lc', command], { timeout: 180_000, maxBuffer: 1024 * 1024 })
      );
      await waitForContainerCondition([
        'tmux',
        '-L',
        'komla-v1',
        'has-session',
        '-t',
        `=komla-${id}`,
      ]);
      item.terminals.push({ id, name: suffix, status: 'running', createdAt: Date.now() });
    },
    async cleanup() {
      workspaces.length = 0;
      await observation.reconcile();
      for (const { backend, id } of extraTerminals)
        await sshWorkspaceService.killTerminalSessions(backend, [id]).catch(() => {});
      for (const attachment of attachments) attachment.kill('SIGTERM');
      await fixture.cleanup();
    },
  };
}

function createCompanionProtocolServer(): {
  server: Server;
  deliveries: StatusDelivery[];
} {
  const deliveries: StatusDelivery[] = [];
  const server = createServer({ keepAlive: false, keepAliveTimeout: 1 }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      } catch {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      deliveries.push({
        path: request.url,
        payload,
        hostId: request.headers['x-komla-ssh-host-id'] as string | undefined,
      });
      const headers = { 'Content-Type': 'application/json', Connection: 'close' };
      if (payload.kind === 'repository-snapshot') {
        response.writeHead(204, headers);
        response.end();
        return;
      }
      response.writeHead(200, headers);
      response.end('{"success":true}');
    });
  });
  return { server, deliveries };
}

function waitForCompanionSnapshot(
  deliveries: StatusDelivery[],
  workspaceId: string,
  predicate: (delivery: StatusDelivery) => boolean = () => true,
  timeoutMs = 20_000
): Promise<StatusDelivery> {
  return waitForStatusDelivery(
    deliveries,
    (candidate) =>
      candidate.path === '/api/v1/ssh-workspace-status' &&
      candidate.payload.kind === 'repository-snapshot' &&
      candidate.payload.workspaceId === workspaceId &&
      predicate(candidate),
    timeoutMs
  );
}

function companionSequence(delivery: StatusDelivery): number {
  return typeof delivery.payload.sequence === 'number' ? delivery.payload.sequence : 0;
}

function decodeCompanionStatus(delivery: StatusDelivery): string {
  const statusB64 = delivery.payload.statusB64;
  return typeof statusB64 === 'string' ? Buffer.from(statusB64, 'base64').toString('utf8') : '';
}

function decodeCompanionNumstat(delivery: StatusDelivery): string {
  const numstatB64 = delivery.payload.numstatB64;
  return typeof numstatB64 === 'string' ? Buffer.from(numstatB64, 'base64').toString('utf8') : '';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface DirectCompanion {
  backend: SshWorkspaceBackend;
  workspaceId: string;
  terminalId: string;
  recordPath: string;
  inbox: string;
  cleanup: () => Promise<void>;
}

async function startDirectCompanion(suffix: string): Promise<DirectCompanion> {
  const { sshWorkspaceService } = sshWorkspaceModule;
  const { remoteCompanionService } = remoteCompanionModule;
  await sshWorkspaceService.verifyAndPrepareHost(target.host);
  const backend = await createPreparedWorkspace(suffix);
  const workspaceId = `ssh-integration-${suffix}-workspace`;
  const terminalId = `ssh-integration-${suffix}-terminal`;
  const recordPath = `/tmp/companion-posts-${suffix}.jsonl`;
  const configPath = `/tmp/companion-config-${suffix}.json`;
  const inbox = `${target.resolvedBasePath}/helpers/companion-inbox`;
  const port =
    18770 + (Array.from(suffix).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 200);
  const binaryPath = await remoteCompanionService.ensureInstalled(
    target.host,
    target.resolvedBasePath
  );
  await container.exec([
    'sh',
    '-lc',
    [
      'set -eu',
      `rm -f ${shellQuote(recordPath)}`,
      `mkdir -p ${shellQuote(inbox)}`,
      'tmux -L komla-v1 new-session -d -s komla-direct-keep || true',
      `python3 - <<'PY' >/tmp/companion-http-${suffix}.log 2>&1 &`,
      'from http.server import BaseHTTPRequestHandler, HTTPServer',
      'import json',
      `RECORD = ${JSON.stringify(recordPath)}`,
      `PORT = ${port}`,
      'class Handler(BaseHTTPRequestHandler):',
      '    def do_POST(self):',
      "        raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))",
      '        payload = json.loads(raw)',
      "        with open(RECORD, 'a', encoding='utf-8') as handle:",
      "            handle.write(json.dumps({'path': self.path, 'payload': payload}) + '\\n')",
      "        if payload.get('kind') == 'repository-snapshot':",
      "            body = b''",
      '        else:',
      '            body = b\'{"success":true}\'',
      '        self.send_response(200)',
      "        self.send_header('Content-Type', 'application/json')",
      "        self.send_header('Content-Length', str(len(body)))",
      "        self.send_header('Connection', 'close')",
      '        self.end_headers()',
      '        self.wfile.write(body)',
      '    def log_message(self, *_args):',
      '        return',
      "HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()",
      'PY',
      'sleep 0.2',
    ].join('\n'),
  ]);
  const config = {
    endpoint: `http://127.0.0.1:${port}/api/v1/ssh-workspace-status`,
    installationId: `direct-${suffix}`,
    idleExitSeconds: 120,
    hookInbox: inbox,
    workspaces: [
      {
        workspaceId,
        workingTree: backend.remoteDirectory,
        targetBranch: 'main',
      },
    ],
  };
  await container.exec([
    'sh',
    '-lc',
    [
      `printf '%s\\n' ${shellQuote(JSON.stringify(config))} > ${shellQuote(configPath)}`,
      `nohup ${shellQuote(binaryPath)} __companion ${shellQuote(configPath)} >/tmp/companion-serve-${suffix}.log 2>&1 &`,
    ].join('\n'),
  ]);

  const cleanup = async () => {
    await container
      .exec(
        [
          'sh',
          '-lc',
          `pkill -f 'companion-config-${suffix}.json' || true; pkill -f "RECORD = \\"${recordPath}\\"" || true; tmux -L komla-v1 kill-session -t =komla-direct-keep || true`,
        ],
        { allowFailure: true }
      )
      .catch(() => {});
  };
  return { backend, workspaceId, terminalId, recordPath, inbox, cleanup };
}

async function waitForRecordedCompanionPost(
  recordPath: string,
  predicate: (post: StatusDelivery) => boolean,
  timeoutMs = 20_000
): Promise<StatusDelivery> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const recorded = await container.exec(['cat', recordPath], { allowFailure: true });
    const posts = recorded.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StatusDelivery);
    const match = posts.find(predicate);
    if (match) return match;
    await delay(100);
  }
  const recorded = await container.exec(['cat', recordPath], { allowFailure: true });
  const serveLog = await container.exec(
    ['sh', '-lc', 'ls /tmp/companion-serve-*.log 2>/dev/null | tail -1 | xargs -r cat'],
    {
      allowFailure: true,
    }
  );
  throw new Error(
    `Timed out waiting for companion post at ${recordPath}. recorded=${recorded.stdout}\nserve=${serveLog.stdout}`
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
