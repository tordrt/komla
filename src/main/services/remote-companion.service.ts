import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, posix as pathPosix } from 'path';

import { shellQuotePosix } from '../../shared/lib/shell-quote';
import { MANAGED_TMUX_SOCKET_NAME } from '../../shared/lib/ssh-tmux-attach';
import {
  getKomlaArtifactRoot,
  resolveKomlaBinaryTarget,
  type KomlaBinaryTarget,
} from '../lib/komla-cli';
import { createLogger } from '../lib/logger';

import { sshWorkspaceService } from './ssh-workspace.service';

import type { SshHost } from '../../shared/types';

const logger = createLogger('RemoteCompanionService');
const REMOTE_COMPANION_PROTOCOL_VERSION = 1;
const REMOTE_COMPANION_VALIDATION_INTERVAL_MS = 30_000;
// The start command's exit code when it could not write the new config, before it touched the
// running companion.
const CONFIG_NOT_WRITTEN_EXIT_CODE = 3;

export type RemoteCompanionTarget = Exclude<
  KomlaBinaryTarget,
  'x86_64-pc-windows-msvc' | 'aarch64-pc-windows-msvc'
>;

export function resolveRemoteCompanionTarget(
  operatingSystem: string,
  architecture: string
): RemoteCompanionTarget | undefined {
  const target = resolveKomlaBinaryTarget(operatingSystem, architecture);
  if (target === 'x86_64-pc-windows-msvc' || target === 'aarch64-pc-windows-msvc') {
    return undefined;
  }
  return target;
}

export interface RemoteCompanionServiceDependencies {
  resourceRoot: () => string;
  run: (host: SshHost, command: string) => Promise<string>;
  upload: (host: SshHost, command: string, sourcePath: string) => Promise<string>;
  /** Learns of the executable on a host each time a caller finds or installs it. */
  installed?: (host: SshHost, executable: string) => void;
}

export interface MonitoredRemoteWorkspace {
  workspaceId: string;
  workingTree: string;
  targetBranch: string;
}

export interface StartRemoteCompanionOptions {
  remoteBasePath: string;
  endpoint: string;
  installationId: string;
  workspaces: MonitoredRemoteWorkspace[];
}

export interface RemoteCompanionRuntime {
  installationKey: string;
  tmuxSocket: string;
  sessionName: string;
  hookInbox: string;
}

export function resolveRemoteCompanionRuntime(
  remoteBasePath: string,
  installationId: string
): RemoteCompanionRuntime {
  const installationKey = createHash('sha256').update(installationId).digest('hex').slice(0, 16);
  const remoteConfigDirectory = pathPosix.join(
    remoteBasePath,
    'helpers',
    'companion',
    installationKey
  );
  return {
    installationKey,
    tmuxSocket: `komla-companion-${installationKey}`,
    sessionName: `komla-companion-${installationKey}`,
    hookInbox: pathPosix.join(remoteConfigDirectory, 'inbox'),
  };
}

interface QueuedRemoteCompanionConfiguration {
  host: SshHost;
  options: StartRemoteCompanionOptions;
  signature: string;
  promise: Promise<RemoteCompanionRuntime>;
  resolve: (runtime: RemoteCompanionRuntime) => void;
  reject: (error: unknown) => void;
}

interface RemoteCompanionConfigurationState {
  active?: { signature: string; promise: Promise<RemoteCompanionRuntime> };
  queued?: QueuedRemoteCompanionConfiguration;
}

function preparedKey(host: SshHost, remoteBasePath: string): string {
  return JSON.stringify([host.id, host.hostname, host.user, host.port, remoteBasePath]);
}

function hostKey(host: SshHost): string {
  return JSON.stringify([host.id, host.hostname, host.user, host.port]);
}

export class RemoteCompanionService {
  private readonly prepared = new Map<string, Promise<string>>();
  private readonly platforms = new Map<string, Promise<string[]>>();
  private readonly configurations = new Map<string, RemoteCompanionConfigurationState>();
  private readonly runningConfigurations = new Map<
    string,
    { signature: string; runtime: RemoteCompanionRuntime; validatedAt: number }
  >();

  constructor(private readonly dependencies: RemoteCompanionServiceDependencies) {}

  async ensureInstalled(host: SshHost, remoteBasePath: string): Promise<string> {
    const executable = await this.prepare(host, remoteBasePath);
    this.dependencies.installed?.(host, executable);
    return executable;
  }

  private async prepare(host: SshHost, remoteBasePath: string): Promise<string> {
    const key = preparedKey(host, remoteBasePath);
    const existing = this.prepared.get(key);
    if (existing) {
      try {
        return await existing;
      } catch (error) {
        if (this.prepared.get(key) === existing) this.prepared.delete(key);
        throw error;
      }
    }
    const promise = this.install(host, remoteBasePath).catch((error) => {
      if (this.prepared.get(key) === promise) this.prepared.delete(key);
      throw error;
    });
    this.prepared.set(key, promise);
    return promise;
  }

  /** The host's `uname -s` and `uname -m`. Starting it early takes it off the install's path. */
  detectPlatform(host: SshHost): Promise<string[]> {
    const key = hostKey(host);
    const existing = this.platforms.get(key);
    if (existing) return existing;
    const promise = this.dependencies
      .run(host, 'printf "%s\\n" "$(uname -s)" "$(uname -m)"')
      .then((output) => output.trim().split(/\r?\n/));
    this.platforms.set(key, promise);
    void promise.catch(() => {
      if (this.platforms.get(key) === promise) this.platforms.delete(key);
    });
    return promise;
  }

  /** The executable this session installed or found on a host, without installing one. */
  installedPath(host: SshHost, remoteBasePath: string): Promise<string> | undefined {
    return this.prepared.get(preparedKey(host, remoteBasePath));
  }

  invalidateHost(hostId: string): void {
    const belongsToHost = (key: string): boolean => {
      try {
        return (JSON.parse(key) as unknown[])[0] === hostId;
      } catch {
        return false;
      }
    };
    for (const key of this.prepared.keys()) {
      if (belongsToHost(key)) this.prepared.delete(key);
    }
    for (const key of this.platforms.keys()) {
      if (belongsToHost(key)) this.platforms.delete(key);
    }
    for (const key of this.runningConfigurations.keys()) {
      if (belongsToHost(key)) this.runningConfigurations.delete(key);
    }
  }

  ensureRunning(
    host: SshHost,
    options: StartRemoteCompanionOptions
  ): Promise<RemoteCompanionRuntime | undefined> {
    if (options.workspaces.length === 0) return Promise.resolve(undefined);
    const key = hostKey(host);
    const signature = JSON.stringify({
      ...options,
      workspaces: [...options.workspaces].sort((left, right) =>
        left.workspaceId.localeCompare(right.workspaceId)
      ),
    });
    let configuration = this.configurations.get(key);
    if (configuration?.active?.signature === signature) {
      const active = configuration.active;
      const superseded = configuration.queued;
      configuration.queued = undefined;
      if (superseded) void active.promise.then(superseded.resolve, superseded.reject);
      return active.promise;
    }
    if (configuration?.active) {
      if (configuration.queued) {
        configuration.queued.host = host;
        configuration.queued.options = options;
        configuration.queued.signature = signature;
        return configuration.queued.promise;
      }
      let resolve!: (runtime: RemoteCompanionRuntime) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<RemoteCompanionRuntime>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      configuration.queued = { host, options, signature, promise, resolve, reject };
      return promise;
    }
    const running = this.runningConfigurations.get(key);
    if (
      running?.signature === signature &&
      Date.now() - running.validatedAt < REMOTE_COMPANION_VALIDATION_INTERVAL_MS
    ) {
      return Promise.resolve(running.runtime);
    }
    configuration = {};
    this.configurations.set(key, configuration);
    return this.startConfiguration(key, configuration, host, options, signature);
  }

  private startConfiguration(
    key: string,
    configuration: RemoteCompanionConfigurationState,
    host: SshHost,
    options: StartRemoteCompanionOptions,
    signature: string
  ): Promise<RemoteCompanionRuntime> {
    const operation = this.configureRunning(host, options)
      .then((runtime) => {
        this.runningConfigurations.set(key, { signature, runtime, validatedAt: Date.now() });
        return runtime;
      })
      .catch((error) => {
        this.invalidateHost(host.id);
        throw error;
      });
    configuration.active = { signature, promise: operation };
    void operation.then(
      () => this.finishConfiguration(key, configuration, operation),
      () => this.finishConfiguration(key, configuration, operation)
    );
    return operation;
  }

  private finishConfiguration(
    key: string,
    configuration: RemoteCompanionConfigurationState,
    operation: Promise<RemoteCompanionRuntime>
  ): void {
    if (configuration.active?.promise !== operation) return;
    configuration.active = undefined;
    const queued = configuration.queued;
    configuration.queued = undefined;
    if (!queued) {
      if (this.configurations.get(key) === configuration) this.configurations.delete(key);
      return;
    }
    const next = this.startConfiguration(
      key,
      configuration,
      queued.host,
      queued.options,
      queued.signature
    );
    void next.then(queued.resolve, queued.reject);
  }

  private async configureRunning(
    host: SshHost,
    options: StartRemoteCompanionOptions
  ): Promise<RemoteCompanionRuntime> {
    const binaryPath = await this.ensureInstalled(host, options.remoteBasePath);
    const runtime = resolveRemoteCompanionRuntime(options.remoteBasePath, options.installationId);
    const { installationKey, hookInbox, tmuxSocket, sessionName } = runtime;
    const remoteConfigDirectory = pathPosix.dirname(hookInbox);
    const config = {
      endpoint: options.endpoint,
      diagnostics: process.env.KOMLA_DIAGNOSTICS === '1',
      installationId: installationKey,
      tmuxSocket,
      managedTmuxSocket: MANAGED_TMUX_SOCKET_NAME,
      idleExitSeconds: 30,
      startupGraceSeconds: 180,
      hookInbox,
      workspaces: [...options.workspaces].sort((left, right) =>
        left.workspaceId.localeCompare(right.workspaceId)
      ),
    };
    const configJson = `${JSON.stringify(config, null, 2)}\n`;
    const configHash = createHash('sha256')
      .update(binaryPath)
      .update('\0')
      .update(configJson)
      .digest('hex');
    // A running companion with the same runtime reloads its workspace list in place, so
    // opening or closing a terminal does not resend every workspace as changed.
    const { workspaces: _workspaces, diagnostics: _diagnostics, ...runtimeConfig } = config;
    const runtimeHash = createHash('sha256')
      .update(binaryPath)
      .update('\0')
      .update(JSON.stringify(runtimeConfig))
      .digest('hex');
    const remoteConfigPath = pathPosix.join(remoteConfigDirectory, `${configHash}.json`);
    const currentConfigPointer = pathPosix.join(remoteConfigDirectory, 'current-config');
    const startCommand = `${shellQuotePosix(binaryPath)} __companion ${shellQuotePosix(remoteConfigPath)}`;
    const tempDirectory = mkdtempSync(join(tmpdir(), 'komla-companion-config-'));
    const localConfigPath = join(tempDirectory, 'config.json');
    try {
      writeFileSync(localConfigPath, configJson, { mode: 0o600 });
      // Writes the config and starts or reloads the companion in one round trip.
      await this.dependencies.upload(
        host,
        [
          'set -e',
          `session=${shellQuotePosix(sessionName)}`,
          `start_command=${shellQuotePosix(startCommand)}`,
          `config_hash=${shellQuotePosix(configHash)}`,
          `runtime_hash=${shellQuotePosix(runtimeHash)}`,
          `config_dir=${shellQuotePosix(remoteConfigDirectory)}`,
          `config_path=${shellQuotePosix(remoteConfigPath)}`,
          `pointer=${shellQuotePosix(currentConfigPointer)}`,
          `tmux_socket=${shellQuotePosix(tmuxSocket)}`,
          `not_written=${CONFIG_NOT_WRITTEN_EXIT_CODE}`,
          'mkdir -p "$config_dir" || exit "$not_written"',
          'umask 077',
          'temp_path=$(mktemp "$config_dir/.config.XXXXXX") || exit "$not_written"',
          'trap \'rm -f "$temp_path"\' EXIT HUP INT TERM',
          'cat > "$temp_path" || exit "$not_written"',
          'chmod 600 "$temp_path" || exit "$not_written"',
          'mv -f "$temp_path" "$config_path" || exit "$not_written"',
          'trap - EXIT HUP INT TERM',
          'pointer_temp=$(mktemp "$pointer.XXXXXX") || exit "$not_written"',
          'trap \'rm -f "$pointer_temp"\' EXIT HUP INT TERM',
          'printf \'%s\\n\' "$config_path" > "$pointer_temp" || exit "$not_written"',
          'mv -f "$pointer_temp" "$pointer" || exit "$not_written"',
          'trap - EXIT HUP INT TERM',
          // Companions read their config only at startup or on reload, both from the pointer.
          'for old_config in "$config_dir"/*.json; do',
          '  [ "$old_config" = "$config_path" ] || rm -f "$old_config"',
          'done',
          'if tmux -L "$tmux_socket" has-session -t "=$session" 2>/dev/null; then',
          '  current=$(tmux -L "$tmux_socket" show-options -qv -t "$session" @komla_config_hash)',
          '  current_runtime=$(tmux -L "$tmux_socket" show-options -qv -t "$session" @komla_runtime_hash)',
          '  if [ "$current" != "$config_hash" ] && [ "$current_runtime" != "$runtime_hash" ]; then',
          '    tmux -L "$tmux_socket" kill-session -t "=$session"',
          '  fi',
          'fi',
          'if ! tmux -L "$tmux_socket" has-session -t "=$session" 2>/dev/null; then',
          '  tmux -L "$tmux_socket" new-session -d -s "$session" "$start_command"',
          'fi',
          'tmux -L "$tmux_socket" set-option -t "$session" @komla_config_hash "$config_hash"',
          'tmux -L "$tmux_socket" set-option -t "$session" @komla_runtime_hash "$runtime_hash"',
        ].join('\n'),
        localConfigPath
      );
    } catch (error) {
      // The companion still runs on its old config.
      if ((error as { code?: unknown }).code === CONFIG_NOT_WRITTEN_EXIT_CODE) throw error;
      try {
        await this.dependencies.run(
          host,
          `tmux -L ${shellQuotePosix(tmuxSocket)} kill-session -t ${shellQuotePosix(`=${sessionName}`)} 2>/dev/null || true`
        );
      } catch (cleanupError) {
        logger.warn('Could not clean up a failed Remote Companion start', {
          hostId: host.id,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      }
      throw error;
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
    return runtime;
  }

  private async install(host: SshHost, remoteBasePath: string): Promise<string> {
    const platform = await this.detectPlatform(host);
    const target = resolveRemoteCompanionTarget(platform[0] ?? '', platform[1] ?? '');
    if (!target) {
      throw new Error(
        `Komla Remote Companion does not support ${platform[0] || 'unknown OS'} ${platform[1] || 'unknown architecture'}`
      );
    }

    const localPath = join(this.dependencies.resourceRoot(), target, 'komla');
    if (!existsSync(localPath)) {
      throw new Error(`Komla Remote Companion artifact is missing for ${target} at ${localPath}`);
    }
    const digest = createHash('sha256').update(readFileSync(localPath)).digest('hex');
    const remoteDirectory = pathPosix.join(
      remoteBasePath,
      'helpers',
      'bin',
      `protocol-${REMOTE_COMPANION_PROTOCOL_VERSION}`,
      digest
    );
    const remotePath = pathPosix.join(remoteDirectory, 'komla');
    const stablePath = pathPosix.join(remoteBasePath, 'helpers', 'komla');
    const linkCommands = [
      'set -e',
      `stable=${shellQuotePosix(stablePath)}`,
      `versioned=${shellQuotePosix(remotePath)}`,
      'temp_link="${stable}.new.$$"',
      'rm -f "$temp_link"',
      'ln -s "$versioned" "$temp_link"',
      'mv -f "$temp_link" "$stable"',
    ];
    // A binary is linked in the same round trip that finds or uploads it.
    const existing = (
      await this.dependencies.run(
        host,
        [
          `existing=$([ -x ${shellQuotePosix(remotePath)} ] && ${shellQuotePosix(remotePath)} version || true)`,
          'if [ -n "$existing" ]; then',
          ...linkCommands.map((line) => `  ${line}`),
          'fi',
          'printf "%s\\n" "$existing"',
        ].join('\n')
      )
    ).trim();
    if (!existing) {
      await this.dependencies.upload(
        host,
        [
          'set -e',
          `target_dir=${shellQuotePosix(remoteDirectory)}`,
          `target=${shellQuotePosix(remotePath)}`,
          'mkdir -p "$target_dir"',
          'umask 077',
          'temp_path=$(mktemp "$target_dir/.komla.XXXXXX")',
          'trap \'rm -f "$temp_path"\' EXIT HUP INT TERM',
          'cat > "$temp_path"',
          'chmod 700 "$temp_path"',
          '"$temp_path" version >/dev/null',
          'mv -f "$temp_path" "$target"',
          'trap - EXIT HUP INT TERM',
          ...linkCommands,
        ].join('\n'),
        localPath
      );
    }
    logger.info('Installed Komla Remote Companion', { hostId: host.id, target, remotePath });
    return remotePath;
  }
}

export const remoteCompanionService = new RemoteCompanionService({
  resourceRoot: getKomlaArtifactRoot,
  run: (host, command) => sshWorkspaceService.run(host, command),
  upload: (host, command, sourcePath) =>
    sshWorkspaceService.runWithFileInput(host, command, sourcePath),
  installed: (host, executable) => sshWorkspaceService.useExecChannel(host, executable),
});
