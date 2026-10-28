/**
 * Fixtures for the landing-page videos in e2e/videos/*.video.ts.
 *
 * A spec declares a `world` (projects, worktree workspaces and the scripted
 * agent's scenes), drives the app through `director`, and ends with
 * `director.finish()`. The recorder keeps raw CDP screencast frames plus a
 * timeline of cursor, click, shortcut and camera events; the cursor, key
 * badges, traffic lights and zoom are drawn afterwards by
 * scripts/render-videos.mjs, so the recorded app stays untouched.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  test as base,
  expect,
  type CDPSession,
  type ElectronApplication,
  type Locator,
  type Page,
  _electron,
} from '@playwright/test';

import { IPC } from '../../src/shared/constants/ipc-channels';
import { seedLicense } from '../demo-fixtures';
import { firstRendererWindow } from '../electron-app';
import {
  hostExec,
  publishOrigin,
  repaintSshTerminals,
  shellQuote,
  SSH_HOST_ID,
  startSshHost,
  stopSshHost,
  type VideoSshHost,
} from './ssh-host';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SANDBOX_DIR = '/tmp/komla-videos';
export const OUTPUT_DIR = path.join(__dirname, 'output');
const AGENT_SCRIPT = path.join(__dirname, 'scripted-agent.mjs');
// The scripted agent finds Komla's `port` file, `agent-status/` and `cues/` next to this.
const SCENES_FILE = path.join(SANDBOX_DIR, 'agent-scenes.json');
// Wrappers named like the real CLIs, so a pane shows `codex`, not a path to the scripted agent.
const BIN_DIR = path.join(SANDBOX_DIR, 'bin');
// Shells read their rc from here instead of the recording machine's.
const SHELL_DIR = path.join(SANDBOX_DIR, 'shell');
// Off the default port so a running Komla doesn't receive the agent hooks.
const NOTIFY_PORT = 52866;
// What the stand-in microphone plays; see VideoWorld.dictation.
const DICTATION_FILE = path.join(SANDBOX_DIR, 'dictation.wav');
// The pull requests the stand-in `gh` prints; see setPullRequest().
const GITHUB_DIR = path.join(SANDBOX_DIR, 'github');

// ── World ───────────────────────────────────────────────────────────────────

export type FileMap = Record<string, string>;

/** Scripted agent events; see e2e/videos/scripted-agent.mjs for rendering. */
export type AgentEvent = { delay?: number; verb?: string } & (
  | { think: number }
  | { say: string }
  /** `run` is a command it really runs in the workspace before showing the call. */
  | { tool: string; arg?: string; result?: string[]; run?: string }
  | { edit: string; find: string; replace: string }
  | { append: string; content: string }
  | { write: string; content: string }
  | { serve: string; port: number; command?: string }
  | {
      mcp: string;
      args?: Record<string, unknown>;
      show?: Record<string, unknown>;
      result?: string[];
    }
  | { waitFor: string }
  /** Applies the appearance settings in this workspace file, waiting while the user keeps or reverts them. */
  | { appearance: string }
  | { permission: { title: string; detail: string; message?: string } }
);

export interface AgentTurn {
  /** Type `prompt` into the agent after `afterMs` instead of waiting for input. */
  auto?: boolean;
  afterMs?: number;
  prompt?: string;
  verb?: string;
  doneVerb?: string;
  events: AgentEvent[];
}

export interface AgentScene {
  /** The CLI it looks like; Claude Code by default. */
  look?: 'claude' | 'codex';
  /** Terminal tab title the agent sets, like Claude Code's "✳ <task>". */
  title?: string;
  /** Claude Code's permission mode; follows the launch mode's flags by default. */
  mode?: 'default' | 'acceptEdits' | 'plan' | 'bypass';
  command?: string;
  /** Banner model and effort; Haiku 5.5 (Claude) or GPT-5.5 (Codex) with medium effort by default. */
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  displayCwd?: string;
  /** Conversation already on screen when the agent starts. */
  history?: Array<{
    prompt?: string;
    say?: string;
    tool?: string;
    arg?: string;
    result?: string[];
    done?: string;
  }>;
  turns?: AgentTurn[];
}

export interface VideoProject {
  id: string;
  name: string;
  color?: string;
  /** An SVG in `assets/icons/`, shown instead of the color dot. */
  icon?: string;
  files: FileMap;
}

export interface VideoWorkspace {
  id: string;
  projectId: string;
  title: string;
  branch: string;
  /** Commits on the branch, so the card shows it ahead of main. */
  commits?: Array<{ message: string; files: FileMap }>;
  /** Uncommitted changes present at launch. */
  changes?: FileMap;
  minutesAgo?: number;
  agent?: AgentScene;
  /** Stopped once Komla creates it on the SSH host, so its card is greyed out and ⌘↓ skips it. */
  stopped?: boolean;
}

/** An agent preset; its command runs the scripted agent. */
export interface VideoPreset {
  name: string;
  /** What a user would type, such as `codex`; the shells find a wrapper by that name. */
  command: string;
  /** The scene its agent plays wherever it starts; the workspace branch's scene when omitted. */
  scene?: string;
  launchModes?: Array<{ name: string; arguments: string; color?: string }>;
  /** Name of the launch mode it starts in; Default when omitted. */
  launchMode?: string;
}

export const CLAUDE_PRESET: VideoPreset = {
  name: 'Claude Code',
  command: 'claude',
  launchModes: [
    { name: 'Plan', arguments: '--permission-mode plan', color: 'blue' },
    { name: 'Accept edits', arguments: '--permission-mode acceptEdits', color: 'purple' },
    { name: 'Auto', arguments: '--permission-mode auto', color: 'orange' },
    {
      name: 'Dangerously skip permissions',
      arguments: '--dangerously-skip-permissions',
      color: 'red',
    },
  ],
  launchMode: 'Dangerously skip permissions',
};

export const CODEX_PRESET: VideoPreset = {
  name: 'Codex',
  command: 'codex',
  launchModes: [
    { name: 'Read only', arguments: '--sandbox read-only', color: 'blue' },
    {
      name: 'Workspace auto',
      arguments: '--sandbox workspace-write --ask-for-approval never',
      color: 'purple',
    },
    { name: 'YOLO', arguments: '--dangerously-bypass-approvals-and-sandbox', color: 'red' },
  ],
};

export interface VideoWorld {
  projects: VideoProject[];
  workspaces: VideoWorkspace[];
  /** Agent presets, the first one the default; just Claude Code when omitted. */
  presets?: VideoPreset[];
  /**
   * Scenes for agents started during the video, keyed by branch for workspaces
   * created on camera, or by the name an agent started with `agentCommand()`
   * plays. A workspace whose branch has no scene, such as one made in the new
   * workspace dialog, plays `default`.
   */
  spawnedAgents?: Record<string, AgentScene> & { default?: AgentScene };
  /** Runs every workspace on a Docker SSH host instead of locally. */
  sshHost?: { hostname: string; name: string };
  /**
   * Turns on dictation: the new workspace dialog records as it opens, and the
   * microphone hears `speech`, spoken by macOS `say`, which `model` then
   * transcribes for real. The model is linked from ~/.komla/models, so the
   * recording machine needs it downloaded.
   */
  dictation?: { speech: string; model: string };
  config?: Record<string, unknown>;
  /** Terminal settings, merged over the defaults (settings/terminal.json). */
  terminal?: Record<string, unknown>;
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Komla',
  GIT_AUTHOR_EMAIL: 'demo@komla.dev',
  GIT_COMMITTER_NAME: 'Komla',
  GIT_COMMITTER_EMAIL: 'demo@komla.dev',
};

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: gitEnv, stdio: 'ignore' });
}

function writeFiles(root: string, files: FileMap): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
}

function writeRemoteFiles(root: string, files: FileMap): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = shellQuote(path.posix.join(root, relativePath));
    const encoded = Buffer.from(content).toString('base64');
    hostExec(`mkdir -p "$(dirname ${fullPath})" && echo ${encoded} | base64 -d > ${fullPath}`);
  }
}

const branchKey = (branch: string) => branch.replace(/[^\w.-]/g, '_');

/** A workspace's place in the sidebar and when it was created and last active. */
function placement(workspace: VideoWorkspace, order: number, now: number) {
  const lastActivityAt = now - (workspace.minutesAgo ?? order * 7) * 60_000;
  return { order, createdAt: lastActivityAt - 3_600_000, lastActivityAt };
}

/** The scene key for workspaces whose branch has no scene of its own. */
export const DEFAULT_AGENT = 'default';

/** Resolves once the scripted agent for `branch` (or DEFAULT_AGENT) has finished `turns` turns. */
export async function waitForAgentTurn(branch: string, turns = 1, timeout = 30_000): Promise<void> {
  const statusFile = path.join(SANDBOX_DIR, 'agent-status', `${branchKey(branch)}.json`);
  await expect
    .poll(
      () => {
        try {
          return JSON.parse(fs.readFileSync(statusFile, 'utf8')).turnsCompleted as number;
        } catch {
          return 0;
        }
      },
      { timeout, intervals: [100] }
    )
    .toBeGreaterThanOrEqual(turns);
}

/** Resolves once the scripted agent on `branch` is waiting at `{ waitFor: cue }`. */
export async function waitForAgentAt(branch: string, cue: string, timeout = 60_000): Promise<void> {
  const marker = path.join(SANDBOX_DIR, 'agent-status', `${branchKey(branch)}.at-${cue}`);
  await expect.poll(() => fs.existsSync(marker), { timeout, intervals: [100] }).toBe(true);
}

/**
 * Opens a blank browser to the right of the terminal on screen, as its menu's Split Right ▸
 * Browser does. A page the workspace's agent opens next shows there, beside it.
 */
export async function openBrowserBeside(page: Page): Promise<void> {
  const terminal = page.locator('.xterm-screen').filter({ visible: true }).first();
  await terminal.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Choose what opens to the right' }).click();
  await page.getByRole('menuitem', { name: 'Browser', exact: true }).click();
}

/**
 * The command line that starts the scripted agent, playing the scene for its
 * branch, or `scene` from the world's spawnedAgents.
 */
export function agentCommand(world: VideoWorld, scene?: string): string {
  // The sandbox and this directory are mounted at the same paths on the SSH
  // host, so one command line works on either side.
  const node = world.sshHost ? 'node' : `"${process.execPath}"`;
  const scenesFile = path.join(fs.realpathSync(SANDBOX_DIR), path.basename(SCENES_FILE));
  return `${node} "${fs.realpathSync(AGENT_SCRIPT)}" --scenes "${scenesFile}"${scene ? ` --scene ${shellQuote(scene)}` : ''}`;
}

/**
 * Writes `bin/<command>`, which starts the scripted agent as the preset's CLI,
 * passing what follows the command (the launch mode's flags) after `--` so the
 * agent can show the command line as typed. Returns the wrapper's path.
 */
function writeAgentWrapper(world: VideoWorld, preset: VideoPreset): string {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const wrapper = path.join(fs.realpathSync(BIN_DIR), preset.command);
  const scene = preset.scene ? ` --scene ${shellQuote(preset.scene)}` : '';
  fs.writeFileSync(
    wrapper,
    `#!/bin/sh\nexec ${agentCommand(world)}${scene} --as ${preset.command} -- "$@"\n`,
    { mode: 0o755 }
  );
  return wrapper;
}

/** A pull request as `gh pr view --json` prints it; see setPullRequest(). */
export interface VideoPullRequest {
  number: number;
  title: string;
  reviewDecision?: 'REVIEW_REQUIRED' | 'APPROVED' | 'CHANGES_REQUESTED';
  checks: Array<{ name: string; workflowName?: string; state: 'pending' | 'passed' | 'failed' }>;
}

/**
 * Writes `bin/gh`, which stands in for the GitHub CLI in a local world: `gh pr view` prints the
 * branch's pull request from setPullRequest() once the branch is pushed, as GitHub has one only
 * then, through its `--jq` filter, and other commands, such as `gh pr create`, do nothing.
 */
function writeGhStandIn(): void {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.mkdirSync(GITHUB_DIR, { recursive: true });
  const script = `#!/bin/sh
[ "$1 $2" = "pr view" ] || exit 0
query=.
while [ $# -gt 0 ]; do
  [ "$1" = --jq ] && query=$2
  shift
done
branch=$(git branch --show-current)
file=${shellQuote(fs.realpathSync(GITHUB_DIR))}/$(printf %s "$branch" | tr -c 'A-Za-z0-9._-' _).json
if git rev-parse --verify --quiet '@{u}' >/dev/null && [ -f "$file" ]; then exec jq -c -r "$query" "$file"; fi
echo "no pull requests found for branch \\"$branch\\"" >&2
exit 1
`;
  fs.writeFileSync(path.join(BIN_DIR, 'gh'), script, { mode: 0o755 });
}

/** Sets what the stand-in `gh` says about the branch's pull request; see writeGhStandIn(). */
export function setPullRequest(branch: string, pullRequest: VideoPullRequest): void {
  const { checks, ...rest } = pullRequest;
  const json = {
    ...rest,
    url: `https://github.com/acme/acme-web/pull/${pullRequest.number}`,
    state: 'OPEN',
    isDraft: false,
    reviewDecision: pullRequest.reviewDecision ?? 'REVIEW_REQUIRED',
    statusCheckRollup: checks.map(({ name, workflowName, state }) => ({
      __typename: 'CheckRun',
      name,
      workflowName,
      status: state === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: state === 'pending' ? '' : state === 'passed' ? 'SUCCESS' : 'FAILURE',
      detailsUrl: `https://github.com/acme/acme-web/actions/runs/${pullRequest.number}`,
    })),
  };
  fs.writeFileSync(path.join(GITHUB_DIR, `${branchKey(branch)}.json`), JSON.stringify(json));
}

/** Komla's ids for a preset and for the launch mode it starts in. */
function presetIds(preset: VideoPreset): { presetId: string; launchModeId: string | null } {
  const presetId = `video-${preset.command}`;
  const mode = (preset.launchModes ?? []).findIndex(({ name }) => name === preset.launchMode);
  return { presetId, launchModeId: mode < 0 ? null : `${presetId}-${mode}` };
}

/** Pins the preset and its mode for agent launches, which agents may then always start. */
function agentLaunchPin(preset: VideoPreset) {
  const { presetId, launchModeId } = presetIds(preset);
  return launchModeId
    ? { agentLaunchDefaultPresetId: presetId, agentLaunchDefaultLaunchModeId: launchModeId }
    : {};
}

/** Seeds the sandbox, starting the SSH host when the world has one. */
function seedWorld(world: VideoWorld): VideoSshHost | null {
  stopSshHost();
  // Emptied rather than removed: Docker Desktop goes on showing the SSH host a removed folder,
  // empty, in place of a new one at the same path.
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });
  for (const entry of fs.readdirSync(SANDBOX_DIR)) {
    fs.rmSync(path.join(SANDBOX_DIR, entry), { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(SANDBOX_DIR, 'settings'), { recursive: true });
  seedLicense(SANDBOX_DIR);

  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'config.json'),
    JSON.stringify({
      agentSetupComplete: true,
      usageTelemetryConsentAnswered: true,
      showTipsInToolbar: false,
      notificationPort: NOTIFY_PORT,
      notificationsEnabled: true,
      autoNameBranches: false,
      // A clean status bar; showClaudeUsage() adds the usage item once it's stubbed.
      statusBarHiddenItems: ['notification-sounds', 'commit-graph'],
      showEditorInToolbar: false,
      // The new workspace dialog starts where the last workspace ran.
      ...(world.sshHost ? { lastWorkspaceEnvironment: { kind: 'ssh', hostId: SSH_HOST_ID } } : {}),
      // Agents start in Default unless pinned, so spawned agents run in the default agent's mode.
      ...agentLaunchPin(world.presets?.[0] ?? CLAUDE_PRESET),
      ...(world.dictation
        ? {
            voice: {
              modelId: world.dictation.model,
              modelPath: null,
              enabled: true,
              autoRecord: true,
              transcribeAction: 'fill',
            },
          }
        : {}),
      ...world.config,
    })
  );
  if (world.dictation) {
    const { model, speech } = world.dictation;
    const modelDir = path.join(os.homedir(), '.komla', 'models', model);
    if (!fs.existsSync(modelDir)) {
      throw new Error(`Dictation needs the ${model} model; download it in Komla's settings.`);
    }
    fs.mkdirSync(path.join(SANDBOX_DIR, 'models'));
    fs.symlinkSync(modelDir, path.join(SANDBOX_DIR, 'models', model));
    // A breath before the words, as when someone starts talking.
    execFileSync('say', [
      '-v',
      'Samantha',
      '-o',
      DICTATION_FILE,
      '--file-format=WAVE',
      '--data-format=LEI16@16000',
      `[[slnc 300]] ${speech}`,
    ]);
  }
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'settings', 'theme.json'),
    JSON.stringify({ mode: 'dark' })
  );
  if (world.terminal) {
    fs.writeFileSync(
      path.join(SANDBOX_DIR, 'settings', 'terminal.json'),
      JSON.stringify(world.terminal)
    );
  }

  const now = Date.now();
  const repoDirs = new Map<string, string>();
  world.projects.forEach((project) => {
    const repoDir = path.join(SANDBOX_DIR, 'repos', project.name);
    fs.mkdirSync(repoDir, { recursive: true });
    git(repoDir, ['init', '-b', 'main']);
    writeFiles(repoDir, project.files);
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'Initial commit']);
    repoDirs.set(project.id, repoDir);
    // On the SSH host, publishOrigin() gives it an origin there.
    if (!world.sshHost) {
      const origin = path.join(SANDBOX_DIR, 'origin', `${project.name}.git`);
      git(SANDBOX_DIR, ['clone', '--quiet', '--bare', repoDir, origin]);
      git(repoDir, ['remote', 'add', 'origin', origin]);
      git(repoDir, ['fetch', '--quiet', 'origin']);
    }
  });
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'settings', 'projects.json'),
    JSON.stringify({
      _version: 1,
      projects: world.projects.map((project, order) => ({
        id: project.id,
        name: project.name,
        kind: 'git',
        baseBranch: 'main',
        repositoryPath: repoDirs.get(project.id),
        defaultBranchPrefix: '',
        createdAt: now,
        order,
        managed: false,
        ...(world.sshHost ? { sshWorkspaceMode: 'remote' } : {}),
        ...(project.color ? { color: project.color } : {}),
        ...(project.icon ? { icon: svgDataUrl(project.icon) } : {}),
      })),
    })
  );

  const scenes: Record<string, AgentScene> = { ...world.spawnedAgents };
  for (const workspace of world.workspaces) {
    const project = world.projects.find((p) => p.id === workspace.projectId)!;
    // On the SSH host the agent shows its real remote path.
    const displayCwd = world.sshHost ? undefined : `~/code/${project.name}`;
    scenes[workspace.branch] = { displayCwd, ...workspace.agent };
  }
  fs.writeFileSync(SCENES_FILE, JSON.stringify(scenes));

  // Locally the worktrees are seeded here; on the SSH host Komla creates them
  // once the app is up (see createSshWorkspaces).
  const workspaces = world.sshHost
    ? []
    : world.workspaces.map((workspace, order) => {
        const project = world.projects.find((p) => p.id === workspace.projectId)!;
        const dir = path.join(SANDBOX_DIR, 'worktrees', project.name, branchKey(workspace.branch));
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        git(repoDirs.get(project.id)!, ['worktree', 'add', '-b', workspace.branch, dir]);
        for (const commit of workspace.commits ?? []) {
          writeFiles(dir, commit.files);
          git(dir, ['add', '-A']);
          git(dir, ['commit', '-m', commit.message]);
        }
        writeFiles(dir, workspace.changes ?? {});
        return {
          id: workspace.id,
          name: workspace.title,
          customName: workspace.title,
          workingDirectory: dir,
          branchName: workspace.branch,
          isWorktree: true,
          projectId: workspace.projectId,
          windowId: null,
          categoryId: null,
          ...placement(workspace, order, now),
          terminals: [],
        };
      });
  fs.writeFileSync(path.join(SANDBOX_DIR, 'workspaces.json'), JSON.stringify(workspaces));

  // A plain prompt, and the agent wrappers ahead of any real CLI of the same name, also in the
  // login shells Komla runs its own commands in, such as `gh` for the pull request item.
  fs.mkdirSync(SHELL_DIR);
  const binPath = `path=(${shellQuote(BIN_DIR)} $path)\n`;
  fs.writeFileSync(
    path.join(SHELL_DIR, '.zshrc'),
    `${binPath}PROMPT='%F{blue}%1~%f %F{magenta}❯%f '\n`
  );
  fs.writeFileSync(path.join(SHELL_DIR, '.zprofile'), binPath);
  writeGhStandIn();

  const presets = (world.presets ?? [CLAUDE_PRESET]).map((preset) => {
    const { presetId: id, launchModeId } = presetIds(preset);
    const launchModes = (preset.launchModes ?? []).map((mode, i) => ({
      id: `${id}-${i}`,
      ...mode,
    }));
    const wrapper = writeAgentWrapper(world, preset);
    // The SSH host doesn't read the local rc, so it runs the wrapper by path.
    const command = world.sshHost ? wrapper : preset.command;
    return {
      id,
      name: preset.name,
      openCommand: `${command} {{launchMode}}`,
      continueCommand: `${command} {{launchMode}}`,
      promptCommand: `${command} {{launchMode}} --prompt {{prompt}}`,
      launchModes,
      isBuiltin: true,
      launchModeId,
    };
  });
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'settings', 'agent-presets.json'),
    JSON.stringify({
      // Current, so no migration rewrites the scripted agents' commands.
      _version: 1,
      presets: presets.map(({ launchModeId: _launchModeId, ...preset }) => preset),
      // The most recently used one is the default.
      activePresets: presets.map((preset, i) => ({
        presetId: preset.id,
        lastUsedAt: now - i,
        lastLaunchModeId: preset.launchModeId,
      })),
    })
  );

  if (!world.sshHost) return null;
  const host = startSshHost({ sandboxDir: SANDBOX_DIR, ...world.sshHost });
  world.projects.forEach((project) => publishOrigin(repoDirs.get(project.id)!, project.name));
  return host;
}

/** Saves the SSH host in Komla and has Komla create each workspace on it. */
async function createSshWorkspaces(
  page: Page,
  world: VideoWorld,
  host: VideoSshHost
): Promise<void> {
  await page.evaluate((h) => window.api.saveSshHost(h), host);
  // Workspaces show in the window whose id they carry; the renderer reads its id from the URL.
  const windowId = await page.evaluate(() => new URLSearchParams(location.search).get('windowId'));
  // In the default preset's launch mode, which Komla then remembers as the last one used.
  const { presetId, launchModeId } = presetIds((world.presets ?? [CLAUDE_PRESET])[0]);
  const now = Date.now();
  for (const [order, workspace] of world.workspaces.entries()) {
    const created = await page.evaluate((params) => window.api.createWorkspace(params), {
      mode: 'worktree' as const,
      projectId: workspace.projectId,
      branchName: workspace.branch,
      useExactBranchName: true,
      customName: workspace.title,
      environment: { kind: 'ssh' as const, hostId: host.id },
      windowId: windowId ?? undefined,
      presetId,
      launchModeId: launchModeId ?? undefined,
    });
    if ('__workspaceCreateError' in created) {
      throw new Error(
        `Creating ${workspace.branch} on the SSH host failed: ${JSON.stringify(created)}`
      );
    }
    // An SSH workspace's workingDirectory is an ssh:// URL; the path on the host is in its backend.
    const dir = (created as { backend: { remoteDirectory: string } }).backend.remoteDirectory;
    for (const commit of workspace.commits ?? []) {
      writeRemoteFiles(dir, commit.files);
      hostExec(
        `cd ${shellQuote(dir)} && git add -A && git commit --quiet -m ${shellQuote(commit.message)}`
      );
    }
    writeRemoteFiles(dir, workspace.changes ?? {});
    // As seeded locally, rather than all just created, newest first.
    const { id } = created as { id: string };
    await page.evaluate(({ id, updates }) => window.api.updateWorkspace(id, updates), {
      id,
      updates: placement(workspace, order, now),
    });
    // Its agent's tmux session can still be starting, and come up after the stop
    // killed it, which fails the stop; again once it is up.
    if (workspace.stopped) {
      await expect(() => page.evaluate((id) => window.api.stopWorkspace(id), id)).toPass({
        intervals: [1000],
        timeout: 20_000,
      });
    }
  }
  // Workspaces created over IPC don't reach the renderer's store until it reloads.
  await page.reload();
  await expect(
    world.workspaces.length
      ? page.getByRole('button', { name: `Workspace details for ${world.workspaces[0].title}` })
      : page.getByRole('button', { name: 'New Workspace', exact: true }).first()
  ).toBeVisible({ timeout: 30_000 });
}

/**
 * Stands in for the microphone: each recording hears the dictation from its
 * start, once, through Komla's own capture and transcription. Chromium's fake
 * capture device can't read a file from inside its sandbox.
 */
async function fakeMicrophone(page: Page): Promise<void> {
  const wav = fs.readFileSync(DICTATION_FILE).toString('base64');
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      const speech = context.createBufferSource();
      speech.buffer = await context.decodeAudioData(bytes.slice().buffer);
      const microphone = context.createMediaStreamDestination();
      speech.connect(microphone);
      speech.start();
      return microphone.stream;
    };
  }, wav);
}

function svgDataUrl(icon: string): string {
  const svg = fs.readFileSync(path.join(__dirname, 'assets', 'icons', icon));
  return `data:image/svg+xml;base64,${svg.toString('base64')}`;
}

/** A Dev server quick command, last used so the run button shows it. */
async function addDevServerCommand(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const action = await window.api.createAction({
      title: 'Dev server',
      content: 'npm run dev',
      type: 'command',
    });
    await window.api.recordActionUsage(action.id);
  });
}

/**
 * Shows the Claude Code usage item with a made-up plan. Komla would otherwise
 * read the recording machine's sign-in from the Keychain, so the usage
 * handlers are replaced before the item is turned on and first asks for it.
 */
async function showClaudeUsage(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, channels) => {
      const now = Date.now();
      const hour = 60 * 60 * 1000;
      const usage = {
        'claude-code': {
          source: 'claude-code',
          windows: [
            { name: '5-hour limit', short: '5h', usedPercent: 23, resetsAt: now + 3 * hour },
            { name: 'Weekly limit', short: 'wk', usedPercent: 41, resetsAt: now + 74 * hour },
          ],
          plan: 'max',
          account: null,
          readAt: now,
          problem: null,
        },
      };
      for (const channel of channels) {
        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, () => usage);
      }
    },
    [IPC.AGENT_USAGE_GET, IPC.AGENT_USAGE_REFRESH]
  );
  await page.evaluate(() =>
    window.api.updateConfig({ statusBarShownItems: ['claude-code-usage'] })
  );
  // Main sends a saved config to every window but the one that saved it, whose store would
  // otherwise only learn of it from its own updateConfig().
  const config = await page.evaluate(() => window.api.getConfig());
  await app.evaluate(
    ({ BrowserWindow }, [channel, config]) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(channel, config);
      }
    },
    [IPC.CONFIG_CHANGED, config] as const
  );
}

/**
 * Dismisses the notice that the agent hooks installed on this machine differ
 * from what this build installs, which they always do since the videos use
 * their own notify port. It shows about 20s after the SSH setup finishes.
 */
async function dismissIntegrationUpdateNotice(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Dismiss notification update notice' })
    .click({ timeout: 60_000 })
    .catch(() => undefined);
}

// ── Recording ───────────────────────────────────────────────────────────────

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What scripts/render-videos.mjs produces from a recording. */
export interface VideoOutput {
  /** Base name under the site's public/screenshots, e.g. landing-diff-demo-cropped-dark. */
  name: string;
  width: number;
  height: number;
  fps?: number;
  /** Default framing in CSS px; the whole window when omitted. */
  frame?: Rect;
  /** Seconds of crossfade from the last frame back into the first, so loops are seamless. */
  loopFade?: number;
}

type TimelineEvent = { t: number; type: string } & Record<string, unknown>;

/**
 * Native views over the window (the browser preview, toasts) aren't part of
 * the page's screencast, so their frames and on-screen bounds are captured in
 * the main process and composited in by the renderer.
 */
interface LayerCapture {
  frames: Array<{ layer: number; file: string; t: number }>;
  layouts: Array<{ t: number; rects: Array<Rect & { layer: number }> }>;
}

async function startLayerCapture(app: ElectronApplication, dir: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'layers'), { recursive: true });
  await app.evaluate(async ({ BrowserWindow }, layerDir) => {
    const writeFile = process.getBuiltinModule('node:fs').writeFileSync;
    const win = BrowserWindow.getAllWindows()[0];
    const ids = new Map<unknown, number>();
    const capture: LayerCapture & { stop?: () => void } = { frames: [], layouts: [] };
    const lastFrameAt = new Map<number, number>();
    const pending = new Map<
      number,
      { view: Electron.WebContentsView; image: Electron.NativeImage; t: number }
    >();
    const save = (layer: number) => {
      const frame = pending.get(layer);
      if (!frame) return;
      pending.delete(layer);
      lastFrameAt.set(layer, frame.t);
      // The toast overlay is see-through, so it keeps its alpha; previews are opaque.
      const png = frame.view.webContents.getURL().endsWith('/toast-overlay.html');
      const file = `layers/${layer}-${capture.frames.length}.${png ? 'png' : 'jpg'}`;
      writeFile(`${layerDir}/${file}`, png ? frame.image.toPNG() : frame.image.toJPEG(90));
      capture.frames.push({ layer, file, t: frame.t });
    };
    let lastLayout = '';
    const track = () => {
      const views = win.contentView.children.filter(
        (view): view is Electron.WebContentsView => 'webContents' in view
      );
      for (const view of views) {
        if (ids.has(view)) continue;
        const layer = ids.size;
        ids.set(view, layer);
        view.webContents.beginFrameSubscription(false, (image) => {
          if (image.isEmpty()) return;
          const t = Date.now() / 1000;
          const queued = pending.has(layer);
          pending.set(layer, { view, image, t });
          // About 30 fps is plenty and keeps encoding off the main thread's back. A
          // view only sends frames when it repaints, so the last one of a burst is
          // saved late rather than dropped.
          const wait = 0.03 - (t - (lastFrameAt.get(layer) ?? 0));
          if (wait <= 0) save(layer);
          else if (!queued) setTimeout(() => save(layer), wait * 1000);
        });
      }
      const rects = views
        .filter((view) => view.getVisible())
        .map((view) => ({ ...view.getBounds(), layer: ids.get(view)! }))
        .filter((rect) => rect.width > 0 && rect.height > 0);
      const layout = JSON.stringify(rects);
      if (layout !== lastLayout) {
        lastLayout = layout;
        capture.layouts.push({ t: Date.now() / 1000, rects });
      }
      return views;
    };
    const poll = setInterval(track, 16);
    // A view only sends a frame once it repaints, so take what each visible one
    // shows now; otherwise the video opens with nothing drawn over it.
    const visible = track().filter((view) => view.getVisible());
    await Promise.all(
      visible.map(async (view) => {
        const image = await view.webContents.capturePage();
        const layer = ids.get(view)!;
        if (image.isEmpty() || pending.has(layer) || lastFrameAt.has(layer)) return;
        pending.set(layer, { view, image, t: Date.now() / 1000 });
        save(layer);
      })
    );
    capture.stop = () => {
      clearInterval(poll);
      for (const view of ids.keys()) {
        (view as Electron.WebContentsView).webContents.endFrameSubscription();
      }
      for (const layer of [...pending.keys()]) save(layer);
    };
    (globalThis as { __videoLayers?: typeof capture }).__videoLayers = capture;
  }, dir);
}

async function stopLayerCapture(app: ElectronApplication): Promise<LayerCapture> {
  return app.evaluate(() => {
    const capture = (globalThis as { __videoLayers?: LayerCapture & { stop: () => void } })
      .__videoLayers!;
    capture.stop();
    return { frames: capture.frames, layouts: capture.layouts };
  });
}

class Recorder {
  private cdp?: CDPSession;
  private frames: Array<{ file: string; t: number; received: number }> = [];
  private events: TimelineEvent[] = [];
  private writes: Promise<void>[] = [];
  private startedAt = 0;
  private stopped?: { at: number; layers: LayerCapture; dpr: number };

  constructor(
    private readonly app: ElectronApplication,
    private readonly page: Page,
    private readonly dir: string
  ) {}

  now(): number {
    return Date.now() / 1000;
  }

  log(type: string, data: Record<string, unknown> = {}): void {
    this.events.push({ t: this.now(), type, ...data });
  }

  async start(): Promise<void> {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.dir, 'frames'), { recursive: true });
    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (frame) => {
      const file = `frames/${String(this.frames.length).padStart(5, '0')}.jpg`;
      this.frames.push({ file, t: frame.metadata.timestamp ?? this.now(), received: this.now() });
      this.writes.push(fs.promises.writeFile(path.join(this.dir, file), frame.data, 'base64'));
      void this.cdp!.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(
        () => undefined
      );
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92 });
    await startLayerCapture(this.app, this.dir);
    this.startedAt = this.now();
  }

  /** Stops recording while the app is still up; `save()` writes the timeline. */
  async stop(): Promise<void> {
    const at = this.now();
    await this.cdp!.send('Page.stopScreencast');
    const layers = await stopLayerCapture(this.app);
    await Promise.all(this.writes);
    const dpr = await this.page.evaluate(() => window.devicePixelRatio);
    this.stopped = { at, layers, dpr };
  }

  save(
    output: VideoOutput,
    viewport: { width: number; height: number },
    extra: Record<string, unknown> = {}
  ): void {
    const { at, layers, dpr } = this.stopped!;
    fs.writeFileSync(
      path.join(this.dir, 'timeline.json'),
      JSON.stringify(
        {
          output,
          viewport,
          dpr,
          start: this.startedAt,
          end: at,
          frames: this.frames,
          layers,
          events: this.events,
          ...extra,
        },
        null,
        1
      )
    );
  }
}

// ── Director ────────────────────────────────────────────────────────────────

type Target = Locator | { x: number; y: number };

const KEY_GLYPHS: Record<string, string> = {
  Meta: '⌘',
  Control: '⌃',
  Alt: '⌥',
  Shift: '⇧',
  Enter: '↵',
  Escape: 'esc',
  Backspace: '⌫',
  Tab: '⇥',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backslash: '\\',
};

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

export class Director {
  private cursor: { x: number; y: number } | null = null;
  private speedFactor = 1;
  private recorder: Recorder;
  /** Takes before the current one, with the caption that follows each. */
  private readonly takes: Array<{ recorder: Recorder; caption: string }> = [];

  constructor(
    app: ElectronApplication,
    private page: Page,
    readonly viewport: { width: number; height: number },
    private readonly outputDir: string,
    private readonly onSshHost: boolean
  ) {
    this.recorder = new Recorder(app, page, outputDir);
  }

  /** Starts recording. Everything before this call is setup and not in the video. */
  async start(): Promise<void> {
    // A terminal Komla attaches to an agent already drawing on the host can keep
    // stray cells, which tmux never sends again since its own screen lacks them.
    if (this.onSshHost) {
      repaintSshTerminals();
      await this.page.waitForTimeout(300);
    }
    await this.recorder.start();
  }

  /**
   * Ends this take, before the app quits. The video cuts to `caption` on a dark
   * frame, then to the take `resume()` starts.
   */
  async cut(caption: string): Promise<void> {
    await this.recorder.stop();
    this.takes.push({ recorder: this.recorder, caption });
  }

  /** Starts the next take, in `page` of the relaunched `app`. */
  async resume(app: ElectronApplication, page: Page): Promise<void> {
    this.page = page;
    this.cursor = null;
    this.recorder = new Recorder(
      app,
      page,
      path.join(this.outputDir, `take-${this.takes.length + 1}`)
    );
    await this.start();
  }

  async finish(output: VideoOutput): Promise<void> {
    await this.recorder.stop();
    const [first, ...later] = [...this.takes.map((take) => take.recorder), this.recorder];
    first.save(output, this.viewport, {
      takes: this.takes.map((take, i) => ({ dir: `take-${i + 2}`, caption: take.caption })),
    });
    for (const recorder of later) recorder.save(output, this.viewport);
  }

  async hold(seconds: number): Promise<void> {
    await this.page.waitForTimeout(seconds * 1000);
  }

  async moveTo(target: Target, { duration = 0.7 } = {}): Promise<{ x: number; y: number }> {
    const to = await this.pointOf(target);
    // A cursor's first move comes in from below right, where it fades in.
    const from = this.cursor ?? { x: to.x + 160, y: to.y + 140 };
    const startedAt = Date.now();
    const total = duration * 1000;
    for (;;) {
      const progress = Math.min(1, (Date.now() - startedAt) / total);
      const eased = easeInOut(progress);
      const point = { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
      await this.page.mouse.move(point.x, point.y);
      this.recorder.log('cursor', point);
      if (progress >= 1) break;
      await this.page.waitForTimeout(12);
    }
    this.cursor = to;
    return to;
  }

  /** Clicks `target`; held `modifiers` show as a key badge, as in ⇧ Click. */
  async click(
    target: Target,
    {
      duration = 0.7,
      button = 'left' as 'left' | 'right',
      modifiers = [] as Array<'Shift' | 'Alt'>,
    } = {}
  ): Promise<void> {
    const point = await this.moveTo(target, { duration });
    for (const key of modifiers) await this.page.keyboard.down(key);
    if (modifiers.length) {
      this.recorder.log('keys', { keys: [...modifiers.map((key) => KEY_GLYPHS[key]), 'Click'] });
    }
    await this.page.waitForTimeout(90);
    this.recorder.log('click', point);
    await this.page.mouse.down({ button });
    await this.page.waitForTimeout(70);
    await this.page.mouse.up({ button });
    for (const key of modifiers) await this.page.keyboard.up(key);
  }

  /** Presses at `from`, moves to `to` over `duration` seconds and lets go. */
  async drag(from: Target, to: Target, { duration = 0.9 } = {}): Promise<void> {
    const point = await this.moveTo(from, { duration: 0.6 });
    await this.page.waitForTimeout(90);
    this.recorder.log('mouseDown', point);
    await this.page.mouse.down();
    // A small first step starts the drag before the long move.
    await this.page.mouse.move(point.x + 4, point.y + 4);
    await this.page.waitForTimeout(80);
    await this.moveTo(to, { duration });
    await this.page.waitForTimeout(120);
    await this.page.mouse.up();
    this.recorder.log('mouseUp', this.cursor!);
  }

  /** Types into the focused element with a human cadence. Hides the cursor until it next moves. */
  async type(text: string, { delay = 45 } = {}): Promise<void> {
    this.recorder.log('cursorHide');
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await this.page.waitForTimeout(delay * (0.6 + Math.random() * 0.8));
    }
  }

  /** Presses a shortcut and shows it as a key badge in the video. */
  async press(keys: string, { badge = true } = {}): Promise<void> {
    if (badge) this.showKeys(keys);
    // ⌘ in the badge, Ctrl on Linux dry runs, where the app binds Ctrl.
    await this.page.keyboard.press(keys.replace(/\bMeta\b/g, 'ControlOrMeta'));
  }

  /** Shows a shortcut's key badge without pressing it, for one the spec carries out itself. */
  showKeys(keys: string): void {
    this.recorder.log('keys', {
      keys: keys.split('+').map((key) => KEY_GLYPHS[key] ?? key.toUpperCase()),
    });
  }

  /**
   * Eases the camera onto a region (CSS px) over `duration` seconds of video,
   * whatever the speed. `'full'` returns to the default framing. The renderer
   * widens the region to the output aspect ratio.
   */
  async camera(
    target: Locator | Rect | 'full',
    { duration = 0.9, padding = 24 } = {}
  ): Promise<void> {
    let rect: Rect | null = null;
    if (target !== 'full') {
      const box = 'boundingBox' in target ? await target.boundingBox() : target;
      if (!box) throw new Error('camera target is not visible');
      rect = {
        x: box.x - padding,
        y: box.y - padding,
        width: box.width + padding * 2,
        height: box.height + padding * 2,
      };
    }
    this.recorder.log('camera', { rect, duration });
  }

  /** Releases the scripted agent on `branch` waiting at `{ waitFor: name }`. */
  cue(branch: string, name: string): void {
    const cueFile = path.join(SANDBOX_DIR, 'cues', branchKey(branch), name);
    fs.mkdirSync(path.dirname(cueFile), { recursive: true });
    fs.writeFileSync(cueFile, '');
  }

  /** Plays what follows at `factor`× in the video, until the next call (1 restores real time). */
  speed(factor: number): void {
    this.speedFactor = factor;
    this.recorder.log('speed', { factor });
  }

  /**
   * Runs `setup` out of the video, as a jump cut: staging the camera shouldn't see, such as
   * laying out a workspace created mid-take. Drive the page directly in it, not the director.
   */
  async offCamera(setup: () => Promise<void>): Promise<void> {
    const factor = this.speedFactor;
    this.recorder.log('speed', { factor: 1e6 });
    await setup();
    // Back where the drawn cursor is, so nothing shows a hover it isn't on.
    if (this.cursor) await this.page.mouse.move(this.cursor.x, this.cursor.y);
    this.recorder.log('speed', { factor });
  }

  /** Uses this moment as the poster image; the last frame before the loop fade when never called. */
  poster(): void {
    this.recorder.log('poster');
  }

  private async pointOf(target: Target): Promise<{ x: number; y: number }> {
    if (!('boundingBox' in target)) return target;
    const box = await target.boundingBox();
    if (!box) throw new Error('cursor target is not visible');
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
}

// ── Fixture ─────────────────────────────────────────────────────────────────

async function launchApp(): Promise<ElectronApplication> {
  const { CLAUDECODE: _claudeCode, ...env } = process.env;
  return _electron.launch({
    // Launch the repo as the app, as a dev run does, so the app path resolves
    // native/artifacts and SSH hosts get the companion that pushes
    // git status. Launching out/main/index.js directly would miss it.
    args: [path.join(__dirname, '..', '..')],
    env: {
      ...env,
      KOMLA_DATA_DIR: SANDBOX_DIR,
      NODE_ENV: 'test',
      // Keep the seeded license from being revoked by the real server.
      KOMLA_API_URL: 'http://localhost:0',
      // Shells run zsh with the sandbox's rc, also when recording from inside
      // Komla, whose shells pass on the user's rc as __KOMLA_ORIG_ZDOTDIR.
      SHELL: '/bin/zsh',
      ZDOTDIR: SHELL_DIR,
      __KOMLA_ORIG_ZDOTDIR: SHELL_DIR,
    },
  });
}

async function sizeWindow(
  app: ElectronApplication,
  page: Page,
  size: { width: number; height: number }
): Promise<void> {
  await app.evaluate(({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setContentSize(size.width, size.height);
    win.center();
  }, size);
  await expect
    .poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight]))
    .toEqual([size.width, size.height]);
}

/**
 * Opens Komla again on the same sandbox, as after quitting it, in a window of
 * `windowSize`. The test closes the app it returns.
 */
export async function relaunchApp(windowSize: {
  width: number;
  height: number;
}): Promise<{ app: ElectronApplication; page: Page }> {
  // Saved as shown, the usage item would read before showClaudeUsage() stubs it.
  const configFile = path.join(SANDBOX_DIR, 'config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fs.writeFileSync(configFile, JSON.stringify({ ...config, statusBarShownItems: [] }));
  const app = await launchApp();
  const page = await firstRendererWindow(app);
  await sizeWindow(app, page, windowSize);
  await showClaudeUsage(app, page);
  return { app, page };
}

interface VideoFixtures {
  world: VideoWorld;
  windowSize: { width: number; height: number };
  sshHost: VideoSshHost | null;
  electronApp: ElectronApplication;
  appWindow: Page;
  director: Director;
}

export const videoTest = base.extend<VideoFixtures>({
  world: [{ projects: [], workspaces: [] }, { option: true }],
  windowSize: [{ width: 1280, height: 736 }, { option: true }],

  // Building and starting the SSH host takes longer than a test's default timeout.
  sshHost: [
    async ({ world }, provide) => {
      const host = seedWorld(world);
      await provide(host);
      if (host) stopSshHost();
    },
    { timeout: 600_000 },
  ],

  electronApp: async ({ sshHost: _sshHost }, provide) => {
    const app = await launchApp();
    await provide(app);
    await app.close().catch(() => undefined);
  },

  appWindow: [
    async ({ electronApp, windowSize, world, sshHost }, provide) => {
      const page = await firstRendererWindow(electronApp);
      await sizeWindow(electronApp, page, windowSize);
      await showClaudeUsage(electronApp, page);
      await addDevServerCommand(page);
      if (sshHost) await createSshWorkspaces(page, world, sshHost);
      if (world.dictation) await fakeMicrophone(page);
      await dismissIntegrationUpdateNotice(page);
      await provide(page);
    },
    { timeout: 180_000 },
  ],

  director: async ({ electronApp, appWindow, windowSize, world }, provide, testInfo) => {
    const name = path.basename(testInfo.file).replace(/\.video\.ts$/, '');
    const outputDir = path.join(OUTPUT_DIR, name);
    await provide(
      new Director(electronApp, appWindow, windowSize, outputDir, Boolean(world.sshHost))
    );
  },
});

export { expect };
