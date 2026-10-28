import { execFile } from 'child_process';
import { basename, posix as pathPosix, sep } from 'path';
import { promisify } from 'util';

import {
  KOMLA_SKILLS_FOLDERS,
  komlaSkillFileSegments,
  isKomlaSkill,
} from '../../shared/constants/komla-skill';
import { buildTerminalApiUrl } from '../../shared/lib/komla-api-url';
import { sanitizeWorktreeProjectSegment } from '../../shared/lib/random-names';
import { shellQuotePosix } from '../../shared/lib/shell-quote';
import {
  MANAGED_TMUX_FIND_INPUTS,
  MANAGED_TMUX_SOCKET_NAME as TMUX_SOCKET_NAME,
  managedTmuxSessionName,
  type ManagedTmuxFindResult,
} from '../../shared/lib/ssh-tmux-attach';
import {
  komlaSshRemoteDataPort,
  isValidSshBasePath,
  normalizeSshBasePath,
} from '../../shared/types';
import {
  ANTIGRAVITY_ALERTS_SETTING,
  ANTIGRAVITY_CONFIG_DIR,
  ANTIGRAVITY_HOOK_SET,
  ANTIGRAVITY_HOOKS_FILE,
  ANTIGRAVITY_MCP_FILE,
  ANTIGRAVITY_SETTINGS_DIR,
  ANTIGRAVITY_SETTINGS_FILE,
  antigravityUpdateFiles,
  areAntigravityAlertsOn,
  buildAntigravityHookSet,
  isAntigravityHookSetEnabled,
  isAntigravityMcpServerEnabled,
  remoteAntigravityUpdate,
} from '../lib/antigravity-hooks';
import {
  ALL_CLAUDE_HOOK_EVENTS,
  CLAUDE_NOTIFICATION_HOOK_EVENTS,
  ClaudeVersionCache,
  claudeHookPlan,
  claudeHooksOutdated,
  claudeHooksToWrite,
  parseClaudeVersion,
} from '../lib/claude-hook-events';
import { CODEX_NOTIFICATION_HOOK_EVENTS } from '../lib/codex-hook-events';
import { setCodexMcpServer } from '../lib/codex-mcp-config';
import { hostToolEnv } from '../lib/host-tool-env';
import { readKomlaSkill } from '../lib/komla-skill-file';
import { createLogger } from '../lib/logger';
import { remoteHookUpdate, remotePluginUpdate } from '../lib/remote-notification-update';
import { sshErrorText } from '../lib/ssh-client';
import {
  MANAGED_REMOTE_TERMINAL_SESSION_REPLACED_SHELL_COMMAND,
  REMOTE_READY_SHELL_COMMAND,
} from '../lib/terminal-control';

import { buildOpenCodeNotifyPlugin } from './opencode-settings.service';
import { getKomlaBasePath } from './paths';
import { sshConnectionService } from './ssh-connection.service';
import { sshHostService } from './ssh-host.service';

import type {
  SshInputRunOptions,
  SshRsyncTransport,
  SshRunOptions,
  SshStreamingRunOptions,
} from './ssh-connection.service';
import type {
  SshAgent,
  SshHost,
  SshHostSetupResult,
  SshIntegrationStatus,
  SshIntegrationType,
  SshIntegrationUpdates,
  SshWorkspaceBackend,
} from '../../shared/types';
import type { RemoteNotificationIntegrationUpdate } from '../../shared/types/notification-integration';
import type { SshTerminalPoolAssignment } from '../lib/terminal-control';
const execFileAsync = promisify(execFile);
const logger = createLogger('SshWorkspaceService');
const SSH_TRASH_CLEANUP_TIMEOUT_MS = 15 * 60 * 1000;
const SSH_MAX_BUFFER = 10 * 1024 * 1024;
const LOCAL_CAPABILITY_TIMEOUT_MS = 5_000;
const SSH_BRANCH_ALREADY_EXISTS_MARKER = '__KOMLA_SSH_BRANCH_ALREADY_EXISTS__';
const SSH_BRANCH_ALREADY_EXISTS_CODE = 'SSH_BRANCH_ALREADY_EXISTS';
const SSH_WORKTREE_PATH_CONFLICT_MARKER = '__KOMLA_SSH_WORKTREE_PATH_CONFLICT__';
const SSH_WORKTREE_PATH_CONFLICT_CODE = 'SSH_WORKTREE_PATH_CONFLICT';
const SSH_WORKSPACE_BRANCH_CREATED_MARKER = '__KOMLA_SSH_WORKSPACE_BRANCH_CREATED__';
const SSH_WORKSPACE_WORKTREE_CREATED_MARKER = '__KOMLA_SSH_WORKSPACE_WORKTREE_CREATED__';
const SSH_WORKSPACE_TARGET_MARKER = '__KOMLA_SSH_WORKSPACE_TARGET__=';
const SSH_BRANCH_DELETE_FAILED_MESSAGE = '[komla] failed to delete remote workspace branch';
const WRITE_SKIPPED = '__KOMLA_WRITE_SKIPPED__';
const HELPER_SCRIPT_DELIMITER = 'KOMLA_HELPER_SCRIPT_EOF';
const NOTIFY_SCRIPT_READY = '__KOMLA_NOTIFY_SCRIPT_READY__';
const SSH_GIT_AUTH_FAILED_CODE = 'SSH_GIT_AUTH_FAILED';
const SSH_GIT_HOST_KEY_VERIFICATION_FAILED_CODE = 'SSH_GIT_HOST_KEY_VERIFICATION_FAILED';
const SSH_HOOK_MARKER = 'komla-managed';
type SshHookAgent = Exclude<SshAgent, 'antigravity' | 'opencode'>;
const SSH_NOTIFICATION_HOOK_EVENTS: Record<SshHookAgent, readonly string[]> = {
  claude: CLAUDE_NOTIFICATION_HOOK_EVENTS,
  codex: CODEX_NOTIFICATION_HOOK_EVENTS,
};
// The host's Claude as its terminals run it: through the login shell, which sets up PATH.
const CLAUDE_VERSION_COMMAND = [
  'remote_shell=${SHELL:-/bin/bash}',
  `if [ -x "$remote_shell" ]; then "$remote_shell" -lic 'claude --version' </dev/null 2>/dev/null; else /bin/sh -lc 'claude --version' </dev/null 2>/dev/null; fi`,
  'true',
].join('\n');
const SSH_DATA_MARKER_FILE = '.komla-managed';
const SSH_DATA_MARKER_CONTENT = 'komla-ssh-data-v1';
const TMUX_HISTORY_LIMIT = 10_000;
const TMUX_CONFIG_VERSION = 9;
// Komla's terminals always decode UTF-8, so the client writes it even when the remote command's
// locale names none, as zsh gets on RHEL-family hosts. Clients of other devices stay attached
// where the window takes the size of the client used last, tmux's default since 3.1; before it,
// they would squeeze each other, so the attaching client detaches them.
const TMUX_ATTACH = `tmux -u -L ${TMUX_SOCKET_NAME} attach-session $([ "$(tmux -L ${TMUX_SOCKET_NAME} show-options -gqv window-size 2>/dev/null)" = latest ] || echo -d) -t`;
/** The session option holding the routing of the device whose client is on the shell's tty. */
const TMUX_CLIENT_ROUTE_OPTION = '"@komla_route_$(printf %s "$komla_tty" | tr -c A-Za-z0-9 _)"';
// Hands a session's routing to the device whose client became its latest, as at a keypress
// there. Run by tmux with formats expanded, so it holds no `#` of its own, nor single quotes.
const TMUX_CLIENT_ACTIVE_SCRIPT = [
  'komla_tty="#{client_tty}"',
  `route=$(tmux -L ${TMUX_SOCKET_NAME} show-options -qv -t "#{session_name}" ${TMUX_CLIENT_ROUTE_OPTION})`,
  '[ -n "$route" ] || exit 0',
  [
    `tmux -L ${TMUX_SOCKET_NAME}`,
    'set-environment -t "=#{session_name}" KOMLA_API_URL "$(printf %s "$route" | cut -f1)" \\;',
    'set-environment -t "=#{session_name}" KOMLA_COMPANION_INBOX "$(printf %s "$route" | cut -f2)" \\;',
    'set-option -t "#{session_name}" @komla_installation_key "$(printf %s "$route" | cut -f3)"',
  ].join(' '),
].join(' ; ');

export interface CreateSshWorkspaceArgs {
  hostId: string;
  gitUrl?: string;
  localRepoPath?: string;
  projectId?: string;
  projectName: string;
  branchName: string;
  checkoutExistingBranch?: boolean;
  baseBranch?: string;
  startPoint?: string;
  resolvedBasePath?: string;
  sourceBackend?: SshWorkspaceBackend;
  onProgress?: (status: string) => void;
}

export interface SshWorkspaceCreateResult {
  backend: SshWorkspaceBackend;
  workingDirectory: string;
  repoName: string;
}

export interface SshTerminalLaunchCommand {
  command: string;
  startupMode: 'wait-for-marker';
  /**
   * A forwarded agent is whichever one the local shell's startup files point SSH_AUTH_SOCK at,
   * so those launches run in that shell. The rest skip its startup files, as Komla's other SSH
   * connections do.
   */
  localLoginShell: boolean;
}

export interface SshRemoteCompanionLaunch {
  installationKey: string;
  tmuxSocket: string;
  sessionName: string;
  hookInbox: string;
}

export interface SshTerminalLaunchOptions {
  keepShellOpenAfterCommand?: boolean;
  companion?: SshRemoteCompanionLaunch;
}

export type SshTerminalSessionAction = 'start' | 'reconnect' | 'replace';

export type {
  SshInputRunOptions,
  SshRsyncTransport,
  SshRunOptions,
  SshRunPurpose,
  SshStreamingRunOptions,
} from './ssh-connection.service';

export function sshCompanionInstallationId(hostId: string): string {
  return `${getKomlaBasePath()}\0${hostId}`;
}

function tmuxExactTarget(terminalId: string): string {
  return shellQuotePosix(`=${managedTmuxSessionName(terminalId)}`);
}

function stripTrailingSlash(value: string): string {
  return value === '/' ? value : value.replace(/\/+$/, '');
}

function normalizeTargetBranch(value: string | undefined): string | undefined {
  const branch = value?.trim();
  return branch && !/^(?:refs\/remotes\/)?origin\/HEAD$|^HEAD$/.test(branch)
    ? branch.replace(/^refs\/remotes\/origin\//, '').replace(/^origin\//, '')
    : undefined;
}

export function joinRemote(...parts: string[]): string {
  return parts
    .map((part, index) => (index === 0 ? stripTrailingSlash(part) : part.replace(/^\/+|\/+$/g, '')))
    .filter(Boolean)
    .join('/');
}

function remoteBasenameFromGitUrl(gitUrl: string): string {
  const withoutFragment = gitUrl.split('#')[0] ?? gitUrl;
  const trimmed = withoutFragment.replace(/\/+$/, '');
  const last = basename(
    trimmed.includes(':') ? trimmed.slice(trimmed.lastIndexOf(':') + 1) : trimmed
  );
  return (last || 'repo').replace(/\.git$/i, '');
}

function repoNameFromSource(args: CreateSshWorkspaceArgs): string {
  return remoteBasenameFromGitUrl(args.gitUrl || args.localRepoPath || args.projectName);
}

function httpsGitUrlToSsh(gitUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(gitUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  if (!['github.com', 'gitlab.com', 'bitbucket.org'].includes(parsed.hostname)) return null;

  const repoPath = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (!repoPath || !repoPath.includes('/')) return null;
  return `git@${parsed.hostname}:${repoPath.endsWith('.git') ? repoPath : `${repoPath}.git`}`;
}

function remoteGitUrlFromSource(host: SshHost, args: CreateSshWorkspaceArgs): string {
  const gitUrl = args.gitUrl || args.localRepoPath?.split(sep).join('/') || '';
  if (!host.forwardAgent) return gitUrl;
  return httpsGitUrlToSsh(gitUrl) ?? gitUrl;
}

function safeRemoteSegment(value: string): string {
  return sanitizeWorktreeProjectSegment(value).replace(/[/\\]/g, '-');
}

function startsFromTargetBranch(backend: SshWorkspaceBackend): boolean {
  const startPoint = backend.startPoint || backend.baseBranch || 'HEAD';
  return !!backend.baseBranch && startPoint === backend.baseBranch;
}

function remoteBranchPathSegment(branchName: string, attempt = 1): string {
  const readable = safeRemoteSegment(branchName);
  return attempt === 1 ? readable : `${readable}-${attempt}`;
}

function getErrorStderr(error: unknown): string {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return '';
  return typeof error.stderr === 'string' ? error.stderr : '';
}

function stripAnsiColorCodes(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

function formatKomlaSetupError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return 'SSH workspace setup failed.';
  const capitalized = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function getUserFacingSetupError(error: unknown): Error {
  const lines = stripAnsiColorCodes(getErrorStderr(error))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const komlaError = lines.find((line) => line.startsWith('[komla] '));
  if (komlaError) {
    return new Error(formatKomlaSetupError(komlaError.slice('[komla] '.length)));
  }

  const detail = lines.findLast((line) => !line.startsWith('__KOMLA_'));
  if (detail) return new Error(detail.slice(0, 500));
  return new Error('SSH workspace setup failed. Check the SSH host connection and try again.');
}

function hasStderrLine(error: unknown, expectedLine: string): boolean {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return false;
  const stderr = error.stderr;
  return (
    typeof stderr === 'string' && stderr.split(/\r?\n/).some((line) => line.trim() === expectedLine)
  );
}

function isRemoteGitSshAuthFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return false;
  const stderr = error.stderr;
  return (
    typeof stderr === 'string' &&
    stderr.includes('Permission denied (publickey).') &&
    stderr.includes('Could not read from remote repository.')
  );
}

function isRemoteGitHostKeyVerificationFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('stderr' in error)) return false;
  const stderr = error.stderr;
  return (
    typeof stderr === 'string' &&
    stderr.includes('Host key verification failed.') &&
    stderr.includes('Could not read from remote repository.')
  );
}

function isSshAgentSigningRefusal(error: unknown): boolean {
  const errorText = sshErrorText(error);
  return (
    errorText.includes('sign_and_send_pubkey: signing failed') &&
    errorText.includes('agent refused operation')
  );
}

export function remoteKomlaDataPort(hostId: string): number {
  return komlaSshRemoteDataPort(hostId);
}

/**
 * Agent configs on the host are shared by every Komla installation that uses
 * it, so they launch the companion's stdio adapter. It resolves the desktop
 * that currently owns the calling terminal for each request.
 */
const SSH_AGENTS = [
  'claude',
  'codex',
  'antigravity',
  'opencode',
] as const satisfies readonly SshAgent[];

const SKILL_FILE_DELIMITER = '__KOMLA_SKILL_FILE__';

/** A skills folder's Komla SKILL.md on a host, as found there. */
interface RemoteSkillCopy {
  file: string;
  /** Whether the skill goes in this folder on the host. */
  applies: boolean;
  /** The file's content; empty when it is missing. */
  content: string;
}

function remoteMcpCommand(basePath: string): { command: string; args: string[] } {
  return { command: joinRemote(basePath, 'helpers', 'komla'), args: ['mcp'] };
}

function parseJsonObject(value: string, remotePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw new Error(`Remote configuration ${remotePath} contains invalid JSON`, { cause: error });
  }
  throw new Error(`Remote configuration ${remotePath} must contain a JSON object`);
}

function parseKeyValueOutput(output: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of output.split('\n')) {
    const index = line.indexOf('=');
    if (index <= 0) continue;
    values.set(line.slice(0, index), line.slice(index + 1));
  }
  return values;
}

function antigravityConfigPath(home: string, file: string): string {
  return joinRemote(home, ...ANTIGRAVITY_CONFIG_DIR, file);
}

function antigravitySettingsPath(home: string): string {
  return joinRemote(home, ...ANTIGRAVITY_SETTINGS_DIR, ANTIGRAVITY_SETTINGS_FILE);
}

/** Drops `mcpServers.komla`, and `mcpServers` once empty; returns whether it changed anything. */
function removeKomlaMcpServer(settings: Record<string, unknown>): boolean {
  const mcpServers = getRecord(settings.mcpServers);
  if (!mcpServers?.komla) return false;
  delete mcpServers.komla;
  if (Object.keys(mcpServers).length === 0) delete settings.mcpServers;
  return true;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** An input as `printf` writes it back, for setting tmux's user-keys from a shell. */
function tmuxPrintfEscape(input: string): string {
  return input.replace('\x1b', '\\033');
}

function remoteTmuxServerSetupCommand(): string {
  return [
    `if [ "$(tmux -L ${TMUX_SOCKET_NAME} show-options -gqv @komla_config_version 2>/dev/null || true)" != ${shellQuotePosix(String(TMUX_CONFIG_VERSION))} ]; then`,
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g status off`,
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g set-titles on`,
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g set-titles-string "#{pane_title}"`,
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g remain-on-exit off`,
    `  tmux -L ${TMUX_SOCKET_NAME} unbind-key -a`,
    `  tmux -L ${TMUX_SOCKET_NAME} unbind-key -T root MouseDown3Pane 2>/dev/null || true`,
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g prefix None`,
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g mouse on`,
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -s set-clipboard external`,
    // Passes OSC 8 hyperlinks through to Komla's terminal. tmux before 3.4 drops them, and
    // before 3.2 has no terminal-features option.
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -as terminal-features '*:hyperlinks' 2>/dev/null || true`,
    // Carries the OSC 7501 statuses the companion's PTY proxy wraps. tmux before 3.3 passes them
    // through without it.
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g allow-passthrough on 2>/dev/null || true`,
    // The proxy repeats a turn's status for a client that attaches; SIGCONT leaves a shell started
    // without it alone.
    `  tmux -L ${TMUX_SOCKET_NAME} set-hook -g client-attached 'run-shell -b "kill -CONT #{pane_pid} 2>/dev/null || true"' 2>/dev/null || true`,
    // tmux before 3.3 has no client-active hook; there the device that attached last keeps it.
    `  tmux -L ${TMUX_SOCKET_NAME} set-hook -g client-active ${shellQuotePosix(`run-shell -b '${TMUX_CLIENT_ACTIVE_SCRIPT}'`)} 2>/dev/null || true`,
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g history-limit ${TMUX_HISTORY_LIMIT}`,
    '  tmux_term=screen-256color',
    '  if command -v infocmp >/dev/null 2>&1 && infocmp tmux-256color >/dev/null 2>&1; then tmux_term=tmux-256color; fi',
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g default-terminal "$tmux_term"`,
    // Komla's terminals render 24-bit color, which tmux otherwise rounds to its
    // 256-color palette. terminal-features arrived in tmux 3.2; Tc is the older form.
    `  if ! tmux -L ${TMUX_SOCKET_NAME} set-option -sa terminal-features ',xterm-256color:RGB' 2>/dev/null; then`,
    `    tmux -L ${TMUX_SOCKET_NAME} set-option -ga terminal-overrides ',xterm-256color:Tc'`,
    '  fi',
    `  if tmux -L ${TMUX_SOCKET_NAME} set-option -s extended-keys always 2>/dev/null; then`,
    `    tmux -L ${TMUX_SOCKET_NAME} bind-key -n S-Enter send-keys -l "$(printf '\\033[13;2u')"`,
    `    tmux -L ${TMUX_SOCKET_NAME} bind-key -n BTab send-keys -l "$(printf '\\033[Z')"`,
    '  fi',
    // Komla's search bar steps through tmux's search, since the history lives here. tmux
    // before 2.6 has no user-keys.
    `  if tmux -L ${TMUX_SOCKET_NAME} set-option -s 'user-keys[0]' "$(printf '${tmuxPrintfEscape(MANAGED_TMUX_FIND_INPUTS.older)}')" 2>/dev/null; then`,
    `    tmux -L ${TMUX_SOCKET_NAME} set-option -s 'user-keys[1]' "$(printf '${tmuxPrintfEscape(MANAGED_TMUX_FIND_INPUTS.newer)}')"`,
    `    tmux -L ${TMUX_SOCKET_NAME} set-option -s 'user-keys[2]' "$(printf '${tmuxPrintfEscape(MANAGED_TMUX_FIND_INPUTS.close)}')"`,
    // Once tmux has left the search, say after scrolling back down, a step starts it again from
    // the query the last search stored. Formats in search arguments arrived in tmux 3.1. The
    // running server decides, since an upgrade leaves it older than the tmux binary.
    '    find_again=',
    `    case "$(tmux -L ${TMUX_SOCKET_NAME} display-message -p '#{version}' 2>/dev/null)" in`,
    "      [012].*|3.0*|'') ;;",
    `      *) find_again="copy-mode -e ; send-keys -X history-bottom ; send-keys -F -X search-backward-text '#{@komla_find_query}' ; set-option -w @komla_find older" ;;`,
    '    esac',
    // A search forward stops at a match's end and one backward at its start, so the first
    // step after turning around lands on the same match; it takes a second one.
    `    tmux -L ${TMUX_SOCKET_NAME} bind-key -n User0 if-shell -F '#{pane_in_mode}' "if-shell -F '#{==:#{@komla_find},newer}' 'send-keys -X search-again' ; send-keys -X search-again ; set-option -w @komla_find older" \${find_again:+"$find_again"}`,
    `    tmux -L ${TMUX_SOCKET_NAME} bind-key -n User1 if-shell -F '#{pane_in_mode}' "if-shell -F '#{==:#{@komla_find},older}' 'send-keys -X search-reverse' ; send-keys -X search-reverse ; set-option -w @komla_find newer" \${find_again:+"$find_again"}`,
    `    tmux -L ${TMUX_SOCKET_NAME} bind-key -n User2 if-shell -F '#{pane_in_mode}' 'send-keys -X cancel'`,
    '  fi',
    `  tmux -L ${TMUX_SOCKET_NAME} set-option -g @komla_config_version ${shellQuotePosix(String(TMUX_CONFIG_VERSION))}`,
    'fi',
  ].join('\n');
}

/**
 * Starts the managed tmux server, without the user's tmux configuration, if it
 * isn't running, then applies Komla's settings. The host's `komla` CLI runs the
 * same commands from `helpers/tmux-server.sh` to start sessions while Komla is
 * disconnected.
 */
function remoteTmuxServerStartCommand(): string {
  return [
    `if ! tmux -L ${TMUX_SOCKET_NAME} has-session 2>/dev/null; then`,
    `  tmux -L ${TMUX_SOCKET_NAME} -f /dev/null new-session -d -s komla_launch_guard 'sleep 5' || true`,
    'fi',
    remoteTmuxServerSetupCommand(),
  ].join('\n');
}

/** Lines that write stdin to `remotePath` through a temporary file, following symlinks. */
function remoteWriteFromStdinLines(remotePath: string, executable: boolean): string[] {
  const parentPath = remotePath.slice(0, remotePath.lastIndexOf('/'));
  const mode = executable ? '755' : '600';
  return [
    `mkdir -p ${shellQuotePosix(parentPath)}`,
    `target=${shellQuotePosix(remotePath)}`,
    'symlink_hops=0',
    'while [ -L "$target" ]; do',
    '  link_target=$(readlink "$target") || exit 1',
    '  case "$link_target" in',
    '    /*) target="$link_target" ;;',
    '    *) target="${target%/*}/$link_target" ;;',
    '  esac',
    '  symlink_hops=$((symlink_hops + 1))',
    '  if [ "$symlink_hops" -gt 40 ]; then',
    '    printf "too many symbolic links while writing %s\\n" "$target" >&2',
    '    exit 1',
    '  fi',
    'done',
    'target_parent=${target%/*}',
    'target_name=${target##*/}',
    'mkdir -p "$target_parent"',
    'temp_path=$(mktemp "$target_parent/.${target_name}.komla.XXXXXX") || exit 1',
    'cleanup_temp() { if [ -n "$temp_path" ]; then rm -f "$temp_path"; fi; }',
    'trap cleanup_temp 0',
    "trap 'exit 1' HUP INT TERM",
    'cat > "$temp_path"',
    `chmod ${mode} "$temp_path"`,
    'mv -f "$temp_path" "$target"',
    "temp_path=''",
    'trap - 0 HUP INT TERM',
  ];
}

export function generateTmuxServerScript(): string {
  return `#!/bin/sh\n# Komla tmux server setup - auto-managed, do not edit\n${remoteTmuxServerStartCommand()}\n`;
}

function remoteTerminalLoginCommand(
  environment: Record<string, string | number | undefined>,
  command: string | null,
  keepShellOpenAfterCommand: boolean
): string {
  const lines = Object.entries(environment)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `export ${key}=${shellQuotePosix(String(value))}`);
  lines.push('if [ -n "${KOMLA_CLI-}" ]; then PATH="${KOMLA_CLI%/*}:${PATH-}"; export PATH; fi');
  const openShell = [
    'if [ -x "${SHELL:-/bin/bash}" ]; then exec "${SHELL:-/bin/bash}" -i; fi',
    'exec /bin/sh -i',
  ];
  if (!command) return [...lines, ...openShell].join('\n');

  lines.push(
    command,
    'command_status=$?',
    'if [ "$command_status" -ne 0 ]; then',
    '  printf "\\033[31m[komla] Agent command failed with exit code %s.\\033[0m\\n" "$command_status" >&2',
    '  printf "\\033[33m[komla] Starting a remote shell so you can fix the problem.\\033[0m\\n" >&2',
    ...openShell.map((line) => `  ${line}`),
    'fi'
  );
  if (keepShellOpenAfterCommand) lines.push(...openShell);
  return lines.join('\n');
}

/**
 * Points an existing managed session's Komla routing at this installation
 * before attaching. Agents read routing from the session environment, so
 * calls from a running agent follow whichever device attached last.
 */
function claimRemoteTerminalSessionCommands(
  environment: Record<string, string | number | undefined>,
  terminalId: string
): string[] {
  const target = tmuxExactTarget(terminalId);
  // tmux resolves set-option targets as panes, which reject the exact-match prefix.
  const sessionName = shellQuotePosix(managedTmuxSessionName(terminalId));
  return [
    ...['KOMLA_API_URL', 'KOMLA_COMPANION_INBOX'].map(
      (name) =>
        `tmux -L ${TMUX_SOCKET_NAME} set-environment -t ${target} ${name} ${shellQuotePosix(String(environment[name] ?? ''))} 2>/dev/null || true`
    ),
    `tmux -L ${TMUX_SOCKET_NAME} set-option -t ${sessionName} @komla_installation_key ${shellQuotePosix(String(environment.KOMLA_INSTALLATION_KEY ?? ''))} 2>/dev/null || true`,
    rememberClientRouteCommand(environment, sessionName),
  ];
}

/**
 * Remembers this device's routing for the client it attaches on the shell's tty, which takes the
 * session's routing whenever it becomes the session's latest client.
 */
function rememberClientRouteCommand(
  environment: Record<string, string | number | undefined>,
  sessionName: string
): string {
  const route = ['KOMLA_API_URL', 'KOMLA_COMPANION_INBOX', 'KOMLA_INSTALLATION_KEY']
    .map((name) => shellQuotePosix(String(environment[name] ?? '')))
    .join(' ');
  return `if komla_tty=$(tty 2>/dev/null); then tmux -L ${TMUX_SOCKET_NAME} set-option -t ${sessionName} ${TMUX_CLIENT_ROUTE_OPTION} "$(printf '%s\\t%s\\t%s' ${route})" 2>/dev/null || true; fi`;
}

/**
 * Readies an existing managed session for Komla to attach: the server may still carry
 * the settings of an older Komla, such as one without the search key.
 */
function reattachRemoteTerminalSessionCommands(
  environment: Record<string, string | number | undefined>,
  terminalId: string
): string[] {
  return [
    ...remoteTmuxServerSetupCommand().split('\n'),
    ...claimRemoteTerminalSessionCommands(environment, terminalId),
  ];
}

function remoteTerminalCreationCommand(
  backend: SshWorkspaceBackend,
  environment: Record<string, string | number | undefined>,
  terminalId: string,
  command: string | null,
  action: Exclude<SshTerminalSessionAction, 'reconnect'>,
  keepShellOpenAfterCommand: boolean,
  reportReplacement = false
): string {
  const sessionName = managedTmuxSessionName(terminalId);
  const target = `=${sessionName}`;
  const mayFinishBeforeAttachment = command !== null && !keepShellOpenAfterCommand;
  const loginCommand = remoteTerminalLoginCommand(environment, command, keepShellOpenAfterCommand);
  // A plain zsh hands off to `zsh -i`, which reads .zshrc itself; reading it here too would run it
  // twice before the first prompt. bash's login files source .bashrc, which expects an interactive
  // shell, so bash reads it in both.
  const chooseLoginShellFlags = command
    ? 'login_flags=-lic'
    : 'case "$remote_shell" in */zsh*) login_flags=-lc ;; *) login_flags=-lic ;; esac';
  const sessionEnvironmentCommands = [
    'KOMLA_API_URL',
    'KOMLA_TERMINAL_ID',
    'KOMLA_WORKSPACE_ID',
    'KOMLA_COMPANION_INBOX',
  ].map(
    (name) =>
      `tmux -L ${TMUX_SOCKET_NAME} set-environment -t "$target" ${name} ${shellQuotePosix(String(environment[name] ?? ''))} 2>/dev/null || true`
  );
  // tmux drops OSC 7501 program statuses, so the shell runs through the companion's PTY proxy,
  // which carries them past it; the host's `komla` is the companion. Without the companion yet,
  // it runs directly.
  const ptyProxy = environment.KOMLA_CLI ? shellQuotePosix(String(environment.KOMLA_CLI)) : null;
  const sessionCommand = [
    `tmux -L ${TMUX_SOCKET_NAME} set-option -t ${shellQuotePosix(sessionName)} @komla_installation_key ${shellQuotePosix(String(environment.KOMLA_INSTALLATION_KEY ?? ''))} 2>/dev/null || true`,
    `cd ${shellQuotePosix(backend.remoteDirectory)} || exit 1`,
    'remote_shell=${SHELL:-/bin/bash}',
    chooseLoginShellFlags,
    ...(ptyProxy
      ? [
          `if [ -x ${ptyProxy} ] && ${ptyProxy} __pty-proxy --check >/dev/null 2>&1; then`,
          `  run_shell() { exec ${ptyProxy} __pty-proxy "$@"; }`,
          'else',
          '  run_shell() { exec "$@"; }',
          'fi',
        ]
      : ['run_shell() { exec "$@"; }']),
    `if [ -x "$remote_shell" ]; then run_shell "$remote_shell" "$login_flags" ${shellQuotePosix(loginCommand)}; fi`,
    `run_shell /bin/sh -lc ${shellQuotePosix(loginCommand)}`,
  ].join('\n');
  const lines = [
    `session_name=${shellQuotePosix(sessionName)}`,
    `target=${shellQuotePosix(target)}`,
  ];
  if (action === 'replace') {
    lines.push(
      `tmux -L ${TMUX_SOCKET_NAME} kill-session -t "$target" 2>/dev/null || true`,
      `if tmux -L ${TMUX_SOCKET_NAME} has-session -t "$target" 2>/dev/null; then`,
      '  printf "[komla] failed to stop existing managed remote terminal session\\n" >&2',
      '  exit 1',
      'fi'
    );
  } else {
    lines.push(
      `if tmux -L ${TMUX_SOCKET_NAME} has-session -t "$target" 2>/dev/null; then`,
      ...reattachRemoteTerminalSessionCommands(environment, terminalId).map((line) => `  ${line}`),
      `  ${REMOTE_READY_SHELL_COMMAND}`,
      `  ${TMUX_ATTACH} "$target" && exit 0`,
      'fi'
    );
  }
  lines.push(
    remoteTmuxServerStartCommand(),
    `if tmux -L ${TMUX_SOCKET_NAME} new-session -d -s "$session_name" ${shellQuotePosix(sessionCommand)}; then`,
    ...sessionEnvironmentCommands.map((line) => `  ${line}`),
    `  ${rememberClientRouteCommand(environment, '"$session_name"')}`,
    ...(reportReplacement ? [`  ${MANAGED_REMOTE_TERMINAL_SESSION_REPLACED_SHELL_COMMAND}`] : []),
    'else',
    `  tmux -L ${TMUX_SOCKET_NAME} has-session -t "$target" 2>/dev/null || exit 1`,
    'fi',
    ...(mayFinishBeforeAttachment
      ? [
          `if ! tmux -L ${TMUX_SOCKET_NAME} has-session -t "$target" 2>/dev/null; then`,
          `  ${REMOTE_READY_SHELL_COMMAND}`,
          '  exit 0',
          'fi',
        ]
      : [`tmux -L ${TMUX_SOCKET_NAME} has-session -t "$target" 2>/dev/null || exit 1`]),
    REMOTE_READY_SHELL_COMMAND,
    ...(mayFinishBeforeAttachment
      ? [`${TMUX_ATTACH} "$target" || exit 0`, 'exit 0']
      : [`exec ${TMUX_ATTACH} "$target"`])
  );
  return lines.join('\n');
}

export function generateNotifyShellScript(): string {
  return `#!/bin/sh
# Komla notification script - auto-managed, do not edit
source_name=generic
event_name=Notification
input_mode=stdin
hook_input=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) source_name="$2"; shift 2 ;;
    --event) event_name="$2"; shift 2 ;;
    --input) input_mode="$2"; shift 2 ;;
    *) [ -n "$hook_input" ] || hook_input="$1"; shift ;;
  esac
done

helper_dir=$(CDPATH= cd -- "$(dirname -- "$0")" 2>/dev/null && pwd -P)
companion="$helper_dir/komla"
companion_inbox="\${KOMLA_COMPANION_INBOX:-}"
if [ -z "$companion_inbox" ] && command -v tmux >/dev/null 2>&1; then
  case "\${KOMLA_TERMINAL_ID:-}" in
    ""|*[!A-Za-z0-9_-]*) ;;
    *)
      companion_environment=$(tmux show-environment -t "=komla-$KOMLA_TERMINAL_ID" KOMLA_COMPANION_INBOX 2>/dev/null || true)
      case "$companion_environment" in
        KOMLA_COMPANION_INBOX=*) companion_inbox=\${companion_environment#KOMLA_COMPANION_INBOX=} ;;
      esac
      ;;
  esac
fi
if [ -x "$companion" ] && [ -n "$companion_inbox" ]; then
  if [ "$input_mode" = stdin ]; then
    exec "$companion" notify "$companion_inbox" "$source_name" "$event_name" "\${KOMLA_TERMINAL_ID:-}"
  fi
  printf '%s' "$hook_input" | exec "$companion" notify "$companion_inbox" "$source_name" "$event_name" "\${KOMLA_TERMINAL_ID:-}"
fi

if [ "$input_mode" = stdin ]; then
  hook_input_file=$(mktemp 2>/dev/null || printf "")
  if [ -n "$hook_input_file" ]; then
    dd bs=1 count=65537 of="$hook_input_file" 2>/dev/null
    hook_input_bytes=$(wc -c < "$hook_input_file" | tr -d ' ')
    case "$hook_input_bytes" in
      ''|*[!0-9]*) hook_input='{}' ;;
      *) [ "$hook_input_bytes" -le 65536 ] && hook_input=$(cat "$hook_input_file") || hook_input='{}' ;;
    esac
    rm -f "$hook_input_file"
  else
    hook_input='{}'
  fi
fi
[ -n "$hook_input" ] || hook_input='{}'

hook_input_bytes=$(printf '%s' "$hook_input" | wc -c | tr -d ' ')
case "$hook_input_bytes" in
  ''|*[!0-9]*) hook_input='{}' ;;
  *) [ "$hook_input_bytes" -le 65536 ] || hook_input='{}' ;;
esac

port="\${KOMLA_NOTIFY_PORT:-}"
[ -n "$port" ] || exit 0
case "$port" in *[!0-9]*|"") exit 0 ;; esac

kind=generic
case "$event_name" in
  Stop|AfterAgent) kind=turn-complete ;;
  UserPromptSubmit|BeforeAgent) kind=prompt-submit ;;
  PermissionRequest) kind=input-required ;;
  PreToolUse|BeforeTool) kind=activity ;;
esac

cwd=$(pwd 2>/dev/null || printf "")
terminal_id_field=
if [ -n "\${KOMLA_TERMINAL_ID:-}" ]; then
  terminal_id_json=$(printf '%s' "$KOMLA_TERMINAL_ID" | awk '{ gsub(/\\\\/,"\\\\\\\\"); gsub(/"/,"\\\\\\""); printf "\\"%s\\"", $0 }')
  terminal_id_field=$(printf '"terminalId":%s,' "$terminal_id_json")
fi
payload=$(printf '{%s"cwd":%s,"kind":%s,"source":%s,"message":%s,"hookInput":%s}' \\
  "$terminal_id_field" \\
  "$(printf '%s' "$cwd" | awk '{ gsub(/\\\\/,"\\\\\\\\"); gsub(/"/,"\\\\\\""); printf "\\"%s\\"", $0 }')" \\
  "$(printf '%s' "$kind" | awk '{ printf "\\"%s\\"", $0 }')" \\
  "$(printf '%s' "$source_name" | awk '{ gsub(/\\\\/,"\\\\\\\\"); gsub(/"/,"\\\\\\""); printf "\\"%s\\"", $0 }')" \\
  "$(printf '%s' "$event_name" | awk '{ gsub(/\\\\/,"\\\\\\\\"); gsub(/"/,"\\\\\\""); printf "\\"%s\\"", $0 }')" \\
  "$hook_input")

url="http://\${KOMLA_NOTIFY_HOST:-127.0.0.1}:$port/api/v1/notify"
if command -v curl >/dev/null 2>&1; then
  curl -fsS -m 2 -H 'Content-Type: application/json' --data "$payload" "$url" >/dev/null 2>&1 || true
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 2 --header='Content-Type: application/json' --post-data="$payload" -O /dev/null "$url" >/dev/null 2>&1 || true
fi
exit 0
`;
}

class SshWorkspaceService {
  private integrationMutations = new Map<string, Promise<void>>();
  private preparedNotifyScriptHosts = new Map<string, Set<string>>();
  // Agents whose notification setup needed an update at each host's last integration check,
  // with the configuration Komla would install for each.
  private integrationUpdates = new Map<string, SshIntegrationUpdates>();
  private integrationUpdateListeners: Array<
    (updates: Record<string, SshIntegrationUpdates>) => void
  > = [];
  // The latest integration check per host; only it may update `integrationUpdates`.
  private integrationChecks = new Map<string, symbol>();
  private claudeVersions = new ClaudeVersionCache();
  private workspaceBasePathResolutions = new Map<
    string,
    { connectionKey: string; promise: Promise<string> }
  >();
  private remoteTmuxStatuses = new Map<
    string,
    { connectionKey: string; status: SshHostSetupResult['tmux'] }
  >();
  private remoteTmuxStatusChecks = new Map<
    string,
    { connectionKey: string; promise: Promise<SshHostSetupResult['tmux']> }
  >();
  hasHost(hostId: string): boolean {
    return sshHostService.has(hostId);
  }

  getHost(hostId: string): SshHost {
    const host = sshHostService.get(hostId);
    if (!host) {
      throw new Error(`SSH host ${hostId} not found`);
    }
    return host;
  }

  getRsyncTransport(hostId: string): SshRsyncTransport {
    return sshConnectionService.getRsyncTransport(this.getHost(hostId));
  }

  async ensureWorkspaceReady(
    backend: SshWorkspaceBackend,
    companion?: () => Promise<string | undefined>
  ): Promise<{
    createdBranch: boolean;
    createdWorktree: boolean;
    baseBranch?: string;
    defaultBranch?: string;
  }> {
    const host = this.getHost(backend.hostId);
    // Only a new branch from the target asks the companion where to start.
    const companionPath =
      !backend.checkoutExistingBranch && startsFromTargetBranch(backend)
        ? await companion?.()
        : undefined;
    try {
      const stdout = await sshConnectionService.runWithInput(
        host,
        'sh -s',
        this.buildLazySetupCommand(backend, companionPath),
        {
          purpose: { kind: 'interactive' },
        }
      );
      const createdWorkspace = stdout
        .split(/\r?\n/)
        .some((line) => line.trim() === SSH_WORKSPACE_BRANCH_CREATED_MARKER);
      const createdWorktree = stdout
        .split(/\r?\n/)
        .some((line) => line.trim() === SSH_WORKSPACE_WORKTREE_CREATED_MARKER);
      const defaultBranch = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.startsWith(SSH_WORKSPACE_TARGET_MARKER))
        ?.slice(SSH_WORKSPACE_TARGET_MARKER.length);
      return {
        createdBranch: createdWorkspace,
        createdWorktree,
        ...(!backend.baseBranch && defaultBranch ? { baseBranch: defaultBranch } : {}),
        ...(defaultBranch ? { defaultBranch } : {}),
      };
    } catch (error) {
      if (hasStderrLine(error, SSH_BRANCH_ALREADY_EXISTS_MARKER)) {
        throw Object.assign(
          new Error(`Branch "${backend.branchName}" already exists on the SSH host.`),
          { code: SSH_BRANCH_ALREADY_EXISTS_CODE }
        );
      }
      if (hasStderrLine(error, SSH_WORKTREE_PATH_CONFLICT_MARKER)) {
        throw Object.assign(new Error('Remote worktree path belongs to a different branch.'), {
          code: SSH_WORKTREE_PATH_CONFLICT_CODE,
        });
      }
      if (isRemoteGitSshAuthFailure(error)) {
        const message = host.forwardAgent
          ? 'The SSH host could not authenticate to the Git remote. SSH agent forwarding is enabled, but no authorized key was available. Make sure the correct key is loaded in your local SSH agent and can access this repository, or configure Git credentials on the remote machine.'
          : 'The SSH host could not authenticate to the Git remote. Enable "Forward SSH agent" in this SSH host\'s settings, or configure Git credentials on the remote machine.';
        throw Object.assign(new Error(message), { code: SSH_GIT_AUTH_FAILED_CODE });
      }
      if (isRemoteGitHostKeyVerificationFailure(error)) {
        throw Object.assign(
          new Error(
            'The SSH host could not verify the Git remote identity. Automatic first-use trust may be unavailable because SSH is too old, a custom Git SSH transport is configured, the saved host key changed, or known_hosts cannot be updated. Verify the Git host key on the SSH machine before retrying.'
          ),
          { code: SSH_GIT_HOST_KEY_VERIFICATION_FAILED_CODE }
        );
      }
      logger.error('SSH workspace setup failed', error, {
        hostId: backend.hostId,
        remoteDirectory: backend.remoteDirectory,
      });
      throw getUserFacingSetupError(error);
    }
  }

  private hostConnectionKey(host: SshHost): string {
    return JSON.stringify([
      host.hostname,
      host.user,
      host.port,
      host.identityFile,
      host.extraSshArgs,
    ]);
  }

  recordTerminalPoolAssignment(
    terminalId: string,
    nextAssignment: SshTerminalPoolAssignment
  ): void {
    sshConnectionService.recordTerminalPoolAssignment(terminalId, nextAssignment);
  }

  releaseTerminalPoolAssignment(terminalId: string): void {
    sshConnectionService.releaseTerminalPoolAssignment(terminalId);
  }

  useExecChannel(host: SshHost, executable: string): void {
    sshConnectionService.useExecChannel(host, executable);
  }

  warmConnections(host: SshHost): void {
    sshConnectionService.warmConnections(host);
  }

  async run(
    host: SshHost,
    remoteCommand: string,
    timeoutOrOptions?: number | SshRunOptions
  ): Promise<string> {
    return timeoutOrOptions === undefined
      ? sshConnectionService.run(host, remoteCommand)
      : sshConnectionService.run(host, remoteCommand, timeoutOrOptions);
  }

  async runStreaming(
    host: SshHost,
    remoteCommand: string,
    options: SshStreamingRunOptions = {}
  ): Promise<number> {
    return await sshConnectionService.runStreaming(host, remoteCommand, options);
  }

  runWithFileInput(
    host: SshHost,
    remoteCommand: string,
    sourcePath: string,
    options: SshInputRunOptions = {}
  ): Promise<string> {
    return sshConnectionService.runWithFileInput(host, remoteCommand, sourcePath, {
      ...options,
      purpose: options.purpose ?? { kind: 'interactive' },
    });
  }

  runWithInput(
    host: SshHost,
    remoteCommand: string,
    input: string,
    options: SshInputRunOptions = {}
  ): Promise<string> {
    return sshConnectionService.runWithInput(host, remoteCommand, input, {
      ...options,
      purpose: options.purpose ?? { kind: 'interactive' },
    });
  }

  async runTrashCleanup(backend: SshWorkspaceBackend, script: string): Promise<void> {
    const host = this.getHost(backend.hostId);
    await this.run(
      host,
      [`cd ${shellQuotePosix(backend.remoteDirectory)} || exit $?`, script].join('\n'),
      SSH_TRASH_CLEANUP_TIMEOUT_MS
    );
  }

  private async resolveRemoteBasePath(host: SshHost, options?: SshRunOptions): Promise<string> {
    const normalizedBasePath = normalizeSshBasePath(host.basePath);
    if (normalizedBasePath !== '~' && !isValidSshBasePath(normalizedBasePath)) {
      throw new Error(
        'SSH base path must not resolve to the filesystem root or home directory or contain parent traversal'
      );
    }
    const script = [
      `configured=${shellQuotePosix(normalizedBasePath)}`,
      'case "$configured" in',
      '  "~") resolved="$HOME" ;;',
      '  "~/"*) resolved="$HOME/${configured#??}" ;;',
      '  /*) resolved="$configured" ;;',
      '  *) resolved="$(pwd -P)/$configured" ;;',
      'esac',
      'probe="$resolved"',
      'suffix=',
      'while [ ! -d "$probe" ]; do',
      '  name=${probe##*/}',
      '  [ -n "$name" ] || break',
      '  suffix="/$name$suffix"',
      '  parent=${probe%/*}',
      '  [ -n "$parent" ] || parent=/',
      '  [ "$parent" != "$probe" ] || break',
      '  probe="$parent"',
      'done',
      'probe_real=$(cd -P "$probe" && pwd -P) || exit 1',
      'resolved="${probe_real%/}$suffix"',
      '[ -n "$resolved" ] || resolved=/',
      'home_real=$(cd -P "$HOME" && pwd -P) || exit 1',
      'if [ "$resolved" = / ] || [ "$resolved" = "$home_real" ]; then',
      '  printf "[komla] refusing to use an unsafe remote data path\\n" >&2',
      '  exit 1',
      'fi',
      'printf "%s\\n" "$resolved"',
    ].join('\n');
    return stripTrailingSlash((await this.run(host, script, options)).trim());
  }

  private async getRemoteGitStatus(host: SshHost): Promise<SshHostSetupResult['git']> {
    const output = await this.run(
      host,
      [
        'if ! command -v git >/dev/null 2>&1; then',
        '  printf "status=missing\\n"',
        '  exit 0',
        'fi',
        'printf "status=available\\n"',
        'printf "version=%s\\n" "$(git --version)"',
      ].join('\n')
    );
    const values = parseKeyValueOutput(output);
    const trimmedOutput = output.trim();
    const version =
      values.get('version')?.trim() ||
      (trimmedOutput.startsWith('git version ') ? trimmedOutput : undefined);
    return version ? { status: 'available', version } : { status: 'missing' };
  }

  private async getRemoteGitIdentity(
    host: SshHost
  ): Promise<NonNullable<SshHostSetupResult['gitIdentity']>> {
    const output = await this.run(
      host,
      [
        'name="$(git config --global --get user.name 2>/dev/null || true)"',
        'email="$(git config --global --get user.email 2>/dev/null || true)"',
        'printf "userName=%s\\n" "$name"',
        'printf "userEmail=%s\\n" "$email"',
      ].join('\n')
    );
    const values = parseKeyValueOutput(output);
    const userName = values.get('userName')?.trim() || undefined;
    const userEmail = values.get('userEmail')?.trim() || undefined;
    return {
      configured: Boolean(userName && userEmail),
      userName,
      userEmail,
    };
  }

  private async getLocalGitIdentity(): Promise<SshHostSetupResult['localGitIdentity']> {
    const readValue = async (key: 'user.name' | 'user.email'): Promise<string | undefined> => {
      try {
        const { stdout } = await execFileAsync('git', ['config', '--global', '--get', key], {
          encoding: 'utf8',
          timeout: LOCAL_CAPABILITY_TIMEOUT_MS,
          maxBuffer: SSH_MAX_BUFFER,
          env: hostToolEnv(),
        });
        return stdout.trim() || undefined;
      } catch {
        return undefined;
      }
    };
    const [userName, userEmail] = await Promise.all([
      readValue('user.name'),
      readValue('user.email'),
    ]);
    return {
      configured: Boolean(userName && userEmail),
      userName,
      userEmail,
    };
  }

  private async copyLocalGitIdentity(
    host: SshHost,
    localIdentity: NonNullable<SshHostSetupResult['localGitIdentity']>
  ): Promise<NonNullable<SshHostSetupResult['gitIdentity']>> {
    const { userName, userEmail } = localIdentity;
    if (!userName || !userEmail) return { configured: false };

    await this.run(
      host,
      [
        `git config --global user.name ${shellQuotePosix(userName)} || true`,
        `git config --global user.email ${shellQuotePosix(userEmail)} || true`,
      ].join('\n')
    );
    return this.getRemoteGitIdentity(host);
  }

  private async getRemoteTmuxStatus(host: SshHost): Promise<SshHostSetupResult['tmux']> {
    const output = await this.run(
      host,
      [
        'if ! command -v tmux >/dev/null 2>&1; then',
        '  printf "status=missing\\n"',
        '  exit 0',
        'fi',
        'version="$(tmux -V 2>/dev/null || true)"',
        `if tmux -L ${TMUX_SOCKET_NAME} list-commands >/dev/null 2>&1; then`,
        '  printf "status=available\\n"',
        `  if tmux -L ${TMUX_SOCKET_NAME} has-session 2>/dev/null; then`,
        remoteTmuxServerSetupCommand()
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n'),
        '  fi',
        'else',
        '  printf "status=unusable\\n"',
        'fi',
        'printf "version=%s\\n" "$version"',
      ].join('\n')
    );
    const values = parseKeyValueOutput(output);
    const status = values.get('status');
    const version = values.get('version')?.trim() || undefined;
    return {
      status: status === 'available' || status === 'missing' ? status : 'unusable',
      version,
    };
  }

  private async getCachedRemoteTmuxStatus(host: SshHost): Promise<SshHostSetupResult['tmux']> {
    const connectionKey = this.hostConnectionKey(host);
    const cached = this.remoteTmuxStatuses.get(host.id);
    if (cached?.connectionKey === connectionKey) return cached.status;
    const pending = this.remoteTmuxStatusChecks.get(host.id);
    if (pending?.connectionKey === connectionKey) return pending.promise;

    const check = this.getRemoteTmuxStatus(host).then((status) => {
      this.remoteTmuxStatuses.set(host.id, { connectionKey, status });
      return status;
    });
    this.remoteTmuxStatusChecks.set(host.id, { connectionKey, promise: check });
    try {
      return await check;
    } finally {
      if (this.remoteTmuxStatusChecks.get(host.id)?.promise === check) {
        this.remoteTmuxStatusChecks.delete(host.id);
      }
    }
  }

  private async getLocalRsyncStatus(): Promise<'available' | 'missing'> {
    try {
      await execFileAsync('rsync', ['--version'], {
        timeout: LOCAL_CAPABILITY_TIMEOUT_MS,
        maxBuffer: SSH_MAX_BUFFER,
      });
      return 'available';
    } catch {
      return 'missing';
    }
  }

  private async getRemoteSupportToolsStatus(host: SshHost): Promise<{
    remoteRsync: 'available' | 'missing';
    monitoring: NonNullable<SshHostSetupResult['monitoring']>;
  }> {
    const output = await this.run(
      host,
      [
        'if command -v rsync >/dev/null 2>&1; then printf "rsyncStatus=available\\n"; else printf "rsyncStatus=missing\\n"; fi',
        'missing=""',
        'for tool in awk cat head mkdir mv readlink rm sed sleep tr wc xargs; do',
        '  if ! command -v "$tool" >/dev/null 2>&1; then missing="${missing}${missing:+,}$tool"; fi',
        'done',
        'if ! command -v base64 >/dev/null 2>&1 && ! command -v openssl >/dev/null 2>&1; then',
        '  missing="${missing}${missing:+,}base64 or openssl"',
        'fi',
        'if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then',
        '  missing="${missing}${missing:+,}curl or wget"',
        'fi',
        'if [ -n "$missing" ]; then printf "monitoringStatus=missing\\nrequirements=%s\\n" "$missing"; else printf "monitoringStatus=available\\n"; fi',
      ].join('\n')
    );
    const values = parseKeyValueOutput(output);
    const missingRequirements = (values.get('requirements') ?? '')
      .split(',')
      .map((requirement) => requirement.trim())
      .filter(Boolean);
    return {
      remoteRsync: values.get('rsyncStatus') === 'available' ? 'available' : 'missing',
      monitoring: {
        status: values.get('monitoringStatus') === 'available' ? 'available' : 'missing',
        missingRequirements,
      },
    };
  }

  async checkHostCapabilities(host: SshHost): Promise<SshHostSetupResult> {
    const normalizedHost = { ...host, basePath: normalizeSshBasePath(host.basePath) };
    const basePath = await this.resolveRemoteBasePath(normalizedHost);
    const git = await this.getRemoteGitStatus(normalizedHost);
    const gitIdentity =
      git.status === 'available' ? await this.getRemoteGitIdentity(normalizedHost) : undefined;
    const localGitIdentity =
      gitIdentity && !gitIdentity.configured ? await this.getLocalGitIdentity() : undefined;
    const tmux = await this.getCachedRemoteTmuxStatus(normalizedHost);
    const [localRsync, remoteSupportTools] = await Promise.all([
      process.platform === 'win32'
        ? Promise.resolve<'missing'>('missing')
        : this.getLocalRsyncStatus(),
      this.getRemoteSupportToolsStatus(normalizedHost),
    ]);
    return {
      ok: true,
      prepared: false,
      resolvedBasePath: basePath,
      git,
      localMirror: {
        platform: process.platform === 'win32' ? 'unsupported' : 'supported',
        localRsync,
        remoteRsync: remoteSupportTools.remoteRsync,
      },
      tmux,
      monitoring: remoteSupportTools.monitoring,
      ...(gitIdentity ? { gitIdentity } : {}),
      ...(localGitIdentity ? { localGitIdentity } : {}),
    };
  }

  async verifyAndPrepareHost(host: SshHost): Promise<SshHostSetupResult> {
    const result = await this.checkHostCapabilities(host);
    if (
      result.git.status !== 'available' ||
      result.tmux.status !== 'available' ||
      result.monitoring?.status !== 'available'
    ) {
      return result;
    }
    const normalizedHost = { ...host, basePath: normalizeSshBasePath(host.basePath) };
    const gitIdentity =
      result.gitIdentity && !result.gitIdentity.configured && result.localGitIdentity?.configured
        ? await this.copyLocalGitIdentity(normalizedHost, result.localGitIdentity)
        : result.gitIdentity;
    await this.ensureRemoteLayout(normalizedHost, result.resolvedBasePath, {
      refreshNotifyScript: true,
    });
    return {
      ...result,
      prepared: true,
      notifyScriptPath: joinRemote(result.resolvedBasePath, 'helpers', 'notify.sh'),
      ...(gitIdentity ? { gitIdentity } : {}),
    };
  }

  private async resolveRemoteHome(host: SshHost): Promise<string> {
    return stripTrailingSlash((await this.run(host, 'printf "%s\\n" "$HOME"')).trim());
  }

  private async readRemoteText(host: SshHost, remotePath: string): Promise<string> {
    return this.run(
      host,
      `if [ -f ${shellQuotePosix(remotePath)} ]; then cat ${shellQuotePosix(remotePath)}; fi`
    );
  }

  /** Returns false when it left the file alone because `unlessExists` exists. */
  async writeRemoteText(
    host: SshHost,
    remotePath: string,
    content: string,
    executable = false,
    unlessExists?: string
  ): Promise<boolean> {
    const command = [
      'set -e',
      ...(unlessExists
        ? [`if [ -e ${shellQuotePosix(unlessExists)} ]; then printf ${WRITE_SKIPPED}; exit 0; fi`]
        : []),
      ...remoteWriteFromStdinLines(remotePath, executable),
    ].join('\n');
    const output = await this.runWithInput(host, command, content);
    return !unlessExists || !output.includes(WRITE_SKIPPED);
  }

  private async readRemoteJson(
    host: SshHost,
    remotePath: string
  ): Promise<Record<string, unknown>> {
    const quotedPath = shellQuotePosix(remotePath);
    const output = await this.run(
      host,
      `if [ -f ${quotedPath} ]; then printf "1"; cat ${quotedPath}; else printf "0"; fi`
    );
    if (output[0] === '0') return {};
    if (output[0] !== '1') {
      throw new Error(`Could not determine whether remote configuration ${remotePath} exists`);
    }
    return parseJsonObject(output.slice(1), remotePath);
  }

  private async writeRemoteJson(
    host: SshHost,
    remotePath: string,
    value: Record<string, unknown>
  ): Promise<void> {
    await this.writeRemoteText(host, remotePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  async getIntegrationStatus(hostId: string): Promise<SshIntegrationStatus> {
    const host = this.getHost(hostId);
    const empty: SshIntegrationStatus = {
      claude: { notifications: false, mcp: false },
      codex: { notifications: false, mcp: false },
      antigravity: { notifications: false, mcp: false },
      opencode: { notifications: false, mcp: false },
      komlaSkill: false,
    };
    const check = Symbol(hostId);
    this.integrationChecks.set(hostId, check);
    try {
      // Update detection needs the base path; without it, still report what is installed.
      const [basePath, home] = await Promise.all([
        this.resolveWorkspaceBasePath(hostId).catch(() => undefined),
        this.resolveRemoteHome(host),
      ]);
      const claudeSettingsPath = this.notificationHookPath(home, 'claude');
      const claudeSettings = await this.readRemoteJson(host, claudeSettingsPath);
      // Asking Claude for its version starts an interactive login shell, so only an installed
      // integration, whose update depends on it, asks; the other files are read meanwhile.
      const claudeVersion = ALL_CLAUDE_HOOK_EVENTS.some(
        (event) => this.managedHookCommands(claudeSettings, event).length > 0
      )
        ? this.remoteClaudeVersion(host)
        : Promise.resolve(undefined);
      const claudeJson = await this.readRemoteJson(host, joinRemote(home, '.claude.json'));
      const codexHooksPath = this.notificationHookPath(home, 'codex');
      const codexHooks = await this.readRemoteJson(host, codexHooksPath);
      const codexConfig = await this.readRemoteText(
        host,
        joinRemote(home, '.codex', 'config.toml')
      );
      const antigravityHooksPath = antigravityConfigPath(home, ANTIGRAVITY_HOOKS_FILE);
      const antigravityHooks = await this.readRemoteJson(host, antigravityHooksPath);
      const antigravityMcp = await this.readRemoteJson(
        host,
        antigravityConfigPath(home, ANTIGRAVITY_MCP_FILE)
      );
      // Unreadable Antigravity settings only mean its alerts aren't known to be on.
      const antigravitySettings = await this.readRemoteJson(
        host,
        antigravitySettingsPath(home)
      ).catch(() => ({}));
      const opencodeConfig = await this.readRemoteJson(
        host,
        joinRemote(home, '.config', 'opencode', 'opencode.json')
      );
      const opencodePluginPath = joinRemote(
        home,
        '.config',
        'opencode',
        'plugins',
        'komla-notify.js'
      );
      const opencodePlugin = await this.readRemoteText(host, opencodePluginPath);
      const komlaSkill = await this.refreshRemoteKomlaSkill(host, home);

      const status: SshIntegrationStatus = {
        claude: {
          notifications: this.hasManagedHooks(claudeSettings, ['Notification']),
          mcp: !!getRecord(getRecord(claudeJson.mcpServers)?.komla),
          update: this.claudeHookUpdate(
            basePath,
            claudeSettingsPath,
            claudeSettings,
            await claudeVersion
          ),
        },
        codex: {
          notifications: this.hasManagedHooks(codexHooks, CODEX_NOTIFICATION_HOOK_EVENTS),
          mcp: /\[mcp_servers\.komla\]/.test(codexConfig),
          update: this.notificationHookUpdate('codex', basePath, codexHooksPath, codexHooks),
        },
        antigravity: {
          notifications: isAntigravityHookSetEnabled(antigravityHooks[ANTIGRAVITY_HOOK_SET]),
          mcp: isAntigravityMcpServerEnabled(getRecord(antigravityMcp.mcpServers)?.komla),
          update: this.antigravityHookUpdate(
            basePath,
            { path: antigravityHooksPath, config: antigravityHooks },
            { path: antigravitySettingsPath(home), settings: antigravitySettings }
          ),
        },
        opencode: {
          notifications: opencodePlugin.includes('Komla notification plugin'),
          mcp: !!getRecord(getRecord(opencodeConfig.mcp)?.komla),
          update: this.openCodePluginUpdate(basePath, opencodePluginPath, opencodePlugin),
        },
        komlaSkill,
      };
      // A host save or a newer check supersedes this one.
      if (this.integrationChecks.get(hostId) === check) {
        const updates: SshIntegrationUpdates = {};
        for (const agent of SSH_AGENTS) {
          const update = status[agent].update;
          if (update) updates[agent] = update.preview;
        }
        this.setIntegrationUpdates(hostId, updates);
      }
      return status;
    } catch (error) {
      logger.warn('Failed to read SSH integration status', {
        hostId,
        message: sshErrorText(error),
      });
      return empty;
    }
  }

  /** Agents needing a notification update per host, as of each host's last integration check. */
  getCachedIntegrationUpdates(): Record<string, SshIntegrationUpdates> {
    return Object.fromEntries(this.integrationUpdates);
  }

  /** Called with every host's cached updates whenever one host's check or removal changes them. */
  onIntegrationUpdatesChanged(
    listener: (updates: Record<string, SshIntegrationUpdates>) => void
  ): void {
    this.integrationUpdateListeners.push(listener);
  }

  private setIntegrationUpdates(hostId: string, updates: SshIntegrationUpdates = {}): void {
    if (Object.keys(updates).length > 0) {
      this.integrationUpdates.set(hostId, updates);
    } else if (!this.integrationUpdates.delete(hostId)) {
      return;
    }
    const cached = this.getCachedIntegrationUpdates();
    for (const listener of this.integrationUpdateListeners) listener(cached);
  }

  async enableIntegration(
    hostId: string,
    agent: SshAgent,
    type: SshIntegrationType
  ): Promise<void> {
    return this.serializeIntegrationMutation(hostId, () =>
      this.enableIntegrationLocked(hostId, agent, type)
    );
  }

  private async enableIntegrationLocked(
    hostId: string,
    agent: SshAgent,
    type: SshIntegrationType
  ): Promise<void> {
    const host = this.getHost(hostId);
    const basePath = await this.resolveRemoteBasePath(host);
    if (type === 'mcp') {
      await this.enableMcp(host, agent, remoteMcpCommand(basePath));
      return;
    }
    await this.ensureRemoteLayout(host, basePath);
    await this.enableNotifications(host, agent, basePath);
  }

  async disableIntegration(
    hostId: string,
    agent: SshAgent,
    type: SshIntegrationType
  ): Promise<void> {
    return this.serializeIntegrationMutation(hostId, () =>
      this.disableIntegrationLocked(hostId, agent, type)
    );
  }

  private async disableIntegrationLocked(
    hostId: string,
    agent: SshAgent,
    type: SshIntegrationType
  ): Promise<void> {
    if (type === 'mcp') {
      await this.disableMcp(this.getHost(hostId), agent);
      return;
    }
    await this.disableNotifications(this.getHost(hostId), agent);
  }

  /** Adds the Komla skill to the host's skills folders, or removes it. */
  async setKomlaSkill(hostId: string, enabled: boolean): Promise<void> {
    return this.serializeIntegrationMutation(hostId, async () => {
      const host = this.getHost(hostId);
      if (enabled) {
        await this.writeRemoteKomlaSkill(host, await this.resolveRemoteHome(host));
      } else {
        await this.removeRemoteKomlaSkill(host);
      }
    });
  }

  async deleteHostData(hostId: string): Promise<void> {
    try {
      await this.serializeIntegrationMutation(hostId, async () => {
        const host = this.getHost(hostId);
        await this.killAllTerminalSessions(host);
        for (const agent of SSH_AGENTS) {
          await this.disableIntegrationLocked(hostId, agent, 'notifications');
          await this.disableIntegrationLocked(hostId, agent, 'mcp');
        }
        await this.removeRemoteKomlaSkill(host);
        await this.deleteRemoteDataDirectory(host);
        this.preparedNotifyScriptHosts.delete(hostId);
        this.remoteTmuxStatuses.delete(hostId);
        this.remoteTmuxStatusChecks.delete(hostId);
      });
    } catch (error) {
      if (isSshAgentSigningRefusal(error)) {
        throw new Error(
          'Your SSH agent did not approve use of the SSH key. Approve the key request or unlock the key in your SSH agent, then try again.'
        );
      }
      throw error;
    }
  }

  forgetHost(hostId: string): void {
    sshConnectionService.forgetExecChannel(hostId);
    this.preparedNotifyScriptHosts.delete(hostId);
    this.setIntegrationUpdates(hostId);
    this.integrationChecks.delete(hostId);
    this.remoteTmuxStatuses.delete(hostId);
    this.remoteTmuxStatusChecks.delete(hostId);
  }

  private serializeIntegrationMutation(
    hostId: string,
    operation: () => Promise<void>
  ): Promise<void> {
    const previous = this.integrationMutations.get(hostId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.integrationMutations.set(hostId, settled);
    void settled.finally(() => {
      if (this.integrationMutations.get(hostId) === settled) {
        this.integrationMutations.delete(hostId);
      }
    });
    return result;
  }

  private hasManagedHooks(config: Record<string, unknown>, events: readonly string[]): boolean {
    return events.every((event) => this.managedHookCommands(config, event).length > 0);
  }

  private upsertHook(
    config: Record<string, unknown>,
    event: string,
    entry: Record<string, unknown>
  ): void {
    const hooks = getRecord(config.hooks) ?? {};
    config.hooks = hooks;
    const matchers = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = [...this.withoutManagedHooks(matchers), entry];
  }

  private removeManagedHooks(config: Record<string, unknown>, events: readonly string[]): void {
    const hooks = getRecord(config.hooks);
    if (!hooks) return;
    for (const event of events) {
      const matchers = hooks[event];
      if (!Array.isArray(matchers)) continue;
      const next = this.withoutManagedHooks(matchers);
      if (next.length > 0) {
        hooks[event] = next;
      } else {
        delete hooks[event];
      }
    }
    if (Object.keys(hooks).length === 0) {
      delete config.hooks;
    }
  }

  private withoutManagedHooks(matchers: unknown[]): unknown[] {
    return matchers.flatMap((matcher) => {
      const matcherRecord = getRecord(matcher);
      const matcherHooks = matcherRecord?.hooks;
      if (!Array.isArray(matcherHooks)) return [matcher];
      const remainingHooks = matcherHooks.filter((hook) => {
        const command = getRecord(hook)?.command;
        return typeof command !== 'string' || !command.includes(SSH_HOOK_MARKER);
      });
      if (remainingHooks.length === matcherHooks.length) return [matcher];
      if (remainingHooks.length === 0) return [];
      return [{ ...matcherRecord, hooks: remainingHooks }];
    });
  }

  private notificationCommand(agent: SshAgent, basePath: string, event: string): string {
    const cliPath = joinRemote(basePath, 'helpers', 'komla');
    const source = agent === 'claude' ? 'claude-code' : agent;
    return `${shellQuotePosix(cliPath)} notify --source ${shellQuotePosix(
      source
    )} --event ${shellQuotePosix(event)}${agent === 'codex' ? ' >/dev/null' : ''} # ${SSH_HOOK_MARKER}`;
  }

  private notificationHookPath(home: string, agent: SshHookAgent): string {
    if (agent === 'claude') return joinRemote(home, '.claude', 'settings.json');
    return joinRemote(home, '.codex', 'hooks.json');
  }

  private notificationHookEntry(
    agent: SshHookAgent,
    basePath: string,
    event: string
  ): Record<string, unknown> {
    const command = this.notificationCommand(agent, basePath, event);
    if (agent === 'codex') return { hooks: [{ type: 'command', command }] };
    return { matcher: '', hooks: [{ type: 'command', command, async: true }] };
  }

  private managedHookCommands(config: Record<string, unknown>, event: string): string[] {
    const matchers = getRecord(config.hooks)?.[event];
    if (!Array.isArray(matchers)) return [];
    return matchers.flatMap((matcher) => {
      const hooks = getRecord(matcher)?.hooks;
      if (!Array.isArray(hooks)) return [];
      return hooks
        .map((hook) => getRecord(hook)?.command)
        .filter(
          (command): command is string =>
            typeof command === 'string' && command.includes(SSH_HOOK_MARKER)
        );
    });
  }

  /** Set when Komla hooks are installed but differ from what enabling writes now. */
  private notificationHookUpdate(
    agent: SshHookAgent,
    basePath: string | undefined,
    path: string,
    config: Record<string, unknown>
  ): RemoteNotificationIntegrationUpdate | undefined {
    if (!basePath) return undefined;
    const events = SSH_NOTIFICATION_HOOK_EVENTS[agent];
    const installed = events.map((event) => this.managedHookCommands(config, event));
    if (installed.every((commands) => commands.length === 0)) return undefined;
    const current = events.every((event, index) =>
      installed[index].includes(this.notificationCommand(agent, basePath, event))
    );
    if (current) return undefined;
    return remoteHookUpdate(
      path,
      Object.fromEntries(
        events.map((event) => [event, [this.notificationHookEntry(agent, basePath, event)]])
      )
    );
  }

  /** Like notificationHookUpdate, for the events the host's Claude version allows. */
  private claudeHookUpdate(
    basePath: string | undefined,
    path: string,
    config: Record<string, unknown>,
    claudeVersion: string | undefined
  ): RemoteNotificationIntegrationUpdate | undefined {
    if (!basePath) return undefined;
    const managed = (event: string) => this.managedHookCommands(config, event);
    if (ALL_CLAUDE_HOOK_EVENTS.every((event) => managed(event).length === 0)) return undefined;
    const plan = claudeHookPlan(claudeVersion);
    const expected = (event: string) => this.notificationCommand('claude', basePath, event);
    if (!claudeHooksOutdated(plan, managed, expected)) return undefined;
    return remoteHookUpdate(
      path,
      Object.fromEntries(
        claudeHooksToWrite(plan, managed).map((event) => [
          event,
          [this.notificationHookEntry('claude', basePath, event)],
        ])
      )
    );
  }

  private antigravityHookSet(basePath: string): ReturnType<typeof buildAntigravityHookSet> {
    return buildAntigravityHookSet((event) =>
      this.notificationCommand('antigravity', basePath, event)
    );
  }

  /** Set when what enabling Antigravity notifications writes differs from what is installed. */
  private antigravityHookUpdate(
    basePath: string | undefined,
    hooks: { path: string; config: Record<string, unknown> },
    settings: { path: string; settings: Record<string, unknown> }
  ): RemoteNotificationIntegrationUpdate | undefined {
    if (!basePath) return undefined;
    const expected = this.antigravityHookSet(basePath);
    const files = antigravityUpdateFiles(
      { path: hooks.path, installed: hooks.config[ANTIGRAVITY_HOOK_SET], expected },
      { path: settings.path, installed: settings.settings }
    );
    return files && remoteAntigravityUpdate(files, expected);
  }

  private openCodePluginUpdate(
    basePath: string | undefined,
    path: string,
    installed: string
  ): RemoteNotificationIntegrationUpdate | undefined {
    if (!basePath || !installed) return undefined;
    const plugin = buildOpenCodeNotifyPlugin(joinRemote(basePath, 'helpers', 'komla'));
    if (installed === plugin) return undefined;
    return remotePluginUpdate(path, plugin);
  }

  private async enableNotifications(
    host: SshHost,
    agent: SshAgent,
    basePath: string
  ): Promise<void> {
    const home = await this.resolveRemoteHome(host);
    if (agent === 'antigravity') {
      // Other hook sets in hooks.json belong to the user or to plugins.
      const file = antigravityConfigPath(home, ANTIGRAVITY_HOOKS_FILE);
      const config = await this.readRemoteJson(host, file);
      config[ANTIGRAVITY_HOOK_SET] = this.antigravityHookSet(basePath);
      await this.writeRemoteJson(host, file, config);
      const settingsFile = antigravitySettingsPath(home);
      const settings = await this.readRemoteJson(host, settingsFile);
      if (!areAntigravityAlertsOn(settings)) {
        settings[ANTIGRAVITY_ALERTS_SETTING] = true;
        await this.writeRemoteJson(host, settingsFile, settings);
      }
      return;
    }
    if (agent !== 'opencode') {
      const file = this.notificationHookPath(home, agent);
      const settings = await this.readRemoteJson(host, file);
      let events = SSH_NOTIFICATION_HOOK_EVENTS[agent];
      if (agent === 'claude') {
        const plan = claudeHookPlan(await this.remoteClaudeVersion(host, true));
        events = claudeHooksToWrite(plan, (event) => this.managedHookCommands(settings, event));
        this.removeManagedHooks(settings, plan.remove);
      }
      for (const event of events) {
        this.upsertHook(settings, event, this.notificationHookEntry(agent, basePath, event));
      }
      await this.writeRemoteJson(host, file, settings);
      return;
    }
    const pluginContent = buildOpenCodeNotifyPlugin(joinRemote(basePath, 'helpers', 'komla'));
    await this.writeRemoteText(
      host,
      joinRemote(home, '.config', 'opencode', 'plugins', 'komla-notify.js'),
      pluginContent
    );
  }

  private async disableNotifications(host: SshHost, agent: SshAgent): Promise<void> {
    const home = await this.resolveRemoteHome(host);
    if (agent === 'opencode') {
      await this.run(
        host,
        `rm -f ${shellQuotePosix(
          joinRemote(home, '.config', 'opencode', 'plugins', 'komla-notify.js')
        )}`
      );
      return;
    }
    if (agent === 'antigravity') {
      const file = antigravityConfigPath(home, ANTIGRAVITY_HOOKS_FILE);
      const config = await this.readRemoteJson(host, file);
      if (ANTIGRAVITY_HOOK_SET in config) {
        delete config[ANTIGRAVITY_HOOK_SET];
        await this.writeRemoteJson(host, file, config);
      }
      return;
    }
    const file = this.notificationHookPath(home, agent);
    const settings = await this.readRemoteJson(host, file);
    const previousSettings = JSON.stringify(settings);
    this.removeManagedHooks(
      settings,
      agent === 'claude' ? ALL_CLAUDE_HOOK_EVENTS : SSH_NOTIFICATION_HOOK_EVENTS[agent]
    );
    if (JSON.stringify(settings) !== previousSettings) {
      await this.writeRemoteJson(host, file, settings);
    }
  }

  /**
   * The host's Claude version, or undefined when it can't be read; see claude-hook-events.
   * `fresh` skips the cached answer.
   */
  private remoteClaudeVersion(host: SshHost, fresh = false): Promise<string | undefined> {
    return this.claudeVersions.get(
      host.id,
      async () => {
        try {
          return parseClaudeVersion(await this.run(host, CLAUDE_VERSION_COMMAND, 15_000));
        } catch {
          return undefined;
        }
      },
      fresh
    );
  }

  /** Each skills folder's Komla SKILL.md on the host, in one round trip. */
  private async readRemoteKomlaSkills(host: SshHost, home: string): Promise<RemoteSkillCopy[]> {
    const output = await this.run(
      host,
      KOMLA_SKILLS_FOLDERS.map((folder) => {
        const file = shellQuotePosix(joinRemote(home, ...komlaSkillFileSegments(folder)));
        const applies = folder.onlyWith
          ? `if [ -d ${shellQuotePosix(joinRemote(home, folder.onlyWith))} ]; then echo 1; else echo 0; fi`
          : 'echo 1';
        return `printf "\\n%s\\n" ${SKILL_FILE_DELIMITER}; ${applies}; if [ -f ${file} ]; then cat ${file}; fi`;
      }).join('\n')
    );
    // Trimmed output loses the first delimiter's leading newline.
    const sections = `\n${output}`.split(`\n${SKILL_FILE_DELIMITER}\n`).slice(1);
    return KOMLA_SKILLS_FOLDERS.map((folder, index) => {
      const [flag = '', ...content] = (sections[index] ?? '').split('\n');
      return {
        file: joinRemote(home, ...komlaSkillFileSegments(folder)),
        applies: flag === '1',
        content: content.join('\n'),
      };
    });
  }

  private async writeRemoteKomlaSkill(host: SshHost, home: string): Promise<void> {
    const skill = readKomlaSkill();
    for (const copy of await this.readRemoteKomlaSkills(host, home)) {
      if (copy.applies) await this.writeRemoteText(host, copy.file, skill);
    }
  }

  /**
   * Whether the host has Komla's skill. While it does, writes this version's to each skills
   * folder that lacks it or has an older one.
   */
  private async refreshRemoteKomlaSkill(host: SshHost, home: string): Promise<boolean> {
    const copies = await this.readRemoteKomlaSkills(host, home);
    if (!copies.some((copy) => isKomlaSkill(copy.content))) return false;
    try {
      const bundled = readKomlaSkill();
      for (const copy of copies) {
        // Command output may lose the last file's final newline.
        const current = copy.content.trimEnd() === bundled.trimEnd();
        const someoneElses = copy.content !== '' && !isKomlaSkill(copy.content);
        if (copy.applies && !current && !someoneElses) {
          await this.writeRemoteText(host, copy.file, bundled);
        }
      }
    } catch (error) {
      logger.warn('Failed to refresh the Komla skill', {
        hostId: host.id,
        message: sshErrorText(error),
      });
    }
    return true;
  }

  /** Removes each skill folder whose SKILL.md is Komla's. */
  private async removeRemoteKomlaSkill(host: SshHost): Promise<void> {
    const home = await this.resolveRemoteHome(host);
    const folders = (await this.readRemoteKomlaSkills(host, home))
      .filter((copy) => isKomlaSkill(copy.content))
      .map((copy) => shellQuotePosix(pathPosix.dirname(copy.file)));
    if (folders.length > 0) await this.run(host, `rm -rf ${folders.join(' ')}`);
  }

  private async enableMcp(
    host: SshHost,
    agent: SshAgent,
    server: { command: string; args: string[] }
  ): Promise<void> {
    const home = await this.resolveRemoteHome(host);
    if (agent === 'claude') {
      const file = joinRemote(home, '.claude.json');
      const settings = await this.readRemoteJson(host, file);
      const mcpServers = getRecord(settings.mcpServers) ?? {};
      settings.mcpServers = mcpServers;
      mcpServers.komla = {
        type: 'stdio',
        command: server.command,
        args: server.args,
      };
      await this.writeRemoteJson(host, file, settings);
      return;
    }
    if (agent === 'codex') {
      const file = joinRemote(home, '.codex', 'config.toml');
      const content = await this.readRemoteText(host, file);
      const next = setCodexMcpServer(content, server);
      await this.writeRemoteText(host, file, next);
      return;
    }
    if (agent === 'antigravity') {
      const file = antigravityConfigPath(home, ANTIGRAVITY_MCP_FILE);
      const settings = await this.readRemoteJson(host, file);
      const mcpServers = getRecord(settings.mcpServers) ?? {};
      settings.mcpServers = mcpServers;
      mcpServers.komla = {
        command: server.command,
        args: server.args,
      };
      await this.writeRemoteJson(host, file, settings);
      return;
    }
    const file = joinRemote(home, '.config', 'opencode', 'opencode.json');
    const settings = await this.readRemoteJson(host, file);
    const mcp = getRecord(settings.mcp) ?? {};
    settings.mcp = mcp;
    mcp.komla = {
      type: 'local',
      command: [server.command, ...server.args],
    };
    await this.writeRemoteJson(host, file, settings);
  }

  private async disableMcp(host: SshHost, agent: SshAgent): Promise<void> {
    const home = await this.resolveRemoteHome(host);
    if (agent === 'claude') {
      const file = joinRemote(home, '.claude.json');
      const settings = await this.readRemoteJson(host, file);
      const mcpServers = getRecord(settings.mcpServers);
      if (mcpServers?.komla) {
        delete mcpServers.komla;
        if (Object.keys(mcpServers).length === 0) delete settings.mcpServers;
        await this.writeRemoteJson(host, file, settings);
      }
      return;
    }
    if (agent === 'codex') {
      const file = joinRemote(home, '.codex', 'config.toml');
      const content = await this.readRemoteText(host, file);
      const next = setCodexMcpServer(content, null);
      if (next !== content) {
        await this.writeRemoteText(host, file, next);
      }
      return;
    }
    if (agent === 'antigravity') {
      const file = antigravityConfigPath(home, ANTIGRAVITY_MCP_FILE);
      const settings = await this.readRemoteJson(host, file);
      if (removeKomlaMcpServer(settings)) {
        await this.writeRemoteJson(host, file, settings);
      }
      return;
    }
    const file = joinRemote(home, '.config', 'opencode', 'opencode.json');
    const settings = await this.readRemoteJson(host, file);
    const mcp = getRecord(settings.mcp);
    if (mcp?.komla) {
      delete mcp.komla;
      if (Object.keys(mcp).length === 0) delete settings.mcp;
      await this.writeRemoteJson(host, file, settings);
    }
  }

  private async ensureRemoteLayout(
    host: SshHost,
    basePath: string,
    options: { refreshNotifyScript?: boolean } = {}
  ): Promise<void> {
    const markerPath = joinRemote(basePath, SSH_DATA_MARKER_FILE);
    const command = [
      `mkdir -p ${[
        shellQuotePosix(joinRemote(basePath, 'repos')),
        shellQuotePosix(joinRemote(basePath, 'worktrees')),
        shellQuotePosix(joinRemote(basePath, 'helpers')),
      ].join(' ')}`,
      `marker=${shellQuotePosix(markerPath)}`,
      'if [ -L "$marker" ]; then',
      '  printf "[komla] refusing to use a symlinked remote data marker\\n" >&2',
      '  exit 1',
      'fi',
      `if [ -e "$marker" ] && [ "$(cat "$marker")" != ${shellQuotePosix(
        SSH_DATA_MARKER_CONTENT
      )} ]; then`,
      '  printf "[komla] remote data marker is not owned by Komla\\n" >&2',
      '  exit 1',
      'fi',
      'umask 077',
      `printf "%s\\n" ${shellQuotePosix(SSH_DATA_MARKER_CONTENT)} > "$marker" || exit 1`,
      // An installed notify script is kept, so the layout needs no other round trip.
      ...(options.refreshNotifyScript
        ? []
        : [
            `if [ -x ${shellQuotePosix(joinRemote(basePath, 'helpers', 'notify.sh'))} ]; then`,
            `  printf "%s\\n" ${NOTIFY_SCRIPT_READY}`,
            'fi',
          ]),
    ].join('\n');
    const output = await this.run(host, command);
    if (options.refreshNotifyScript || !output.includes(NOTIFY_SCRIPT_READY)) {
      await this.installRemoteHelperScripts(host, basePath);
    }
  }

  /** Writes the helper scripts in one round trip. */
  private async installRemoteHelperScripts(host: SshHost, basePath: string): Promise<void> {
    const scripts: Array<[string, string]> = [
      [joinRemote(basePath, 'helpers', 'notify.sh'), generateNotifyShellScript()],
      [joinRemote(basePath, 'helpers', 'tmux-server.sh'), generateTmuxServerScript()],
    ];
    const writes = scripts.map(([remotePath, content]) => {
      if (content.includes(HELPER_SCRIPT_DELIMITER)) {
        throw new Error(`Helper script ${remotePath} contains its here-document delimiter`);
      }
      const body = content.endsWith('\n') ? content : `${content}\n`;
      return [
        '(',
        ...remoteWriteFromStdinLines(remotePath, true),
        `) <<'${HELPER_SCRIPT_DELIMITER}'`,
        `${body}${HELPER_SCRIPT_DELIMITER}`,
      ].join('\n');
    });
    await this.run(host, ['set -e', ...writes].join('\n'));
  }

  async ensureRemoteNotificationScript(backend: SshWorkspaceBackend): Promise<void> {
    const host = this.getHost(backend.hostId);
    const basePath = pathPosix.dirname(pathPosix.dirname(backend.remoteProjectRoot));
    const cacheKey = JSON.stringify([this.hostConnectionKey(host), basePath]);
    const preparedConnections = this.preparedNotifyScriptHosts.get(host.id);
    if (preparedConnections?.has(cacheKey)) return;

    await this.installRemoteHelperScripts(host, basePath);
    if (preparedConnections) {
      preparedConnections.add(cacheKey);
    } else {
      this.preparedNotifyScriptHosts.set(host.id, new Set([cacheKey]));
    }
    // Recheck integrations while connected, so settings can flag an update without connecting.
    // It joins the integration queue so it can't overwrite a change made while it runs.
    void this.serializeIntegrationMutation(host.id, async () => {
      await this.getIntegrationStatus(host.id);
    }).catch(() => undefined);
  }

  async resolveWorkspaceBasePath(hostId: string): Promise<string> {
    const host = this.getHost(hostId);
    const connectionKey = JSON.stringify([
      this.hostConnectionKey(host),
      host.forwardAgent,
      normalizeSshBasePath(host.basePath),
    ]);
    const cached = this.workspaceBasePathResolutions.get(hostId);
    if (cached?.connectionKey === connectionKey) return cached.promise;

    const promise = this.resolveRemoteBasePath(host);
    this.workspaceBasePathResolutions.set(hostId, { connectionKey, promise });
    void promise.catch(() => {
      if (this.workspaceBasePathResolutions.get(hostId)?.promise === promise) {
        this.workspaceBasePathResolutions.delete(hostId);
      }
    });
    return promise;
  }

  /** Where a new workspace clones the project under the host's resolved base path. */
  managedRepoPath(basePath: string, projectName: string): string {
    return joinRemote(
      stripTrailingSlash(basePath),
      'repos',
      safeRemoteSegment(projectName),
      'repo.git'
    );
  }

  createWorkspacePlan(args: CreateSshWorkspaceArgs): SshWorkspaceCreateResult {
    const host = this.getHost(args.hostId);
    const basePath = args.sourceBackend
      ? pathPosix.dirname(pathPosix.dirname(args.sourceBackend.remoteProjectRoot))
      : stripTrailingSlash(args.resolvedBasePath ?? normalizeSshBasePath(host.basePath));
    const repoName = repoNameFromSource(args);
    const gitUrl = remoteGitUrlFromSource(host, args);
    const branchSlug = remoteBranchPathSegment(args.branchName);
    const projectSlug = safeRemoteSegment(args.projectName);
    const remoteRepoPath =
      args.sourceBackend?.remoteRepoPath ?? this.managedRepoPath(basePath, args.projectName);
    const remoteProjectRoot =
      args.sourceBackend?.remoteProjectRoot ?? joinRemote(basePath, 'worktrees', projectSlug);
    const remoteDirectory = joinRemote(remoteProjectRoot, branchSlug);
    const baseBranch = normalizeTargetBranch(args.baseBranch);

    return {
      backend: {
        kind: 'ssh',
        hostId: host.id,
        remoteDirectory,
        remoteRepoPath,
        remoteProjectRoot,
        gitUrl,
        ...(args.projectId ? { projectId: args.projectId } : {}),
        projectName: args.projectName,
        branchName: args.branchName,
        ...(args.checkoutExistingBranch ? { checkoutExistingBranch: true } : {}),
        ...(baseBranch ? { baseBranch } : {}),
        startPoint: args.startPoint?.trim() || baseBranch || 'HEAD',
      },
      workingDirectory: `ssh://${host.id}${remoteDirectory}`,
      repoName,
    };
  }

  withRemoteDirectoryAttempt(backend: SshWorkspaceBackend, attempt: number): SshWorkspaceBackend {
    if (attempt < 2) return backend;
    return {
      ...backend,
      remoteDirectory: joinRemote(
        backend.remoteProjectRoot,
        remoteBranchPathSegment(backend.branchName || 'branch', attempt)
      ),
    };
  }

  private buildLazySetupCommand(backend: SshWorkspaceBackend, companionPath?: string): string {
    const branchName = backend.branchName;
    const startPoint = backend.startPoint || backend.baseBranch || 'HEAD';
    const originStartPoint = startPoint
      .replace(/^refs\/remotes\/origin\//, '')
      .replace(/^origin\//, '');
    const startsFromTarget = startsFromTargetBranch(backend);
    const needsRemoteDefaultStartPoint =
      !backend.checkoutExistingBranch && !backend.baseBranch && startPoint === 'HEAD';
    const remoteProjectRepoRoot = ['.git', 'repo.git'].includes(
      pathPosix.basename(backend.remoteRepoPath)
    )
      ? pathPosix.dirname(backend.remoteRepoPath)
      : `${backend.remoteRepoPath}.komla`;
    // The bare repo lives at .git, where Codex trusts the whole project at once. Workspaces
    // name it repo.git, a link to .git, so every device and Komla version agrees on its path.
    const movedRepoPath = joinRemote(remoteProjectRepoRoot, '.git');
    const isManagedLayout =
      pathPosix.basename(backend.remoteRepoPath) === 'repo.git' &&
      pathPosix.basename(pathPosix.dirname(remoteProjectRepoRoot)) === 'repos';
    const projectIdPath = joinRemote(remoteProjectRepoRoot, '.project-id');
    const projectNamePath = joinRemote(remoteProjectRepoRoot, '.project-name');
    const gitUrlPath = joinRemote(remoteProjectRepoRoot, '.git-url');
    const setupLockPath = joinRemote(remoteProjectRepoRoot, '.setup-lock');

    const lines = [
      'set -e',
      'if ! command -v git >/dev/null 2>&1; then',
      '  printf "\\033[31m[komla] git is not installed on this SSH host\\033[0m\\n" >&2',
      '  exit 127',
      'fi',
      'if [ -z "${GIT_SSH_COMMAND+x}" ] &&',
      '  [ -z "${GIT_SSH+x}" ] &&',
      `  ! git --git-dir=${shellQuotePosix(
        backend.remoteRepoPath
      )} config --get core.sshCommand >/dev/null 2>&1 &&`,
      '  command -v ssh >/dev/null 2>&1 &&',
      '  ssh -o StrictHostKeyChecking=accept-new -G localhost >/dev/null 2>&1; then',
      `  export GIT_SSH_COMMAND=${shellQuotePosix('ssh -o StrictHostKeyChecking=accept-new')}`,
      'fi',
      `if [ ! -d ${shellQuotePosix(backend.remoteRepoPath)} ] || [ ! -d ${shellQuotePosix(
        backend.remoteDirectory
      )} ]; then`,
      '  printf "\\033[2m[komla] preparing remote workspace\\033[0m\\n"',
      'fi',
      `mkdir -p ${shellQuotePosix(remoteProjectRepoRoot)} ${shellQuotePosix(
        backend.remoteProjectRoot
      )}`,
      `setup_lock=${shellQuotePosix(setupLockPath)}`,
      'setup_lock_attempt=0',
      'while ! mkdir "$setup_lock" 2>/dev/null; do',
      '  setup_lock_owner=$(cat "$setup_lock/pid" 2>/dev/null || true)',
      '  if [ -n "$setup_lock_owner" ] && ! kill -0 "$setup_lock_owner" 2>/dev/null; then',
      '    rm -rf "$setup_lock"',
      '    continue',
      '  fi',
      '  setup_lock_attempt=$((setup_lock_attempt + 1))',
      '  if [ "$setup_lock_attempt" -ge 120 ]; then',
      '    printf "[komla] timed out waiting for remote workspace setup lock\\n" >&2',
      '    exit 1',
      '  fi',
      '  sleep 1',
      'done',
      'printf "%s\\n" "$$" > "$setup_lock/pid"',
      'cleanup_setup_lock() {',
      '  setup_lock_owner=$(cat "$setup_lock/pid" 2>/dev/null || true)',
      '  if [ "$setup_lock_owner" = "$$" ]; then rm -rf "$setup_lock"; fi',
      '}',
      'trap cleanup_setup_lock 0',
      "trap 'exit 1' HUP INT TERM",
      `project_id=${shellQuotePosix(backend.projectId || '')}`,
      `git_url=${shellQuotePosix(backend.gitUrl)}`,
      // git would read a URL starting with "-" as an option. Refused here
      // rather than with `--`, which `git ls-remote` before 2.8 rejects.
      'case "$git_url" in -*)',
      '  printf "\\033[31m[komla] a Git URL can\'t start with \\"-\\"\\033[0m\\n" >&2',
      '  exit 1 ;;',
      'esac',
      `resolved_target=''`,
      'normalize_git_url() {',
      '  value=${1%/}',
      '  case "$value" in',
      '    *://*)',
      '      transport=${value%%://*}',
      '      remainder=${value#*://}',
      '      authority=${remainder%%/*}',
      '      if [ "$authority" = "$remainder" ]; then path=; else path=${remainder#*/}; fi',
      '      host=${authority##*@}',
      '      if [ "$authority" != "$host" ]; then user=${authority%@*}; else user=; fi',
      '      ;;',
      '    *:*)',
      '      transport=ssh',
      '      authority=${value%%:*}',
      '      case "$authority" in',
      '        */*) printf "%s\\n" "$value"; return ;;',
      '      esac',
      '      host=${authority##*@}',
      '      if [ "$authority" != "$host" ]; then user=${authority%@*}; else user=; fi',
      '      path=${value#*:}',
      '      ;;',
      '    *)',
      '      printf "%s\\n" "$value"',
      '      return',
      '      ;;',
      '  esac',
      '  host=$(printf "%s" "$host" | tr "[:upper:]" "[:lower:]")',
      '  path=${path#/}',
      '  path=${path%/}',
      '  host_specific_identity=',
      '  case "$host" in',
      '    github.com|gitlab.com|bitbucket.org)',
      '      case "$transport" in',
      '        http|https) host_specific_identity=1 ;;',
      '        ssh) [ "$user" = git ] && host_specific_identity=1 ;;',
      '      esac',
      '      ;;',
      '  esac',
      '  if [ -n "$host_specific_identity" ]; then',
      '    path=${path%.git}',
      '    printf "%s/%s\\n" "$host" "$path"',
      '  else',
      '    if [ -n "$user" ]; then authority="$user@$host"; else authority=$host; fi',
      '    printf "%s://%s/%s\\n" "$transport" "$authority" "$path"',
      '  fi',
      '}',
      `project_id_path=${shellQuotePosix(projectIdPath)}`,
      `project_name_path=${shellQuotePosix(projectNamePath)}`,
      `git_url_path=${shellQuotePosix(gitUrlPath)}`,
      'origin_url_changed=',
      ...(isManagedLayout
        ? [
            `if [ -d ${shellQuotePosix(movedRepoPath)} ] && [ ! -e ${shellQuotePosix(
              backend.remoteRepoPath
            )} ] && [ ! -L ${shellQuotePosix(backend.remoteRepoPath)} ]; then`,
            `  ln -s .git ${shellQuotePosix(backend.remoteRepoPath)}`,
            'fi',
          ]
        : []),
      `if [ ! -d ${shellQuotePosix(backend.remoteRepoPath)} ]; then`,
      '  printf "\\033[2m[komla] cloning remote bare repo\\033[0m\\n"',
      `  git clone --bare -- ${shellQuotePosix(backend.gitUrl)} ${shellQuotePosix(
        backend.remoteRepoPath
      )}`,
      'else',
      `  existing_git_url=$(git -C ${shellQuotePosix(
        backend.remoteRepoPath
      )} config --get remote.origin.url 2>/dev/null || true)`,
      '  if [ -z "$existing_git_url" ]; then',
      '    printf "\\033[31m[komla] existing remote project repository has no origin URL\\033[0m\\n" >&2',
      `    printf "path: %s\\n" ${shellQuotePosix(remoteProjectRepoRoot)} >&2`,
      '    exit 1',
      '  fi',
      '  existing_git_identity=$(normalize_git_url "$existing_git_url")',
      '  git_url_identity=$(normalize_git_url "$git_url")',
      '  if [ "$existing_git_identity" != "$git_url_identity" ]; then',
      `    printf "\\033[31m[komla] remote project name collides with a different Git repo\\033[0m\\n" >&2`,
      `    printf "path: %s\\n" ${shellQuotePosix(remoteProjectRepoRoot)} >&2`,
      '    exit 1',
      '  fi',
      '  if [ "$existing_git_url" != "$git_url" ]; then',
      `    if ! git -C ${shellQuotePosix(backend.remoteRepoPath)} ls-remote "$git_url" >/dev/null; then`,
      '      printf "\\033[31m[komla] could not access the requested Git transport\\033[0m\\n" >&2',
      '      exit 1',
      '    fi',
      `    git -C ${shellQuotePosix(backend.remoteRepoPath)} config remote.origin.url "$git_url"`,
      '    origin_url_changed=1',
      '  fi',
      'fi',
      ...(isManagedLayout
        ? [
            `if [ -d ${shellQuotePosix(backend.remoteRepoPath)} ] && [ ! -L ${shellQuotePosix(
              backend.remoteRepoPath
            )} ] && [ ! -e ${shellQuotePosix(movedRepoPath)} ] &&`,
            `  mv ${shellQuotePosix(backend.remoteRepoPath)} ${shellQuotePosix(movedRepoPath)}; then`,
            `  if ln -s .git ${shellQuotePosix(backend.remoteRepoPath)}; then`,
            `    git -C ${shellQuotePosix(movedRepoPath)} worktree repair >/dev/null 2>&1 || true`,
            '  else',
            `    mv ${shellQuotePosix(movedRepoPath)} ${shellQuotePosix(backend.remoteRepoPath)}`,
            '  fi',
            'fi',
          ]
        : []),
      'if [ -n "$project_id" ]; then printf "%s\\n" "$project_id" > "$project_id_path"; fi',
      `printf "%s\\n" ${shellQuotePosix(backend.projectName || 'project')} > "$project_name_path"`,
      'printf "%s\\n" "$git_url" > "$git_url_path"',
      `git -C ${shellQuotePosix(
        backend.remoteRepoPath
      )} config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'`,
      `if [ ! -d ${shellQuotePosix(backend.remoteDirectory)} ]; then`,
      `  if ! git -C ${shellQuotePosix(backend.remoteRepoPath)} fetch origin --prune; then`,
      '    if [ -n "$origin_url_changed" ]; then',
      `      git -C ${shellQuotePosix(backend.remoteRepoPath)} config remote.origin.url "$existing_git_url"`,
      '    fi',
      '    exit 1',
      '  fi',
      // A worktree directory removed by hand stays registered and keeps its branch checked out.
      `  git -C ${shellQuotePosix(backend.remoteRepoPath)} worktree prune || true`,
      'fi',
      ...(needsRemoteDefaultStartPoint
        ? [
            `resolved_target=$(git -C ${shellQuotePosix(
              backend.remoteRepoPath
            )} ls-remote --symref origin HEAD 2>/dev/null | sed -n 's#^ref: refs/heads/\\(.*\\)[[:space:]]HEAD$#\\1#p' | head -n 1)`,
            `resolved_ref="refs/remotes/origin/$resolved_target"`,
            `if [ ! -d ${shellQuotePosix(
              backend.remoteDirectory
            )} ] && { [ -z "$resolved_target" ] || ! git -C ${shellQuotePosix(
              backend.remoteRepoPath
            )} rev-parse --verify "$resolved_ref^{commit}" >/dev/null 2>&1; }; then`,
            '  printf "\\033[31m[komla] could not determine the remote default branch; configure a target branch and try again\\033[0m\\n" >&2',
            '  exit 1',
            'fi',
          ]
        : []),
      `if [ ! -d ${shellQuotePosix(backend.remoteDirectory)} ]; then`,
      ...(backend.checkoutExistingBranch
        ? []
        : [
            needsRemoteDefaultStartPoint
              ? '  start_ref="$resolved_ref"'
              : `  start_ref=${shellQuotePosix(startPoint)}`,
            ...(startsFromTarget
              ? [
                  // The companion applies the same rule as the behind count and also
                  // fast-forwards a stale local target; the shell check covers hosts without it.
                  ...(companionPath
                    ? [
                        `  if synced_ref=$(${shellQuotePosix(companionPath)} git target sync -C ${shellQuotePosix(backend.remoteRepoPath)} --target ${shellQuotePosix(startPoint)} 2>/dev/null) && [ -n "$synced_ref" ]; then`,
                        '    start_ref="$synced_ref"',
                        `  elif git -C ${shellQuotePosix(backend.remoteRepoPath)} rev-parse --verify ${shellQuotePosix(`origin/${startPoint}`)} >/dev/null 2>&1; then`,
                      ]
                    : [
                        `  if git -C ${shellQuotePosix(backend.remoteRepoPath)} rev-parse --verify ${shellQuotePosix(`origin/${startPoint}`)} >/dev/null 2>&1; then`,
                      ]),
                  `    if ! git -C ${shellQuotePosix(backend.remoteRepoPath)} rev-parse --verify ${shellQuotePosix(startPoint)} >/dev/null 2>&1 || git -C ${shellQuotePosix(backend.remoteRepoPath)} merge-base --is-ancestor ${shellQuotePosix(startPoint)} ${shellQuotePosix(`origin/${startPoint}`)}; then`,
                  `      start_ref=${shellQuotePosix(`origin/${startPoint}`)}`,
                  '    fi',
                  '  fi',
                ]
              : []),
            `  if ! git -C ${shellQuotePosix(backend.remoteRepoPath)} cat-file -e "$start_ref^{commit}"; then`,
            `    origin_start_ref=${shellQuotePosix(`refs/remotes/origin/${originStartPoint}`)}`,
            `    if git -C ${shellQuotePosix(backend.remoteRepoPath)} cat-file -e "$origin_start_ref^{commit}"; then`,
            '      start_ref="$origin_start_ref"',
            '    else',
            `      printf "\\033[31m[komla] selected starting revision is not available on the SSH host or origin\\033[0m\\n" >&2`,
            '      exit 1',
            '    fi',
            '  fi',
          ]),
    ];

    if (branchName && backend.checkoutExistingBranch) {
      lines.push(
        '  printf "\\033[2m[komla] checking out existing remote branch\\033[0m\\n"',
        `  local_branch=${shellQuotePosix(`refs/heads/${branchName}`)}`,
        `  origin_branch=${shellQuotePosix(`refs/remotes/origin/${branchName}`)}`,
        `  if git -C ${shellQuotePosix(backend.remoteRepoPath)} show-ref --verify --quiet "$local_branch"; then`,
        `    git -C ${shellQuotePosix(backend.remoteRepoPath)} worktree add ${shellQuotePosix(
          backend.remoteDirectory
        )} ${shellQuotePosix(branchName)}`,
        // Git refuses the checkout while another worktree has the branch checked out, rebasing
        // or bisecting it, so fast-forwarding it inside the new worktree is safe.
        `    if git -C ${shellQuotePosix(backend.remoteRepoPath)} show-ref --verify --quiet "$origin_branch"; then git -C ${shellQuotePosix(backend.remoteDirectory)} merge --ff-only "$origin_branch" >/dev/null 2>&1 || true; fi`,
        `  elif git -C ${shellQuotePosix(backend.remoteRepoPath)} show-ref --verify --quiet "$origin_branch"; then`,
        `    git -C ${shellQuotePosix(backend.remoteRepoPath)} worktree add -b ${shellQuotePosix(
          branchName
        )} ${shellQuotePosix(backend.remoteDirectory)} ${shellQuotePosix(`origin/${branchName}`)}`,
        `    printf "%s\\n" ${shellQuotePosix(SSH_WORKSPACE_BRANCH_CREATED_MARKER)}`,
        '  else',
        '    printf "\\033[31m[komla] selected branch is not available on the SSH host; push it to origin and try again\\033[0m\\n" >&2',
        '    exit 1',
        '  fi',
        `  if git -C ${shellQuotePosix(backend.remoteRepoPath)} show-ref --verify --quiet "$origin_branch"; then`,
        `    git -C ${shellQuotePosix(backend.remoteDirectory)} branch --set-upstream-to=${shellQuotePosix(
          `origin/${branchName}`
        )} ${shellQuotePosix(branchName)}`,
        '  fi',
        `  printf "%s\\n" ${shellQuotePosix(SSH_WORKSPACE_WORKTREE_CREATED_MARKER)}`
      );
    } else if (branchName) {
      lines.push(
        '  printf "\\033[2m[komla] creating remote worktree\\033[0m\\n"',
        `  if git -C ${shellQuotePosix(
          backend.remoteRepoPath
        )} show-ref --verify --quiet ${shellQuotePosix(`refs/heads/${branchName}`)}; then`,
        `    printf "%s\\n" ${shellQuotePosix(SSH_BRANCH_ALREADY_EXISTS_MARKER)} >&2`,
        '    exit 1',
        '  fi',
        `  if ! worktree_output=$(git -C ${shellQuotePosix(
          backend.remoteRepoPath
        )} worktree add --no-track -b ${shellQuotePosix(
          branchName
        )} ${shellQuotePosix(backend.remoteDirectory)} "$start_ref" 2>&1); then`,
        '    printf "%s\\n" "$worktree_output" >&2',
        `    if git -C ${shellQuotePosix(
          backend.remoteRepoPath
        )} show-ref --verify --quiet ${shellQuotePosix(`refs/heads/${branchName}`)}; then`,
        `      printf "%s\\n" ${shellQuotePosix(SSH_BRANCH_ALREADY_EXISTS_MARKER)} >&2`,
        '    fi',
        '    exit 1',
        '  fi',
        `  printf "%s\\n" ${shellQuotePosix(SSH_WORKSPACE_BRANCH_CREATED_MARKER)}`,
        `  printf "%s\\n" ${shellQuotePosix(SSH_WORKSPACE_WORKTREE_CREATED_MARKER)}`
      );
    } else {
      lines.push(
        '  printf "\\033[31m[komla] this SSH workspace is missing branch metadata; cannot create the remote worktree\\033[0m\\n" >&2',
        '  exit 1'
      );
    }

    lines.push('fi');
    lines.push(
      'if [ -n "$resolved_target" ]; then',
      `  printf "%s%s\\n" ${shellQuotePosix(SSH_WORKSPACE_TARGET_MARKER)} "$resolved_target"`,
      'fi'
    );
    lines.push(
      `existing_branch=$(git -C ${shellQuotePosix(
        backend.remoteDirectory
      )} symbolic-ref --quiet --short HEAD 2>/dev/null || true)`,
      `if [ "$existing_branch" != ${shellQuotePosix(branchName || '')} ]; then`,
      `  printf "%s\\n" ${shellQuotePosix(SSH_WORKTREE_PATH_CONFLICT_MARKER)} >&2`,
      '  printf "\\033[31m[komla] remote worktree path belongs to a different branch\\033[0m\\n" >&2',
      `  printf "path: %s\\n" ${shellQuotePosix(backend.remoteDirectory)} >&2`,
      '  printf "expected branch: %s\\n" ' + shellQuotePosix(branchName || '') + ' >&2',
      '  printf "actual branch: %s\\n" "$existing_branch" >&2',
      '  exit 1',
      'fi',
      'cleanup_setup_lock',
      'trap - 0 HUP INT TERM',
      `cd ${shellQuotePosix(backend.remoteDirectory)}`
    );
    return lines.join('\n');
  }

  /**
   * With `allowBranchToRemain`, a branch Git refuses to delete (say, one checked out in another
   * worktree) is logged instead of failing the delete, since the worktree is already gone.
   */
  async deleteWorkspace(
    backend: SshWorkspaceBackend,
    deleteBranch?: boolean,
    branchName?: string,
    deleteOptions: { allowBranchToRemain?: boolean } = {}
  ) {
    const host = this.getHost(backend.hostId);
    const options: SshRunOptions = { purpose: { kind: 'interactive' } };
    const basePath = await this.resolveRemoteBasePath(host, options);
    const isManagedPath =
      backend.remoteDirectory.startsWith(`${basePath}/worktrees/`) &&
      backend.remoteRepoPath.startsWith(`${basePath}/repos/`);
    if (!isManagedPath) {
      throw new Error(`Refusing to delete remote workspace outside ${basePath}`);
    }

    const remoteDirectory = shellQuotePosix(backend.remoteDirectory);
    const remoteRepoPath = shellQuotePosix(backend.remoteRepoPath);
    const deleteBranchCommands =
      deleteBranch && branchName
        ? [
            `if [ -d ${remoteRepoPath} ] && git -C ${remoteRepoPath} show-ref --verify --quiet ${shellQuotePosix(
              `refs/heads/${branchName}`
            )}; then`,
            `  git -C ${remoteRepoPath} branch -D ${shellQuotePosix(branchName)}`,
            'fi',
            `if [ -d ${remoteRepoPath} ] && git -C ${remoteRepoPath} show-ref --verify --quiet ${shellQuotePosix(
              `refs/heads/${branchName}`
            )}; then`,
            `  printf '%s\\n' ${shellQuotePosix(SSH_BRANCH_DELETE_FAILED_MESSAGE)} >&2`,
            '  exit 1',
            'fi',
          ]
        : [':'];
    const deleting = this.run(
      host,
      [
        `if [ -d ${remoteDirectory} ]; then`,
        `  if [ -d ${remoteRepoPath} ]; then`,
        `    git -C ${remoteRepoPath} worktree remove --force ${remoteDirectory} || true`,
        '  fi',
        `  rm -rf -- ${remoteDirectory}`,
        'fi',
        `if [ -e ${remoteDirectory} ]; then`,
        '  printf "[komla] failed to delete remote workspace directory\\n" >&2',
        '  exit 1',
        'fi',
        `if [ -d ${remoteRepoPath} ]; then`,
        `  git -C ${remoteRepoPath} worktree prune || { printf "[komla] failed to prune remote worktree metadata\\n" >&2; exit 1; }`,
        'fi',
        ...deleteBranchCommands,
      ].join('\n'),
      options
    );
    try {
      await deleting;
    } catch (error) {
      const branchRemained = `${getErrorStderr(error)}\n${String(error)}`.includes(
        SSH_BRANCH_DELETE_FAILED_MESSAGE
      );
      if (!deleteOptions.allowBranchToRemain || !branchRemained) throw error;
      logger.warn('Deleted remote workspace but Git kept its branch', { branchName, error });
    }
  }

  private async killAllTerminalSessions(host: SshHost): Promise<void> {
    await this.run(
      host,
      [
        `tmux -L ${TMUX_SOCKET_NAME} kill-server >/dev/null 2>&1 || true`,
        `if tmux -L ${TMUX_SOCKET_NAME} has-session 2>/dev/null; then`,
        '  printf "[komla] failed to stop all managed remote terminal sessions\\n" >&2',
        '  exit 1',
        'fi',
      ].join('\n')
    );
  }

  private async deleteRemoteDataDirectory(host: SshHost): Promise<void> {
    const basePath = await this.resolveRemoteBasePath(host);
    const home = await this.resolveRemoteHome(host);
    const markerPath = joinRemote(basePath, SSH_DATA_MARKER_FILE);
    await this.run(
      host,
      [
        `base=${shellQuotePosix(basePath)}`,
        `home=${shellQuotePosix(home)}`,
        '[ ! -e "$base" ] && exit 0',
        'if [ ! -d "$base" ] || [ -L "$base" ]; then',
        '  printf "[komla] refusing to delete a non-directory or symlinked remote data path\\n" >&2',
        '  exit 1',
        'fi',
        'base_real=$(cd -P "$base" && pwd -P) || exit 1',
        'home_real=$(cd -P "$home" && pwd -P) || exit 1',
        'if [ -z "$base_real" ] || [ "$base_real" = / ] || [ "$base_real" = "$home_real" ]; then',
        '  printf "[komla] refusing to delete an unsafe remote data path\\n" >&2',
        '  exit 1',
        'fi',
        `marker=${shellQuotePosix(markerPath)}`,
        'if [ -e "$marker" ]; then',
        `  if [ -L "$marker" ] || [ ! -f "$marker" ] || [ "$(cat "$marker")" != ${shellQuotePosix(
          SSH_DATA_MARKER_CONTENT
        )} ]; then`,
        '    printf "[komla] remote data ownership marker is invalid\\n" >&2',
        '    exit 1',
        '  fi',
        'fi',
        'managed_layout=false',
        'for entry in "$base"/* "$base"/.[!.]* "$base"/..?*; do',
        '  if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi',
        '  case "${entry##*/}" in',
        '    repos|worktrees|helpers|workspaces) managed_layout=true ;;',
        `    ${SSH_DATA_MARKER_FILE}) ;;`,
        '    *)',
        '      printf "[komla] refusing to delete remote data containing unrecognized files: %s\\n" "$entry" >&2',
        '      exit 1',
        '      ;;',
        '  esac',
        'done',
        'if [ ! -e "$marker" ] && [ "$managed_layout" != true ]; then',
        '  exit 0',
        'fi',
        'rm -rf -- "$base_real"',
        'if [ -e "$base_real" ]; then',
        '  printf "[komla] failed to delete the remote Komla data directory\\n" >&2',
        '  exit 1',
        'fi',
      ].join('\n')
    );
  }

  async killTerminalSessions(backend: SshWorkspaceBackend, terminalIds: string[]): Promise<void> {
    if (terminalIds.length === 0) return;
    const host = this.getHost(backend.hostId);
    const targets = terminalIds.map(tmuxExactTarget);
    await this.run(
      host,
      [
        ...targets.map(
          (target) =>
            `if tmux -L ${TMUX_SOCKET_NAME} has-session -t ${target} 2>/dev/null; then tmux -L ${TMUX_SOCKET_NAME} kill-session -t ${target}; fi`
        ),
        ...targets.map(
          (target) =>
            `if tmux -L ${TMUX_SOCKET_NAME} has-session -t ${target} 2>/dev/null; then printf "[komla] failed to stop managed remote terminal session\\n" >&2; exit 1; fi`
        ),
      ].join('\n'),
      { purpose: { kind: 'interactive' } }
    );
  }

  async findTerminalSessions(
    backend: SshWorkspaceBackend,
    terminalIds: string[],
    { background = false }: { background?: boolean } = {}
  ): Promise<Set<string>> {
    if (terminalIds.length === 0) return new Set();
    const host = this.getHost(backend.hostId);
    const output = await this.run(
      host,
      terminalIds
        .map(
          (terminalId) =>
            `if tmux -L ${TMUX_SOCKET_NAME} has-session -t ${tmuxExactTarget(terminalId)} 2>/dev/null; then printf '%s\\n' ${shellQuotePosix(terminalId)}; fi`
        )
        .join('\n'),
      { purpose: { kind: background ? 'background' : 'interactive' } }
    );
    const expected = new Set(terminalIds);
    return new Set(
      output
        .split('\n')
        .map((line) => line.trim())
        .filter((terminalId) => expected.has(terminalId))
    );
  }

  /**
   * Shows a terminal's newest match for `query` in its tmux history, where Komla's search bar
   * then steps with MANAGED_TMUX_FIND_INPUTS. A full-screen program keeps no tmux history and
   * would freeze in scroll mode, so its pane is left alone for the bar to search the screen.
   */
  async findInTerminalSession(
    backend: SshWorkspaceBackend,
    terminalId: string,
    query: string
  ): Promise<ManagedTmuxFindResult> {
    const host = this.getHost(backend.hostId);
    // A pane target can't take the exact-match prefix alone, so it names the session's window.
    const target = shellQuotePosix(`=${managedTmuxSessionName(terminalId)}:`);
    // tmux reads an argument ending in `;` as the end of a command.
    const text = shellQuotePosix(query.replace(/;$/, '\\;'));
    const find = [
      `tmux -L ${TMUX_SOCKET_NAME} copy-mode -e -t ${target}`,
      `send-keys -t ${target} -X history-bottom`,
      `send-keys -t ${target} -X "$search" ${text}`,
      `set-option -w -t ${target} @komla_find older`,
      `set-option -w -t ${target} @komla_find_query ${text}`,
      `display-message -p -t ${target} '#{search_present} #{search_count}'`,
    ].join(' \\; ');
    const output = await this.run(
      host,
      [
        `pane="$(tmux -L ${TMUX_SOCKET_NAME} display-message -p -t ${target} '#{alternate_on} #{version}')"`,
        // tmux 3.1 made search-backward a regular expression search and added the plain one.
        // The running server decides, since an upgrade leaves it older than the tmux binary.
        'case "$pane" in',
        "  *' '[012].*|*' 3.0'*) search=search-backward ;;",
        '  *) search=search-backward-text ;;',
        'esac',
        'if [ "${pane%% *}" = 1 ]; then',
        '  printf "alternate\\n"',
        'else',
        `  ${find}`,
        'fi',
      ].join('\n'),
      { purpose: { kind: 'interactive' } }
    );
    if (output.trim() === 'alternate') return { found: null, count: null, alternateScreen: true };
    // search_present arrived in tmux 3.2 and search_count in 3.5; older ones print nothing.
    const [present, count] = output.trim().split(/\s+/);
    const found = present === '1' ? true : present === '0' ? false : null;
    return {
      found,
      count: found === false ? 0 : count && /^\d+$/.test(count) ? Number(count) : null,
      alternateScreen: false,
    };
  }

  /** Tells the other devices showing a tab that its agent was interrupted on this one. */
  async relayInterrupt(
    backend: SshWorkspaceBackend,
    companion: { executable: string; hookInbox: string },
    terminalId: string,
    sources: string[]
  ): Promise<void> {
    const host = this.getHost(backend.hostId);
    await this.run(
      host,
      [companion.executable, '__relay-interrupt', companion.hookInbox, terminalId, ...sources]
        .map(shellQuotePosix)
        .join(' '),
      { purpose: { kind: 'background' } }
    );
  }

  async supportsPersistentTerminalSessions(backend: SshWorkspaceBackend): Promise<boolean> {
    const host = this.getHost(backend.hostId);
    return (await this.getCachedRemoteTmuxStatus(host)).status === 'available';
  }

  buildTerminalLaunchCommand(
    backend: SshWorkspaceBackend,
    command: string | null,
    terminalId: string,
    workspaceId: string | undefined,
    action: SshTerminalSessionAction,
    options: SshTerminalLaunchOptions = {}
  ): SshTerminalLaunchCommand {
    const host = this.getHost(backend.hostId);
    const dataPort = remoteKomlaDataPort(backend.hostId);
    const remoteBasePath = pathPosix.dirname(pathPosix.dirname(backend.remoteProjectRoot));
    const terminalEnvironment = {
      KOMLA_NOTIFY_HOST: '127.0.0.1',
      KOMLA_NOTIFY_PORT: dataPort,
      KOMLA_MCP_PORT: dataPort,
      KOMLA_API_URL: buildTerminalApiUrl(`http://127.0.0.1:${dataPort}`, terminalId),
      KOMLA_CLI: joinRemote(remoteBasePath, 'helpers', 'komla'),
      KOMLA_NOTIFY_SCRIPT: joinRemote(remoteBasePath, 'helpers', 'notify.sh'),
      KOMLA_COMPANION_INBOX: options.companion?.hookInbox,
      KOMLA_INSTALLATION_KEY: options.companion?.installationKey,
      KOMLA_COMPANION_SESSION: options.companion?.sessionName,
      KOMLA_COMPANION_TMUX_SOCKET: options.companion?.tmuxSocket,
      KOMLA_TERMINAL_ID: terminalId,
      KOMLA_WORKSPACE_ID: workspaceId,
      KOMLA_REMOTE_WORKSPACE_DIR: backend.remoteDirectory,
      KOMLA_TARGET_BRANCH: backend.baseBranch || 'main',
      COLORTERM: 'truecolor',
      FORCE_HYPERLINK: '1',
    };
    const creationCommand = remoteTerminalCreationCommand(
      backend,
      terminalEnvironment,
      terminalId,
      command,
      action === 'reconnect' ? 'start' : action,
      options.keepShellOpenAfterCommand ?? false,
      action === 'reconnect'
    );
    const remoteCommand =
      action === 'reconnect'
        ? [
            `if tmux -L ${TMUX_SOCKET_NAME} has-session -t ${tmuxExactTarget(terminalId)} 2>/dev/null; then`,
            ...reattachRemoteTerminalSessionCommands(terminalEnvironment, terminalId).map(
              (line) => `  ${line}`
            ),
            `  ${REMOTE_READY_SHELL_COMMAND}`,
            `  ${TMUX_ATTACH} ${tmuxExactTarget(terminalId)} && exit 0`,
            'fi',
            'printf "\\033[33m[komla] saved managed remote terminal session ended; starting a new shell\\033[0m\\n"',
            creationCommand,
          ].join('\n')
        : creationCommand;
    return {
      startupMode: 'wait-for-marker',
      localLoginShell: sshConnectionService.forwardsAgent(host),
      command: sshConnectionService.buildTerminalCommand(
        host,
        terminalId,
        remoteCommand,
        action === 'reconnect'
      ),
    };
  }

  buildTerminalCommand(
    backend: SshWorkspaceBackend,
    command: string | null,
    terminalId: string,
    workspaceId: string | undefined,
    action: SshTerminalSessionAction,
    options: { keepShellOpenAfterCommand?: boolean } = {}
  ): string {
    return this.buildTerminalLaunchCommand(
      backend,
      command,
      terminalId,
      workspaceId,
      action,
      options
    ).command;
  }
}

export const sshWorkspaceService = new SshWorkspaceService();
