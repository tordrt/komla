import { BrowserWindow } from 'electron';

import {
  binaryTerminalOutputOverhead,
  decodeBase64,
  decodeBinaryAppFrame,
  encodeBinaryTerminalOutput,
  encodedJsonBytes,
  jsonStringBytes,
  MAX_ENCRYPTED_BODY_BYTES,
  REMOTE_CAPABILITIES,
  splitJsonString,
  type DecodedMessage,
  type RemoteTerminalSize,
} from '@komla/remote-protocol';

import {
  escapeRemoteAttentionCustomTitleSource,
  markRemoteAttentionCustomTitleSource,
  MAX_NAME_CHARS,
  MAX_TERMINAL_SNAPSHOT_CHUNK_CHARS,
  MAX_WORKSPACE_SEARCH_TEXT_CHARS,
  parseRemoteAppFrame,
  type RemoteAppFrame,
  type RemoteVoiceTranscribe,
  type RemoteWorkspaceSummary,
} from '../../../packages/remote-protocol/src/app/frames';
import { IPC } from '../../shared/constants/ipc-channels';
import { projectColorHex } from '../../shared/lib/project-color';
import {
  workspaceTagAppearance,
  type WorkspaceTagDefinition,
} from '../../shared/lib/workspace-tags';
import { getWorkspaceDisplayTitle } from '../../shared/lib/workspace-title';
import { needsAttention, pickWorkspaceAttention } from '../../shared/types/workspace';
import { createLogger } from '../lib/logger';

import { actionService } from './action.service';
import { agentPresetService } from './agent-preset.service';
import { configService } from './config.service';
import { gitService } from './git.service';
import { projectService } from './project.service';
import { ptyService, type TerminalSizeAuthority } from './pty.service';
import {
  remoteControlHostAccessService,
  type RemoteControlHostAccessService,
} from './remote-control-host-access.service';
import {
  remotePresetSummary,
  remoteProjectSummary,
  withProjectIcons,
} from './remote-control-host-launch';
import {
  remoteLocalAccessAllowed,
  remoteMayOpenAttention,
  remoteMayOpenTerminal,
  remoteMayOpenWorkspace,
  remoteMayRunActionCommand,
} from './remote-control-local-access';
import {
  remoteControlPushService,
  type RemoteControlPushService,
} from './remote-control-push.service';
import { onRemoteWorkspaceChange } from './remote-workspace-events';
import { sshHostService } from './ssh-host.service';
import { voiceTranscriptionService } from './voice-transcription.service';
import { windowService } from './window.service';
import { workspaceService } from './workspace.service';

import type { TerminalAttention } from './terminal-attention/terminal-attention';
import type { SshWorkspaceMode } from '../../shared/lib/ssh-workspace-mode';
import type {
  ActivePresetEntry,
  Action,
  AgentPreset,
  CreateWorkspaceParams,
  Project,
  Terminal,
  TerminalStatus,
  Workspace,
  WorkspaceAttention,
} from '../../shared/types';
import type { CommandKind } from '../../shared/types/workspace';

const logger = createLogger('RemoteControlSessionService');
const MAX_REMOTE_ATTENTION_MESSAGE_CHARS = 2 * 1024;
// The last index a snapshot chunk may carry, which makes its frame the longest.
const MAX_SNAPSHOT_CHUNK_INDEX = 4095;
// A burst of PTY reads becomes a few data frames instead of one per read.
const DEFAULT_OUTPUT_BATCH_MS = 8;
// When this much is still waiting to reach the phone, new output is skipped
// rather than queued behind it, and the phone gets the current screen once
// the backlog falls below the low-water mark.
const OUTPUT_HIGH_WATER_BYTES = 512 * 1024;
const OUTPUT_LOW_WATER_BYTES = 64 * 1024;
const DEFAULT_OUTPUT_DRAIN_POLL_MS = 100;
// How long a disconnected phone keeps its terminal's size for a reconnect.
const DEFAULT_SIZE_LEASE_LINGER_MS = 60_000;
const LOCAL_ACCESS_OFF =
  "This computer isn't shared with your devices. Create the workspace on an SSH host.";
const LOCAL_ACTIONS_OFF =
  "This project runs Quick Commands in its Local copy on this computer, which isn't shared with your devices.";

function notifyDesktopWorkspacesChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC.WORKSPACES_CHANGED);
    }
  }
}

function limitRemoteText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function limitRemoteAttentionMessage(message: string): string {
  return limitRemoteText(message, MAX_REMOTE_ATTENTION_MESSAGE_CHARS);
}

/** Free text the phone searches, on one line and clipped; undefined when there is none. */
function remoteSearchText(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/g, ' ').trim();
  return line ? limitRemoteText(line, MAX_WORKSPACE_SEARCH_TEXT_CHARS) : undefined;
}

function summarizeAttention(attention: WorkspaceAttention): RemoteWorkspaceSummary['attention'] {
  const title = attention.title?.trim();
  const message = title || attention.message?.trim();

  return {
    kind: attention.kind,
    source: title
      ? markRemoteAttentionCustomTitleSource(attention.source)
      : escapeRemoteAttentionCustomTitleSource(attention.source),
    updatedAt: attention.updatedAt,
    ...(message ? { message: limitRemoteAttentionMessage(message) } : {}),
    ...(attention.terminalId ? { terminalId: attention.terminalId } : {}),
  };
}

interface RemotePeer {
  onMessage(cb: (msg: DecodedMessage) => void): void;
  onClose(cb: () => void): void;
  sendEncryptedJson(value: unknown): Promise<void>;
  sendEncryptedBinary?(bytes: Uint8Array): Promise<void>;
  /** True once the phone agreed to binary frames; terminal bytes then go as binary payloads. */
  usesBinaryFrames?(): boolean;
  bufferedAmount?(): number;
  maxBodyBytes?(): number;
}

interface WorkspaceServiceLike {
  list(): Workspace[];
  get(workspaceId: string): Workspace | undefined;
  create(params: CreateWorkspaceParams): Promise<Workspace>;
  restartWithCleanup(workspaceId: string): Promise<Terminal>;
  stop(workspaceId: string): Promise<void>;
  regenerateWorkspaceName(workspaceId: string): Promise<Workspace>;
  attention: Pick<TerminalAttention, 'viewedRemotely'>;
  addTerminalWithPreparation(
    workspaceId: string,
    name?: string,
    command?: string | null,
    layoutHint?: 'tab' | 'split-right' | 'split-bottom',
    commandKind?: CommandKind
  ): Promise<Terminal>;
  addAgentTab(
    workspaceId: string,
    prompt?: string,
    launchModeId?: string,
    presetId?: string
  ): Terminal | Promise<Terminal>;
  removeTerminal(workspaceId: string, terminalId: string): Promise<void>;
}

interface ProjectServiceLike {
  get(projectId: string): Project | undefined;
  list(): Project[];
}

interface AgentPresetServiceLike {
  get(presetId: string): AgentPreset | undefined;
  getActivePresets(): ActivePresetEntry[];
}

interface ConfigServiceLike {
  get(): {
    defaultLaunchModeId?: string;
    directRemoteLocalAccess?: boolean;
    defaultSshWorkspaceMode?: SshWorkspaceMode;
    workspaceTags?: readonly WorkspaceTagDefinition[];
  };
}

interface ActionServiceLike {
  list(): Action[];
  get(id: string): Action | undefined;
  recordUsage(id: string, userInput?: string): Action;
}

interface SshHostServiceLike {
  list(): Array<{ id: string; name: string }>;
}

interface PtyServiceLike {
  enableTerminalPresentationTracking(): void;
  disableTerminalPresentationTracking(): void;
  getPresentationSnapshot(
    terminalId: string,
    options?: { scrollback?: number }
  ): Promise<{
    buffer: string;
    cols: number;
    rows: number;
    generation: number;
    seq: number;
  }>;
  getPresentationMetadata(terminalId: string): {
    cols: number;
    rows: number;
    generation: number;
    seq: number;
  };
  getOutputSince(
    terminalId: string,
    generation: number,
    seq: number
  ): Array<{ data: string; seq: number }> | null;
  getStatus(terminalId: string): TerminalStatus | null;
  getHostInfo?(terminalId: string): { hostname: string; isLocal: boolean } | undefined;
  write(terminalId: string, data: string): void;
  acquireSizeAuthority(terminalId: string, cols: number, rows: number): TerminalSizeAuthority;
  onData(listener: (terminalId: string, data: string, seq: number) => void): () => void;
  onStatus(listener: (terminalId: string, status: TerminalStatus) => void): () => void;
  onReset(listener: (terminalId: string) => void): () => void;
  onExit(listener: (terminalId: string) => void): () => void;
}

interface GitServiceLike {
  getBranchQuickStatus(worktreePath: string): Promise<{
    aheadTargetBranch: number;
    behindTargetBranch: number;
  }>;
  getChangedFilesWithSummary(worktreePath: string): Promise<{
    summary: { additions: number; deletions: number };
  }>;
}

interface WindowServiceLike {
  getMainWindowId(): string | null;
  broadcastWhenReady(channel: string, ...args: unknown[]): void;
}

interface VoiceServiceLike {
  getStatus(): string;
  warmup?(): Promise<void>;
  transcribe(audio: Float32Array): Promise<string>;
}

type PushServiceLike = Pick<
  RemoteControlPushService,
  'config' | 'subscribe' | 'unsubscribe' | 'sendTest' | 'registerViewer'
>;

type HostAccessLike = Pick<RemoteControlHostAccessService, 'phoneHosts' | 'onChange'>;

/** The trusted device an authenticated session belongs to. */
export interface RemoteSessionDevice {
  credentialId: string;
  /** The protocol features the page and this endpoint agreed on (`REMOTE_CAPABILITIES`). */
  capabilities?: readonly string[];
}

export interface RemoteControlSessionServiceDeps {
  workspaces?: WorkspaceServiceLike;
  projects?: ProjectServiceLike;
  agentPresets?: AgentPresetServiceLike;
  pty?: PtyServiceLike;
  git?: GitServiceLike;
  windows?: WindowServiceLike;
  voice?: VoiceServiceLike;
  config?: ConfigServiceLike;
  sshHosts?: SshHostServiceLike;
  actions?: ActionServiceLike;
  outputBatchMs?: number;
  outputDrainPollMs?: number;
  sizeLeaseLingerMs?: number;
  push?: PushServiceLike;
  hostAccess?: HostAccessLike;
}

interface TerminalOutputChunk {
  data: string;
  seq: number;
  generation: number;
}

interface TerminalDataFrame extends TerminalOutputChunk {
  type: 'app:terminal:data';
  workspaceId: string;
  terminalId: string;
  more?: true;
}

export interface RemoteControlSession {
  /**
   * `connectionDropped`: the phone may come straight back, so its terminal
   * size leases linger; otherwise the session ended on purpose and they go.
   */
  dispose(options?: { connectionDropped?: boolean }): void;
}

/**
 * Size leases a phone held when its connection dropped. Kept briefly, so a
 * reconnect takes the lease back instead of the terminal flipping to the
 * desktop's size and back, which would also make its missed output unusable.
 */
class LingeringSizeLeases {
  private readonly leases = new Map<
    string,
    { device: string; authority: TerminalSizeAuthority; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly lingerMs: number) {}

  keep(terminalId: string, device: string, authority: TerminalSizeAuthority): void {
    this.release(terminalId);
    const timer = setTimeout(() => this.release(terminalId), this.lingerMs);
    this.leases.set(terminalId, { device, authority, timer });
  }

  /** The lease `device` left on this terminal, if any; it lets go of the others it left. */
  take(terminalId: string, device: string | undefined): TerminalSizeAuthority | null {
    for (const [id, lease] of this.leases) {
      if (lease.device === device && id !== terminalId) this.release(id);
    }
    const lease = this.leases.get(terminalId);
    if (!lease) return null;
    if (lease.device !== device) {
      this.release(terminalId);
      return null;
    }
    clearTimeout(lease.timer);
    this.leases.delete(terminalId);
    return lease.authority;
  }

  releaseAll(): void {
    for (const terminalId of this.leases.keys()) this.release(terminalId);
  }

  releaseDevice(device: string): void {
    for (const [terminalId, lease] of this.leases) {
      if (lease.device === device) this.release(terminalId);
    }
  }

  private release(terminalId: string): void {
    const lease = this.leases.get(terminalId);
    if (!lease) return;
    clearTimeout(lease.timer);
    this.leases.delete(terminalId);
    lease.authority.release();
  }
}

class RemoteControlAppSession implements RemoteControlSession {
  private readonly attachedTerminals = new Map<string, string>();
  private readonly sizeAuthorities = new Map<string, TerminalSizeAuthority>();
  /** Terminals whose size the desktop took back, at the desktop's latest size. */
  private readonly desktopSizedTerminals = new Map<string, { cols: number; rows: number }>();
  private readonly pendingAttachedTerminals = new Map<
    string,
    {
      workspaceId: string;
      frames: Array<{ data: string; seq: number; generation: number }>;
      reset?: { cols: number; rows: number; generation: number; seq: number };
    }
  >();
  // Output waiting for the next batch, by terminal.
  private readonly outputBatches = new Map<
    string,
    TerminalOutputChunk & { workspaceId: string; bytes: number }
  >();
  private outputFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Attached terminals whose output was skipped while the phone fell behind.
  private readonly behindTerminals = new Set<string>();
  private catchUpTimer: ReturnType<typeof setTimeout> | null = null;
  // Output that arrives while a behind terminal's current screen is read.
  private readonly catchingUp = new Map<string, TerminalOutputChunk[]>();
  private readonly unsubscribers: Array<() => void> = [];
  private messageChain: Promise<void> = Promise.resolve();
  private workspacePushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  /** Whether the phone's page is on screen, as it last reported. */
  private pageVisible = true;
  // In-flight voice recordings being reassembled from ordered chunks, keyed by
  // requestId. Cleared on completion, on any protocol error, and on dispose.
  private readonly voiceChunks = new Map<
    string,
    {
      terminalId: string | undefined;
      purpose: 'terminal' | 'prompt';
      parts: Uint8Array[];
      total: number;
      nextSeq: number;
    }
  >();

  constructor(
    private readonly peer: RemotePeer,
    private readonly deps: Required<RemoteControlSessionServiceDeps>,
    private readonly leases: LingeringSizeLeases,
    private readonly device?: RemoteSessionDevice
  ) {
    if (device) {
      this.unsubscribers.push(
        this.deps.push.registerViewer(device.credentialId, () => ({
          visible: this.pageVisible,
          attachedTerminals: this.attachedTerminals,
        }))
      );
    }
    this.peer.onMessage((msg) => {
      if (this.disposed) return;
      const next = this.messageChain.then(() => {
        if (this.disposed) return;
        return this.handleMessage(msg);
      });
      this.messageChain = next.catch((err) => {
        logger.warn('remote app frame failed', err);
        if (!this.disposed) {
          // Name the request, so the phone can show the failure where it was made.
          const frame = RemoteControlAppSession.parsePhoneFrame(msg);
          void this.sendError(
            frame && 'requestId' in frame ? frame.requestId : undefined,
            'internal',
            err instanceof Error ? err.message : String(err)
          );
        }
      });
    });
    this.peer.onClose(() => this.dispose({ connectionDropped: true }));
    this.unsubscribers.push(onRemoteWorkspaceChange(() => this.scheduleWorkspacePush()));
    this.unsubscribers.push(
      this.deps.hostAccess.onChange(() => {
        if (this.disposed) return;
        void this.sendHosts('push').catch((err) => {
          logger.warn('remote host list push failed', err);
        });
      })
    );
    this.unsubscribers.push(
      this.deps.pty.onData((terminalId, data, seq) => {
        if (this.disposed) return;
        const workspaceId = this.attachedTerminals.get(terminalId);
        const pending = workspaceId ? undefined : this.pendingAttachedTerminals.get(terminalId);
        // Most output is from terminals no phone is watching; skip those before any lookup.
        if (!workspaceId && !pending) return;
        const frame = {
          data,
          seq,
          generation: this.deps.pty.getPresentationMetadata(terminalId).generation,
        };
        if (pending) pending.frames.push(frame);
        else if (workspaceId) this.queueTerminalOutput(workspaceId, terminalId, frame);
      })
    );
    this.unsubscribers.push(
      this.deps.pty.onReset((terminalId) => {
        if (this.disposed) return;
        const workspaceId = this.attachedTerminals.get(terminalId);
        const pending = workspaceId ? undefined : this.pendingAttachedTerminals.get(terminalId);
        // Reading another terminal's screen would start parsing its output for nobody.
        if (!workspaceId && !pending) return;
        const metadata = this.deps.pty.getPresentationMetadata(terminalId);
        if (pending) {
          pending.reset = metadata;
          return;
        }
        // The current screen sent on catching up covers the new generation.
        if (this.behindTerminals.has(terminalId) || this.catchingUp.has(terminalId)) {
          this.behindTerminals.add(terminalId);
          return;
        }
        this.flushTerminalOutput();
        this.sendTerminalStreamFrame({
          type: 'app:terminal:reset',
          workspaceId,
          terminalId,
          ...metadata,
        });
      })
    );
    this.unsubscribers.push(
      this.deps.pty.onStatus((terminalId, status) => {
        if (this.disposed) return;
        const workspaceId = this.attachedTerminals.get(terminalId);
        if (!workspaceId) return;
        this.flushTerminalOutput();
        this.sendTerminalStreamFrame({
          type: 'app:terminal:status',
          workspaceId,
          terminalId,
          status,
        });
      })
    );
    this.unsubscribers.push(
      this.deps.pty.onExit((terminalId) => {
        if (this.disposed || !this.attachedTerminals.has(terminalId)) return;
        // Deliver the process's last output before the terminal detaches.
        this.flushTerminalOutput();
        this.attachedTerminals.delete(terminalId);
        this.sizeAuthorities.get(terminalId)?.release();
        this.sizeAuthorities.delete(terminalId);
      })
    );
  }

  dispose({ connectionDropped = false }: { connectionDropped?: boolean } = {}): void {
    if (this.disposed) return;
    this.disposed = true;
    this.voiceChunks.clear();
    this.pendingAttachedTerminals.clear();
    this.clearTerminalOutput();
    for (const [terminalId, authority] of this.sizeAuthorities) {
      if (connectionDropped && this.device) {
        authority.onDesktopSize(null);
        this.leases.keep(terminalId, this.device.credentialId, authority);
      } else {
        authority.release();
      }
    }
    this.sizeAuthorities.clear();
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
    if (this.workspacePushTimer) {
      clearTimeout(this.workspacePushTimer);
      this.workspacePushTimer = null;
    }
    this.attachedTerminals.clear();
  }

  /** A phone frame; the only binary payload a phone sends is terminal input. */
  private static parsePhoneFrame(msg: DecodedMessage): RemoteAppFrame | null {
    if (msg.kind === 'json') return parseRemoteAppFrame(msg.data);
    const frame = decodeBinaryAppFrame(msg.data);
    return frame?.type === 'app:terminal:input' ? frame : null;
  }

  private async handleMessage(msg: DecodedMessage): Promise<void> {
    const frame = RemoteControlAppSession.parsePhoneFrame(msg);
    if (!frame) {
      await this.sendError(undefined, 'bad-frame', 'unrecognized remote app frame');
      return;
    }

    switch (frame.type) {
      case 'app:workspaces:list':
        await this.sendWorkspaceList(frame.requestId);
        return;
      case 'app:launch-options:get':
        await this.sendLaunchOptions(frame.requestId);
        return;
      case 'app:workspace:create': {
        if (!frame.projectId) {
          await this.sendError(
            frame.requestId,
            'unsupported',
            'Remote workspace creation currently requires projectId'
          );
          return;
        }
        if (
          !remoteLocalAccessAllowed(this.deps.config.get()) &&
          frame.environment?.kind !== 'ssh'
        ) {
          await this.sendError(frame.requestId, 'unsupported', LOCAL_ACCESS_OFF);
          return;
        }
        const workspace = await this.deps.workspaces.create({
          mode: 'worktree',
          projectId: frame.projectId,
          windowId: this.deps.windows.getMainWindowId() ?? undefined,
          name: frame.name,
          branchName: frame.branchName,
          presetId: frame.presetId,
          launchModeId: frame.launchModeId,
          initialPrompt: frame.initialPrompt,
          environment: frame.environment,
          deferBranchNaming: !frame.branchName,
          autoResolveBranchConflicts: true,
        });
        this.deps.windows.broadcastWhenReady(IPC.WORKSPACE_CREATED, workspace);
        notifyDesktopWorkspacesChanged();
        await this.peer.sendEncryptedJson({
          type: 'app:workspace:created',
          requestId: frame.requestId,
          workspace: await this.summarizeWorkspace(workspace),
        });
        await this.sendWorkspaceList(frame.requestId);
        return;
      }
      case 'app:workspace:start': {
        if (!(await this.openableWorkspace(frame.workspaceId, frame.requestId))) return;
        try {
          await this.deps.workspaces.restartWithCleanup(frame.workspaceId);
        } catch (err) {
          await this.sendError(
            frame.requestId,
            'start-failed',
            err instanceof Error ? err.message : String(err)
          );
          return;
        }
        const workspace = this.deps.workspaces.get(frame.workspaceId);
        if (!workspace) {
          await this.sendError(frame.requestId, 'not-found', 'workspace not found after start');
          return;
        }
        await this.peer.sendEncryptedJson({
          type: 'app:workspace:started',
          requestId: frame.requestId,
          workspace: await this.summarizeWorkspace(workspace),
        });
        notifyDesktopWorkspacesChanged();
        await this.sendWorkspaceList(frame.requestId);
        return;
      }
      case 'app:workspace:stop': {
        if (!(await this.openableWorkspace(frame.workspaceId, frame.requestId))) return;
        try {
          await this.deps.workspaces.stop(frame.workspaceId);
        } catch (err) {
          await this.sendError(
            frame.requestId,
            'stop-failed',
            err instanceof Error ? err.message : String(err)
          );
          return;
        }
        // Its terminals start at the desktop's size again when the workspace restarts.
        for (const [terminalId, workspaceId] of this.attachedTerminals) {
          if (workspaceId === frame.workspaceId) {
            this.attachedTerminals.delete(terminalId);
            this.sizeAuthorities.get(terminalId)?.release();
            this.sizeAuthorities.delete(terminalId);
          }
        }
        const workspace = this.deps.workspaces.get(frame.workspaceId);
        if (!workspace) {
          await this.sendError(frame.requestId, 'not-found', 'workspace not found after stop');
          return;
        }
        await this.peer.sendEncryptedJson({
          type: 'app:workspace:stopped',
          requestId: frame.requestId,
          workspace: await this.summarizeWorkspace(workspace),
        });
        notifyDesktopWorkspacesChanged();
        await this.sendWorkspaceList(frame.requestId);
        return;
      }
      case 'app:workspace:title:regenerate': {
        if (!(await this.openableWorkspace(frame.workspaceId, frame.requestId))) return;
        let workspace: Workspace;
        try {
          workspace = await this.deps.workspaces.regenerateWorkspaceName(frame.workspaceId);
        } catch (err) {
          await this.sendError(
            frame.requestId,
            'title-regenerate-failed',
            err instanceof Error ? err.message : String(err)
          );
          return;
        }
        await this.peer.sendEncryptedJson({
          type: 'app:workspace:title:regenerated',
          requestId: frame.requestId,
          workspace: await this.summarizeWorkspace(workspace),
        });
        notifyDesktopWorkspacesChanged();
        await this.sendWorkspaceList(frame.requestId);
        return;
      }
      case 'app:terminal:attach':
        await this.attachTerminal(
          frame.requestId,
          frame.workspaceId,
          frame.terminalId,
          frame.cols,
          frame.rows,
          frame.resume
        );
        return;
      case 'app:terminal:create': {
        const workspace = await this.openableWorkspace(frame.workspaceId, frame.requestId);
        if (!workspace) return;
        let terminal: Terminal;
        try {
          if (frame.source.kind === 'shell') {
            terminal = await this.deps.workspaces.addTerminalWithPreparation(
              workspace.id,
              undefined,
              null,
              'tab'
            );
          } else if (frame.source.kind === 'agent') {
            terminal = await this.deps.workspaces.addAgentTab(
              workspace.id,
              frame.source.prompt,
              frame.source.launchModeId,
              frame.source.presetId
            );
          } else {
            terminal = await this.createActionTerminal(
              workspace,
              frame.source.actionId,
              frame.source.userInput
            );
          }
        } catch (err) {
          await this.sendError(
            frame.requestId,
            'terminal-create-failed',
            err instanceof Error ? err.message : String(err)
          );
          return;
        }
        notifyDesktopWorkspacesChanged();
        await this.peer.sendEncryptedJson({
          type: 'app:terminal:created',
          requestId: frame.requestId,
          workspace: await this.summarizeWorkspace(workspace),
          terminalId: terminal.id,
        });
        return;
      }
      case 'app:terminal:close': {
        const workspace = this.deps.workspaces.get(frame.workspaceId);
        const terminal = workspace?.terminals.find((item) => item.id === frame.terminalId);
        if (
          !workspace ||
          !terminal ||
          !remoteMayOpenTerminal(this.deps.config.get(), workspace, terminal)
        ) {
          await this.sendError(frame.requestId, 'not-found', 'terminal not found');
          return;
        }
        try {
          await this.deps.workspaces.removeTerminal(workspace.id, frame.terminalId);
        } catch (err) {
          await this.sendError(
            frame.requestId,
            'terminal-close-failed',
            err instanceof Error ? err.message : String(err)
          );
          return;
        }
        this.attachedTerminals.delete(frame.terminalId);
        this.pendingAttachedTerminals.delete(frame.terminalId);
        this.sizeAuthorities.get(frame.terminalId)?.release();
        this.sizeAuthorities.delete(frame.terminalId);
        notifyDesktopWorkspacesChanged();
        await this.peer.sendEncryptedJson({
          type: 'app:terminal:closed',
          requestId: frame.requestId,
          workspace: await this.summarizeWorkspace(workspace),
          terminalId: frame.terminalId,
        });
        return;
      }
      case 'app:terminal:input':
        if (!this.attachedTerminals.has(frame.terminalId)) {
          await this.sendError(undefined, 'not-attached', 'terminal is not attached');
          return;
        }
        this.deps.pty.write(frame.terminalId, frame.data);
        return;
      case 'app:terminal:detach':
        this.attachedTerminals.delete(frame.terminalId);
        this.pendingAttachedTerminals.delete(frame.terminalId);
        this.sizeAuthorities.get(frame.terminalId)?.release();
        this.sizeAuthorities.delete(frame.terminalId);
        return;
      case 'app:terminal:resize':
        if (!this.attachedTerminals.has(frame.terminalId)) {
          await this.sendError(undefined, 'not-attached', 'terminal is not attached');
          return;
        }
        {
          const authority = this.sizeAuthorities.get(frame.terminalId);
          authority?.resize(frame.cols, frame.rows);
          const workspaceId = this.attachedTerminals.get(frame.terminalId)!;
          if (authority && this.desktopSizedTerminals.delete(frame.terminalId)) {
            this.sendTerminalSize(workspaceId, frame.terminalId, 'remote', frame);
          }
        }
        return;
      case 'app:push:config:get':
      case 'app:push:subscribe':
      case 'app:push:unsubscribe':
      case 'app:push:test':
        await this.handlePushFrame(frame);
        return;
      case 'app:client:visibility':
        this.pageVisible = frame.visible;
        return;
      case 'app:hosts:list':
        await this.sendHosts(frame.requestId);
        return;
      case 'app:voice:status':
        {
          const available = this.deps.voice.getStatus() === 'ready';
          if (available && this.deps.voice.warmup) {
            void this.deps.voice
              .warmup()
              .catch((err) => logger.warn('remote voice warmup failed', err));
          }
          await this.peer.sendEncryptedJson({
            type: 'app:voice:availability',
            requestId: frame.requestId,
            available,
          });
        }
        return;
      case 'app:voice:transcribe':
        await this.receiveVoiceChunk(frame);
        return;
      default:
        return;
    }
  }

  // Cap on a reassembled recording (~16 MiB of Int16 PCM ≈ 8 min at 16 kHz) so
  // a misbehaving client can't grow the buffer without bound.
  private static readonly MAX_VOICE_BYTES = 16 * 1024 * 1024;

  private async receiveVoiceChunk(frame: RemoteVoiceTranscribe): Promise<void> {
    const { requestId, terminalId, seq, final } = frame;
    const purpose = frame.purpose ?? 'terminal';

    if (seq === 0) {
      // First chunk: validate up front so we fail fast before buffering.
      if (purpose === 'terminal' && (!terminalId || !this.attachedTerminals.has(terminalId))) {
        await this.sendError(requestId, 'not-attached', 'terminal is not attached');
        return;
      }
      if (this.deps.voice.getStatus() !== 'ready') {
        await this.sendError(requestId, 'voice-unavailable', 'no voice model is ready');
        return;
      }
      this.voiceChunks.set(requestId, { terminalId, purpose, parts: [], total: 0, nextSeq: 0 });
    }

    const pending = this.voiceChunks.get(requestId);
    if (
      !pending ||
      pending.terminalId !== terminalId ||
      pending.purpose !== purpose ||
      pending.nextSeq !== seq
    ) {
      this.voiceChunks.delete(requestId);
      await this.sendError(requestId, 'bad-frame', 'out-of-order voice chunk');
      return;
    }

    const bytes = decodeBase64(frame.audio);
    if (!bytes || bytes.length % 2 !== 0) {
      this.voiceChunks.delete(requestId);
      await this.sendError(requestId, 'bad-frame', 'invalid voice audio payload');
      return;
    }

    pending.total += bytes.length;
    if (pending.total > RemoteControlAppSession.MAX_VOICE_BYTES) {
      this.voiceChunks.delete(requestId);
      await this.sendError(requestId, 'bad-frame', 'voice recording too large');
      return;
    }
    pending.parts.push(bytes);
    pending.nextSeq += 1;

    if (final) {
      this.voiceChunks.delete(requestId);
      await this.transcribeVoice(
        requestId,
        pending.terminalId,
        pending.purpose,
        pending.parts,
        frame.enter
      );
    }
  }

  private async transcribeVoice(
    requestId: string,
    terminalId: string | undefined,
    purpose: 'terminal' | 'prompt',
    parts: Uint8Array[],
    enter: boolean
  ): Promise<void> {
    // Concatenate the chunks into one contiguous, 2-byte-aligned buffer, then
    // decode little-endian Int16 PCM into the Float32 [-1, 1] range the
    // recognizer expects.
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      joined.set(part, offset);
      offset += part.length;
    }
    const pcm = new Int16Array(joined.buffer, 0, joined.length / 2);
    const samples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      samples[i] = pcm[i] / 32768;
    }
    let text: string;
    try {
      text = await this.deps.voice.transcribe(samples);
    } catch (err) {
      await this.sendError(
        requestId,
        'transcribe-failed',
        err instanceof Error ? err.message : String(err)
      );
      return;
    }
    if (purpose === 'prompt') {
      await this.peer.sendEncryptedJson({
        type: 'app:voice:transcribed',
        requestId,
        text,
      });
      return;
    }
    // The terminal may have detached while transcription ran.
    if (!terminalId || !this.attachedTerminals.has(terminalId)) {
      await this.sendError(requestId, 'not-attached', 'terminal is not attached');
      return;
    }
    if (text) {
      this.deps.pty.write(terminalId, enter ? `${text}\r` : text);
    } else if (enter) {
      this.deps.pty.write(terminalId, '\r');
    }
  }

  private async handlePushFrame(
    frame: Extract<
      RemoteAppFrame,
      {
        type:
          | 'app:push:config:get'
          | 'app:push:subscribe'
          | 'app:push:unsubscribe'
          | 'app:push:test';
      }
    >
  ): Promise<void> {
    if (!this.device) {
      await this.sendError(
        frame.requestId,
        'push-unavailable',
        'this session has no trusted device'
      );
      return;
    }
    const { credentialId } = this.device;
    if (frame.type === 'app:push:test') {
      await this.peer.sendEncryptedJson({
        type: 'app:push:tested',
        requestId: frame.requestId,
        outcome: await this.deps.push.sendTest(credentialId),
      });
      return;
    }
    try {
      if (frame.type === 'app:push:subscribe') {
        this.deps.push.subscribe(credentialId, frame.subscription, frame.notifyWhen);
      } else if (frame.type === 'app:push:unsubscribe') {
        this.deps.push.unsubscribe(credentialId);
      }
    } catch (err) {
      await this.sendError(
        frame.requestId,
        'push-rejected',
        err instanceof Error ? err.message : String(err)
      );
      return;
    }
    await this.peer.sendEncryptedJson({
      type: 'app:push:config',
      requestId: frame.requestId,
      ...this.deps.push.config(credentialId),
    });
  }

  private async attachTerminal(
    requestId: string,
    workspaceId: string,
    requestedTerminalId: string | undefined,
    cols: number | undefined,
    rows: number | undefined,
    resume?: { generation: number; seq: number }
  ): Promise<void> {
    const workspace = await this.openableWorkspace(workspaceId, requestId);
    if (!workspace) return;
    const terminals = this.openableTerminals(workspace);
    const terminal = requestedTerminalId
      ? terminals.find((candidate) => candidate.id === requestedTerminalId)
      : (terminals.find((candidate) => candidate.id === workspace.primaryTerminalId) ??
        terminals.find((candidate) => candidate.status === 'running') ??
        terminals[0]);

    if (!terminal) {
      if (requestedTerminalId) {
        await this.sendError(requestId, 'not-found', 'terminal not found in workspace');
        return;
      }
      await this.sendError(requestId, 'no-terminal', 'workspace has no terminal to attach');
      return;
    }

    for (const authority of this.sizeAuthorities.values()) authority.release();
    this.sizeAuthorities.clear();
    this.attachedTerminals.clear();
    this.pendingAttachedTerminals.clear();
    this.desktopSizedTerminals.clear();
    this.clearTerminalOutput();
    this.deps.workspaces.attention.viewedRemotely(workspaceId, terminal.id);
    const pendingFrames: Array<{ data: string; seq: number; generation: number }> = [];
    this.pendingAttachedTerminals.set(terminal.id, {
      workspaceId: workspace.id,
      frames: pendingFrames,
    });
    const missed = this.missedOutput(terminal.id, resume);
    // A replay keeps the current size; the phone sends a resize afterwards if its screen changed.
    const authority = this.takeSizeLease(terminal.id, missed ? {} : { cols, rows });
    let snapshot: { seq: number; generation: number };
    try {
      snapshot = missed
        ? await this.sendMissedOutput(requestId, workspace.id, terminal, missed)
        : await this.sendAttachSnapshot(requestId, workspace.id, terminal);
    } catch (err) {
      this.pendingAttachedTerminals.delete(terminal.id);
      // A dropped connection has already handed the lease on, for the phone's reconnect.
      if (this.sizeAuthorities.get(terminal.id) === authority) {
        this.sizeAuthorities.delete(terminal.id);
        authority.release();
      }
      throw err;
    }
    const pending = this.pendingAttachedTerminals.get(terminal.id);
    if (!pending) return;
    let baseline = snapshot;
    const forwardPendingReset = async (): Promise<boolean> => {
      const pendingReset = pending.reset;
      if (!pendingReset || pendingReset.generation === baseline.generation) return false;
      await this.peer.sendEncryptedJson({
        type: 'app:terminal:reset',
        workspaceId: workspace.id,
        terminalId: terminal.id,
        ...pendingReset,
      });
      baseline = { ...snapshot, ...pendingReset };
      return true;
    };
    // Each send can await while more output or another reset arrives, so only
    // finish once nothing is pending, with no await before attaching below.
    let index = 0;
    for (;;) {
      if (await forwardPendingReset()) continue;
      if (index >= pendingFrames.length) break;
      const frame = pendingFrames[index++];
      if (frame.generation !== baseline.generation || frame.seq <= baseline.seq) continue;
      for (const data of this.terminalDataFrames(workspace.id, terminal.id, frame)) {
        await this.sendTerminalData(data);
      }
    }
    // Access to the terminal may have gone, or another attach replaced this one, while sending.
    if (this.pendingAttachedTerminals.get(terminal.id) !== pending) return;
    this.pendingAttachedTerminals.delete(terminal.id);
    this.attachedTerminals.set(terminal.id, workspace.id);
    const desktopSize = this.desktopSizedTerminals.get(terminal.id);
    if (desktopSize) this.sendTerminalSize(workspace.id, terminal.id, 'desktop', desktopSize);
  }

  /**
   * After a reconnect, the output the phone missed, if all of it is still kept
   * and laid out for the current size; otherwise it gets a snapshot.
   */
  private missedOutput(
    terminalId: string,
    resume: { generation: number; seq: number } | undefined
  ): { resume: { generation: number; seq: number }; chunks: TerminalOutputChunk[] } | null {
    if (!resume) return null;
    const missed = this.deps.pty.getOutputSince(terminalId, resume.generation, resume.seq);
    return missed
      ? { resume, chunks: missed.map((chunk) => ({ ...chunk, generation: resume.generation })) }
      : null;
  }

  /**
   * The lease this device left on the terminal when its connection dropped, or
   * a new one, at the size asked for or else the terminal's current size.
   */
  private takeSizeLease(
    terminalId: string,
    requested: { cols?: number; rows?: number }
  ): TerminalSizeAuthority {
    const current = this.deps.pty.getPresentationMetadata(terminalId);
    const size = { cols: requested.cols ?? current.cols, rows: requested.rows ?? current.rows };
    const lingering = this.leases.take(terminalId, this.device?.credentialId);
    // Someone who used the terminal on the desktop while the phone was away keeps the size.
    const desktopSize = lingering?.desktopSize();
    if (lingering && !desktopSize) lingering.resize(size.cols, size.rows);
    const authority =
      lingering ?? this.deps.pty.acquireSizeAuthority(terminalId, size.cols, size.rows);
    this.sizeAuthorities.set(terminalId, authority);
    authority.onDesktopSize((cols, rows) => this.desktopTookSize(terminalId, cols, rows));
    if (desktopSize) this.desktopTookSize(terminalId, desktopSize.cols, desktopSize.rows);
    return authority;
  }

  /** Someone used the terminal on the desktop, which took its size back from this phone. */
  private desktopTookSize(terminalId: string, cols: number, rows: number): void {
    if (this.disposed) return;
    const previous = this.desktopSizedTerminals.get(terminalId);
    if (previous?.cols === cols && previous.rows === rows) return;
    this.desktopSizedTerminals.set(terminalId, { cols, rows });
    const workspaceId = this.attachedTerminals.get(terminalId);
    // An attach still being sent says so once it is attached.
    if (workspaceId) this.sendTerminalSize(workspaceId, terminalId, 'desktop', { cols, rows });
  }

  private sendTerminalSize(
    workspaceId: string,
    terminalId: string,
    owner: 'desktop' | 'remote',
    { cols, rows }: { cols: number; rows: number }
  ): void {
    // Output laid out for the previous size goes first.
    this.flushTerminalOutput();
    this.sendTerminalStreamFrame({
      type: 'app:terminal:size',
      workspaceId,
      terminalId,
      owner,
      cols,
      rows,
    } satisfies RemoteTerminalSize);
  }

  /** A resumed attach: the phone keeps its screen and gets what it missed after `resume`. */
  private async sendMissedOutput(
    requestId: string,
    workspaceId: string,
    terminal: Terminal,
    {
      resume,
      chunks,
    }: { resume: { generation: number; seq: number }; chunks: TerminalOutputChunk[] }
  ): Promise<{ seq: number; generation: number }> {
    const current = this.deps.pty.getPresentationMetadata(terminal.id);
    await this.peer.sendEncryptedJson({
      type: 'app:terminal:attached',
      requestId,
      resumed: true,
      snapshot: {
        workspaceId,
        terminalId: terminal.id,
        status: this.deps.pty.getStatus(terminal.id) ?? terminal.status,
        seq: resume.seq,
        generation: resume.generation,
        cols: current.cols,
        rows: current.rows,
        chunkCount: 0,
      },
    });
    for (const chunk of chunks) {
      for (const frame of this.terminalDataFrames(workspaceId, terminal.id, chunk)) {
        await this.sendTerminalData(frame);
      }
    }
    return { generation: resume.generation, seq: chunks.at(-1)?.seq ?? resume.seq };
  }

  /** Sends the terminal's serialized screen and scrollback; returns where live output resumes. */
  private async sendAttachSnapshot(
    requestId: string,
    workspaceId: string,
    terminal: Terminal
  ): Promise<{ seq: number; generation: number }> {
    const snapshot = await this.deps.pty.getPresentationSnapshot(terminal.id);
    const createSnapshotChunk = (data: string, index: number) => ({
      type: 'app:terminal:snapshot-chunk',
      requestId,
      terminalId: terminal.id,
      generation: snapshot.generation,
      index,
      data,
    });
    // A UTF-16 code unit is never less than one JSON byte, so the byte budget also caps characters.
    const chunks = splitJsonString(
      snapshot.buffer,
      Math.min(
        MAX_TERMINAL_SNAPSHOT_CHUNK_CHARS,
        (this.peer.maxBodyBytes?.() ?? MAX_ENCRYPTED_BODY_BYTES) -
          encodedJsonBytes(createSnapshotChunk('', MAX_SNAPSHOT_CHUNK_INDEX))
      )
    );
    await this.peer.sendEncryptedJson({
      type: 'app:terminal:attached',
      requestId,
      snapshot: {
        workspaceId,
        terminalId: terminal.id,
        status: this.deps.pty.getStatus(terminal.id) ?? terminal.status,
        seq: snapshot.seq,
        generation: snapshot.generation,
        cols: snapshot.cols,
        rows: snapshot.rows,
        chunkCount: chunks.length,
      },
    });
    for (let index = 0; index < chunks.length; index++) {
      await this.peer.sendEncryptedJson(createSnapshotChunk(chunks[index], index));
    }
    return { seq: snapshot.seq, generation: snapshot.generation };
  }

  private sendError(requestId: string | undefined, code: string, message: string): Promise<void> {
    return this.peer.sendEncryptedJson({
      type: 'app:error',
      ...(requestId ? { requestId } : {}),
      code,
      message,
    });
  }

  private async createActionTerminal(
    workspace: Workspace,
    actionId: string,
    userInput?: string
  ): Promise<Terminal> {
    const action = this.deps.actions.get(actionId);
    if (!action) throw new Error('action not found');
    if (
      action.projectIds?.length &&
      (!workspace.projectId || !action.projectIds.includes(workspace.projectId))
    ) {
      throw new Error('action is not available for this project');
    }
    if (action.content.includes('{{user_input}}') && !userInput?.trim()) {
      throw new Error('action requires input');
    }
    const project = workspace.projectId ? this.deps.projects.get(workspace.projectId) : undefined;
    const targetBranch = workspace.baseBranch || project?.baseBranch || 'main';
    const content = action.content
      .replaceAll('{{user_input}}', userInput?.trim() ?? '')
      .replaceAll('{{target_branch}}', targetBranch);
    let terminal: Terminal;
    if (action.type === 'command') {
      if (!remoteMayRunActionCommand(this.deps.config.get(), workspace, project)) {
        throw new Error(LOCAL_ACTIONS_OFF);
      }
      terminal = await this.deps.workspaces.addTerminalWithPreparation(
        workspace.id,
        action.title,
        content,
        'tab',
        'host'
      );
    } else {
      terminal = await this.deps.workspaces.addAgentTab(
        workspace.id,
        content,
        action.launchModeId,
        action.presetId
      );
    }
    this.deps.actions.recordUsage(action.id, userInput);
    return terminal;
  }

  /** The workspace if devices may open it; otherwise tells the phone it isn't there. */
  private async openableWorkspace(
    workspaceId: string,
    requestId: string
  ): Promise<Workspace | undefined> {
    const workspace = this.deps.workspaces.get(workspaceId);
    if (workspace && remoteMayOpenWorkspace(this.deps.config.get(), workspace)) return workspace;
    await this.sendError(requestId, 'not-found', 'workspace not found');
    return undefined;
  }

  private openableTerminals(workspace: Workspace): Terminal[] {
    const config = this.deps.config.get();
    return workspace.terminals.filter((terminal) =>
      remoteMayOpenTerminal(config, workspace, terminal)
    );
  }

  /** Detaches terminals devices may no longer open, as after "Allow access to this computer" goes off. */
  private detachUnopenableTerminals(): void {
    const config = this.deps.config.get();
    const openable = (workspaceId: string, terminalId: string) => {
      const workspace = this.deps.workspaces.get(workspaceId);
      const terminal = workspace?.terminals.find((item) => item.id === terminalId);
      return Boolean(
        workspace &&
        terminal &&
        remoteMayOpenWorkspace(config, workspace) &&
        remoteMayOpenTerminal(config, workspace, terminal)
      );
    };
    const attached = [
      ...this.attachedTerminals,
      ...[...this.pendingAttachedTerminals].map(([id, pending]) => [id, pending.workspaceId]),
    ];
    for (const [terminalId, workspaceId] of attached) {
      if (openable(workspaceId, terminalId)) continue;
      this.attachedTerminals.delete(terminalId);
      this.pendingAttachedTerminals.delete(terminalId);
      this.sizeAuthorities.get(terminalId)?.release();
      this.sizeAuthorities.delete(terminalId);
    }
  }

  private async sendWorkspaceList(requestId: string): Promise<void> {
    this.detachUnopenableTerminals();
    const config = this.deps.config.get();
    const workspaces = await Promise.all(
      this.deps.workspaces
        .list()
        .filter((workspace) => remoteMayOpenWorkspace(config, workspace))
        .map((workspace) => this.summarizeWorkspace(workspace))
    );
    const pages = this.workspacePages(workspaces);
    // Queue every page before awaiting any, so another list can't interleave its pages with these.
    await Promise.all(
      pages.map((page, index) =>
        this.peer.sendEncryptedJson({
          type: 'app:workspaces',
          requestId,
          workspaces: page,
          ...(index < pages.length - 1 ? { more: true } : {}),
        })
      )
    );
  }

  /** Splits a workspace list into pages that each fit one frame. */
  private workspacePages(workspaces: RemoteWorkspaceSummary[]): RemoteWorkspaceSummary[][] {
    const budget =
      (this.peer.maxBodyBytes?.() ?? MAX_ENCRYPTED_BODY_BYTES) -
      encodedJsonBytes({
        type: 'app:workspaces',
        requestId: 'r'.repeat(128),
        workspaces: [],
        more: true,
      });
    const pages: RemoteWorkspaceSummary[][] = [[]];
    let bytes = 0;
    for (const workspace of workspaces) {
      // Count the comma that separates it from the next summary.
      const size = encodedJsonBytes(workspace) + 1;
      if (bytes + size > budget && pages.at(-1)!.length > 0) {
        pages.push([]);
        bytes = 0;
      }
      pages.at(-1)!.push(workspace);
      bytes += size;
    }
    return pages;
  }

  private queueTerminalOutput(
    workspaceId: string,
    terminalId: string,
    chunk: TerminalOutputChunk
  ): void {
    const held = this.catchingUp.get(terminalId);
    if (held) {
      held.push(chunk);
      return;
    }
    // The current screen sent on catching up will include this output.
    if (this.behindTerminals.has(terminalId)) return;
    const bytes = jsonStringBytes(chunk.data);
    const batch = this.outputBatches.get(terminalId);
    if (
      batch &&
      (batch.generation !== chunk.generation ||
        batch.bytes + bytes > this.terminalDataBudget(workspaceId, terminalId))
    ) {
      this.flushTerminalOutput();
    }
    const current = this.outputBatches.get(terminalId);
    if (current) {
      current.data += chunk.data;
      current.seq = chunk.seq;
      current.bytes += bytes;
    } else {
      this.outputBatches.set(terminalId, { workspaceId, ...chunk, bytes });
    }
    if (this.outputFlushTimer) return;
    // Output after a quiet spell goes out at once, so a typed key echoes
    // without waiting; what follows it waits for the window to end.
    this.flushTerminalOutput();
    this.startOutputWindow();
  }

  private startOutputWindow(): void {
    this.outputFlushTimer = setTimeout(() => {
      this.outputFlushTimer = null;
      if (this.outputBatches.size === 0) return;
      this.flushTerminalOutput();
      this.startOutputWindow();
    }, this.deps.outputBatchMs);
  }

  private flushTerminalOutput(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }
    const batches = [...this.outputBatches];
    this.outputBatches.clear();
    for (const [terminalId, batch] of batches) {
      if (this.attachedTerminals.get(terminalId) !== batch.workspaceId) continue;
      if ((this.peer.bufferedAmount?.() ?? 0) > OUTPUT_HIGH_WATER_BYTES) {
        this.behindTerminals.add(terminalId);
        this.scheduleCatchUp();
        continue;
      }
      for (const frame of this.terminalDataFrames(batch.workspaceId, terminalId, batch)) {
        this.sendTerminalStreamData(frame);
      }
    }
  }

  /** Terminal output as a binary payload once the phone agreed to binary frames, else as JSON. */
  private sendTerminalData(frame: TerminalDataFrame): Promise<void> {
    if (this.peer.usesBinaryFrames?.() && this.peer.sendEncryptedBinary) {
      return this.peer.sendEncryptedBinary(encodeBinaryTerminalOutput(frame));
    }
    return this.peer.sendEncryptedJson(frame);
  }

  private sendTerminalStreamData(frame: TerminalDataFrame): void {
    void this.sendTerminalData(frame).catch((err) => {
      if (!this.disposed) logger.warn('remote terminal stream send failed', err);
    });
  }

  /**
   * Bytes of output that fit in one data frame for this terminal, counted as
   * JSON escapes them, which is never less than their UTF-8 size.
   */
  private terminalDataBudget(workspaceId: string, terminalId: string): number {
    const maxBody = this.peer.maxBodyBytes?.() ?? MAX_ENCRYPTED_BODY_BYTES;
    if (this.peer.usesBinaryFrames?.()) return maxBody - binaryTerminalOutputOverhead(terminalId);
    const empty: TerminalDataFrame = {
      type: 'app:terminal:data',
      workspaceId,
      terminalId,
      data: '',
      seq: Number.MAX_SAFE_INTEGER,
      generation: Number.MAX_SAFE_INTEGER,
      more: true,
    };
    return maxBody - encodedJsonBytes(empty);
  }

  /** One output chunk as data frames, split into continuation frames when it is too large. */
  private terminalDataFrames(
    workspaceId: string,
    terminalId: string,
    chunk: TerminalOutputChunk
  ): TerminalDataFrame[] {
    const pieces = splitJsonString(chunk.data, this.terminalDataBudget(workspaceId, terminalId));
    return pieces.map((data, index) => ({
      type: 'app:terminal:data',
      workspaceId,
      terminalId,
      data,
      seq: chunk.seq,
      generation: chunk.generation,
      ...(index < pieces.length - 1 ? { more: true as const } : {}),
    }));
  }

  private scheduleCatchUp(): void {
    this.catchUpTimer ??= setTimeout(() => {
      this.catchUpTimer = null;
      if (this.disposed || this.behindTerminals.size === 0) return;
      if ((this.peer.bufferedAmount?.() ?? 0) > OUTPUT_LOW_WATER_BYTES) {
        this.scheduleCatchUp();
        return;
      }
      for (const terminalId of this.behindTerminals) void this.sendCurrentScreen(terminalId);
    }, this.deps.outputDrainPollMs);
  }

  /** Replaces the phone's view of a terminal that fell behind with its current screen. */
  private async sendCurrentScreen(terminalId: string): Promise<void> {
    this.behindTerminals.delete(terminalId);
    const workspaceId = this.attachedTerminals.get(terminalId);
    if (!workspaceId) return;
    const held: TerminalOutputChunk[] = [];
    this.catchingUp.set(terminalId, held);
    let screen: Awaited<ReturnType<PtyServiceLike['getPresentationSnapshot']>>;
    try {
      screen = await this.deps.pty.getPresentationSnapshot(terminalId, { scrollback: 0 });
    } catch (err) {
      if (this.catchingUp.get(terminalId) === held) this.catchingUp.delete(terminalId);
      logger.warn('failed to read the current terminal screen', err);
      return;
    }
    // A new attachment or a detach while reading supersedes this catch-up.
    if (this.catchingUp.get(terminalId) !== held) return;
    this.catchingUp.delete(terminalId);
    if (this.disposed || this.attachedTerminals.get(terminalId) !== workspaceId) return;
    if (this.behindTerminals.has(terminalId)) {
      // The PTY restarted while the screen was read.
      this.scheduleCatchUp();
      return;
    }
    // The phone writes data only above the reset's seq, so the screen goes out as one read at
    // the seq just below where live output resumes, split into frames that share it.
    const frames =
      screen.seq > 0
        ? this.terminalDataFrames(workspaceId, terminalId, {
            data: screen.buffer,
            seq: screen.seq,
            generation: screen.generation,
          })
        : [];
    this.sendTerminalStreamFrame({
      type: 'app:terminal:reset',
      workspaceId,
      terminalId,
      generation: screen.generation,
      seq: Math.max(0, screen.seq - 1),
      cols: screen.cols,
      rows: screen.rows,
    });
    for (const frame of frames) this.sendTerminalStreamData(frame);
    for (const chunk of held) {
      if (chunk.generation === screen.generation && chunk.seq > screen.seq) {
        this.queueTerminalOutput(workspaceId, terminalId, chunk);
      }
    }
  }

  private clearTerminalOutput(): void {
    if (this.outputFlushTimer) {
      clearTimeout(this.outputFlushTimer);
      this.outputFlushTimer = null;
    }
    if (this.catchUpTimer) {
      clearTimeout(this.catchUpTimer);
      this.catchUpTimer = null;
    }
    this.outputBatches.clear();
    this.behindTerminals.clear();
    this.catchingUp.clear();
  }

  private sendTerminalStreamFrame(frame: unknown): void {
    void this.peer.sendEncryptedJson(frame).catch((err) => {
      if (!this.disposed) {
        logger.warn('remote terminal stream send failed', err);
      }
    });
  }

  private async sendLaunchOptions(requestId: string): Promise<void> {
    const config = this.deps.config.get();
    const defaultLaunchModeId = config.defaultLaunchModeId;
    const projects = this.deps.projects.list();
    const options = {
      type: 'app:launch-options' as const,
      requestId,
      ...(defaultLaunchModeId ? { defaultLaunchModeId } : {}),
      projects: projects.map(remoteProjectSummary),
      presets: this.deps.agentPresets.getActivePresets().flatMap((entry) => {
        const preset = this.deps.agentPresets.get(entry.presetId);
        return preset ? [remotePresetSummary(preset, entry)] : [];
      }),
      environments: [
        ...(remoteLocalAccessAllowed(config)
          ? [{ kind: 'local' as const, name: 'This computer' }]
          : []),
        ...this.deps.sshHosts.list().map((host) => ({
          kind: 'ssh' as const,
          id: host.id,
          name: host.name,
        })),
      ],
      actions: this.deps.actions.list().map((action) => ({
        id: action.id,
        title: action.title,
        type: action.type === 'command' ? ('command' as const) : ('prompt' as const),
        ...(action.projectIds?.length ? { projectIds: action.projectIds } : {}),
        ...(action.content.includes('{{user_input}}') ? { requiresInput: true } : {}),
      })),
    };
    if (this.device?.capabilities?.includes(REMOTE_CAPABILITIES.PROJECT_ICONS)) {
      const icons = new Map(projects.map((project) => [project.id, project.icon]));
      options.projects = withProjectIcons(
        options.projects,
        (projectId) => icons.get(projectId),
        encodedJsonBytes(options)
      );
    }
    await this.peer.sendEncryptedJson(options);
  }

  private async sendHosts(requestId: string): Promise<void> {
    await this.peer.sendEncryptedJson({
      type: 'app:hosts',
      requestId,
      hosts: this.deps.hostAccess.phoneHosts(),
    });
  }

  private scheduleWorkspacePush(): void {
    if (this.disposed || this.workspacePushTimer) return;
    this.workspacePushTimer = setTimeout(() => {
      this.workspacePushTimer = null;
      if (this.disposed) return;
      void this.sendWorkspaceList('push').catch((err) => {
        logger.warn('remote workspace push failed', err);
      });
    }, 100);
  }

  /** The project's color as the desktop shows it, saved or derived from its name, in hex. */
  private projectColorField<K extends 'color' | 'projectColor'>(
    key: K,
    project: { name: string; color?: string }
  ): Partial<Record<K, string>> {
    const color = projectColorHex(project.color, project.name);
    return color ? ({ [key]: color } as Partial<Record<K, string>>) : {};
  }

  /** The workspace's tag as the tag list shows it, for a page that agreed to tags. */
  private tagField(workspace: Workspace): Pick<RemoteWorkspaceSummary, 'tag'> {
    if (
      !workspace.tag ||
      !this.device?.capabilities?.includes(REMOTE_CAPABILITIES.WORKSPACE_TAGS)
    ) {
      return {};
    }
    return {
      tag: workspaceTagAppearance(this.deps.config.get().workspaceTags ?? [], workspace.tag),
    };
  }

  private async summarizeWorkspace(workspace: Workspace): Promise<RemoteWorkspaceSummary> {
    const project = workspace.projectId ? this.deps.projects.get(workspace.projectId) : undefined;
    const git = await this.summarizeGit(workspace);
    const terminals = this.openableTerminals(workspace);
    // A hidden Local copy shell's attention gives way to what the openable terminals show.
    const attentionShown =
      !workspace.attention ||
      remoteMayOpenAttention(this.deps.config.get(), workspace, workspace.attention);
    const attention = attentionShown
      ? workspace.attention
      : pickWorkspaceAttention(terminals.map((terminal) => terminal.attention));
    const description = remoteSearchText(workspace.customDescription);
    const lastPrompt = remoteSearchText(workspace.promptSubmits?.at(-1)?.prompt);
    return {
      id: workspace.id,
      // The title the desktop's sidebar shows.
      name: limitRemoteText(getWorkspaceDisplayTitle(workspace), MAX_NAME_CHARS),
      ...(description ? { description } : {}),
      ...(lastPrompt ? { lastPrompt } : {}),
      workingDirectory: workspace.workingDirectory,
      projectId: workspace.projectId,
      ...(project?.name ? { projectName: project.name } : {}),
      ...(project ? this.projectColorField('projectColor', project) : {}),
      ...(workspace.branchName ? { branchName: workspace.branchName } : {}),
      ...this.tagField(workspace),
      status: workspace.status,
      provisioning: workspace.provisioning === true,
      ...(workspace.agentActive ? { agentActive: true } : {}),
      ...((attentionShown ? workspace.needsAttention : needsAttention(attention))
        ? { needsAttention: true }
        : {}),
      ...(attention ? { attention: summarizeAttention(attention) } : {}),
      createdAt: workspace.createdAt,
      lastActivityAt: workspace.lastActivityAt,
      ...(git ? { git } : {}),
      ...(workspace.primaryTerminalId &&
      terminals.some((terminal) => terminal.id === workspace.primaryTerminalId)
        ? { primaryTerminalId: workspace.primaryTerminalId }
        : {}),
      terminals: terminals.map((terminal) => ({
        id: terminal.id,
        name: terminal.name,
        status: terminal.status,
        ...this.summarizeTerminalEnvironment(workspace, terminal),
        ...(terminal.agentActive ? { agentActive: true } : {}),
        // A done the user saw on screen shows only on its pane here, not on the phone.
        ...(terminal.attention && !terminal.attention.seen
          ? { attention: summarizeAttention(terminal.attention) }
          : {}),
      })),
    };
  }

  private summarizeTerminalEnvironment(
    workspace: Workspace,
    terminal: Terminal
  ): Pick<RemoteWorkspaceSummary['terminals'][number], 'environment'> {
    if (terminal.executionLocation === 'local-mirror') return {};
    const hostInfo = this.deps.pty.getHostInfo?.(terminal.id);
    if (hostInfo && !hostInfo.isLocal) {
      return {
        environment: { kind: 'ssh', name: hostInfo.hostname },
      };
    }
    const backend = workspace.backend;
    if (backend?.kind === 'ssh') {
      const host = this.deps.sshHosts.list().find((candidate) => candidate.id === backend.hostId);
      return { environment: { kind: 'ssh', name: host?.name ?? 'SSH' } };
    }
    return {};
  }

  private async summarizeGit(workspace: Workspace): Promise<RemoteWorkspaceSummary['git']> {
    if (
      !workspace.isWorktree ||
      !workspace.branchName ||
      !workspace.workingDirectory ||
      workspace.status !== 'active' ||
      workspace.provisioning === true
    ) {
      return undefined;
    }
    try {
      const [status, changed] = await Promise.all([
        this.deps.git.getBranchQuickStatus(workspace.workingDirectory),
        this.deps.git.getChangedFilesWithSummary(workspace.workingDirectory),
      ]);
      return {
        additions: changed.summary.additions,
        deletions: changed.summary.deletions,
        aheadTargetBranch: status.aheadTargetBranch,
        behindTargetBranch: status.behindTargetBranch,
      };
    } catch {
      return undefined;
    }
  }
}

export class RemoteControlSessionService {
  private readonly deps: Required<RemoteControlSessionServiceDeps>;
  private readonly leases: LingeringSizeLeases;

  constructor(deps: RemoteControlSessionServiceDeps = {}) {
    this.deps = {
      workspaces: deps.workspaces ?? workspaceService,
      projects: deps.projects ?? projectService,
      agentPresets: deps.agentPresets ?? agentPresetService,
      pty: deps.pty ?? ptyService,
      git: deps.git ?? gitService,
      windows: deps.windows ?? windowService,
      voice: deps.voice ?? voiceTranscriptionService,
      config: deps.config ?? configService,
      sshHosts: deps.sshHosts ?? sshHostService,
      actions: deps.actions ?? actionService,
      outputBatchMs: deps.outputBatchMs ?? DEFAULT_OUTPUT_BATCH_MS,
      outputDrainPollMs: deps.outputDrainPollMs ?? DEFAULT_OUTPUT_DRAIN_POLL_MS,
      push: deps.push ?? remoteControlPushService,
      hostAccess: deps.hostAccess ?? remoteControlHostAccessService,
      sizeLeaseLingerMs: deps.sizeLeaseLingerMs ?? DEFAULT_SIZE_LEASE_LINGER_MS,
    };
    this.leases = new LingeringSizeLeases(this.deps.sizeLeaseLingerMs);
  }

  enableTerminalPresentationTracking(): void {
    this.deps.pty.enableTerminalPresentationTracking();
  }

  disableTerminalPresentationTracking(): void {
    this.leases.releaseAll();
    this.deps.pty.disableTerminalPresentationTracking();
  }

  /** A removed device won't come back for the terminal sizes its dropped connection left. */
  releaseDeviceLeases(credentialId: string): void {
    this.leases.releaseDevice(credentialId);
  }

  attachPeer(peer: RemotePeer, device?: RemoteSessionDevice): RemoteControlSession {
    return new RemoteControlAppSession(peer, this.deps, this.leases, device);
  }
}

export const remoteControlSessionService = new RemoteControlSessionService();
