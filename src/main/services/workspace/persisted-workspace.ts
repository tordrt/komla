import { normalizeRecentLinks } from '../../../shared/lib/recent-links';
import { normalizeSavedLayout } from '../../../shared/lib/saved-layout';
import { normalizeSshTargetBranch } from '../../../shared/lib/ssh-target-branch';
import {
  encodeTerminalExecution,
  isResumable,
  persistedRemoteSessionActive,
} from '../../../shared/lib/terminal-execution-state';
import { normalizeVirtualDesktops } from '../../../shared/lib/virtual-desktops';
import {
  MAX_WORKSPACE_TAG_TOOLTIP,
  normalizeWorkspaceTagName,
  PULL_REQUEST_TAG_STATES,
  type PullRequestTagState,
} from '../../../shared/lib/workspace-tags';
import { STATUS_ITEM_ID_PATTERN } from '../../../shared/types/status-items';
import { isLocalTerminalExecutionLocation } from '../../../shared/types/terminal';
import {
  isSshWorkspace,
  type WorkspaceBackend,
  type WorkspaceCustomNameSource,
  type WorkspaceGitStatusSnapshot,
} from '../../../shared/types/workspace';
import { migrate } from '../../lib/migration';
import { normalizePersistedTerminalLayout } from '../ssh-workspace-sync/terminal-layout';

import { normalizePromptSubmits } from './prompt-submits';

import type {
  Terminal,
  TerminalExecutionLocation,
  Workspace,
  WorkspaceAttention,
  WorkspaceAttentionSource,
  WorkspaceRecentLink,
  WorkspaceSavedLayout,
  WorkspaceStatus,
  WorkspaceVirtualDesktop,
} from '../../../shared/types';
import type { TerminalAttention } from '../terminal-attention/terminal-attention';

export const WORKSPACE_VERSION = 1;

const WORKSPACE_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

// What we persist (including recoverable SSH terminal identities). A type alias, not an
// interface, so it converts to and from the Record that migrate() works on.
export type PersistedWorkspace = {
  _version?: number;
  id: string;
  name: string;
  customName?: string;
  customDescription?: string;
  customNameSource?: WorkspaceCustomNameSource;
  customNameGeneratedAt?: number;
  promptSubmitsSinceCustomNameGeneration?: number;
  workingDirectory: string;
  backend?: WorkspaceBackend;
  lastKnownGitStatus?: WorkspaceGitStatusSnapshot;
  branchName?: string;
  isWorktree: boolean;
  projectId: string | null;
  repoName?: string;
  baseBranch?: string;
  branchedFrom?: string;
  primaryTerminalId?: string;
  lastDynamicTitle?: string;
  terminals?: Array<{
    id: string;
    name: string;
    dynamicTitle?: string;
    createdAt: number;
    layoutHint?: Terminal['layoutHint'];
    setupStepId?: string;
    executionLocation?: TerminalExecutionLocation;
    remoteSessionActive?: boolean;
    attention?: WorkspaceAttention;
    activeAgentSources?: Record<string, number>;
    lastAcceptedHookDeliveryId?: string;
    lastJournalDeliveryId?: string;
  }>;
  terminalLayout?: Workspace['terminalLayout'];
  windowId: string | null;
  categoryId: string | null;
  createdAt: number;
  lastActivityAt: number;
  lastStoppedAt?: number;
  /** A local workspace that was running when Komla last quit, so the next launch can restart it. */
  runningAtQuit?: boolean;
  order: number;
  unread?: Workspace['unread'];
  pinned?: boolean;
  tag?: string;
  tagSource?: Workspace['tagSource'];
  tagTooltip?: string;
  pullRequestState?: Workspace['pullRequestState'];
  snoozedUntil?: number;
  wakesOnNotification?: boolean;
  needsAttention?: boolean;
  attention?: WorkspaceAttention;
  status?: WorkspaceStatus;
  trashedAt?: number;
  promptSubmits?: Workspace['promptSubmits'];
  provisioning?: boolean;
  provisionStatus?: string;
  provisioningRepoPath?: string;
  provisioningBranchCreated?: boolean;
  provisioningWorktreeCreated?: boolean;
  presetId?: string | null;
  launchModeId?: string | null;
  reasoningLevelId?: string | null;
  modelId?: string | null;
  linkedWorkspaceIds?: string[];
  /** Whether the workspace's file panel is open. */
  fileTreeOpen?: boolean;
  fileTreeMode?: Workspace['fileTreeMode'];
  sidebarPanelId?: string;
  savedLayout?: WorkspaceSavedLayout;
  recentLinks?: WorkspaceRecentLink[];
  virtualDesktops?: WorkspaceVirtualDesktop[];
  color?: string | null;
  defaultActionId?: string;
  paneDefaultActionId?: string;
};

function normalizePersistedAttention(value: unknown): WorkspaceAttention | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const attention = value as Partial<WorkspaceAttention>;
  if (
    !['input-required', 'turn-complete', 'error', 'idle', 'generic'].includes(
      attention.kind ?? ''
    ) ||
    typeof attention.source !== 'string' ||
    typeof attention.updatedAt !== 'number' ||
    !Number.isFinite(attention.updatedAt)
  ) {
    return undefined;
  }
  return {
    kind: attention.kind as WorkspaceAttention['kind'],
    source: attention.source,
    updatedAt: attention.updatedAt,
    ...(typeof attention.title === 'string' ? { title: attention.title } : {}),
    ...(typeof attention.body === 'string' ? { body: attention.body } : {}),
    ...(typeof attention.color === 'string' ? { color: attention.color } : {}),
    ...(typeof attention.badge === 'string' ? { badge: attention.badge } : {}),
    ...(typeof attention.icon === 'string' ? { icon: attention.icon } : {}),
    ...(typeof attention.iconColor === 'string' ? { iconColor: attention.iconColor } : {}),
    ...(typeof attention.message === 'string' ? { message: attention.message } : {}),
    ...(typeof attention.terminalId === 'string' ? { terminalId: attention.terminalId } : {}),
    ...(attention.seen === true ? { seen: true } : {}),
  };
}

export function normalizePersistedSshTerminals(value: PersistedWorkspace['terminals']): Terminal[] {
  if (!Array.isArray(value)) return [];
  const terminals: Terminal[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      isLocalTerminalLocation(item.executionLocation) ||
      typeof item.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(item.id) ||
      seen.has(item.id) ||
      typeof item.name !== 'string' ||
      typeof item.createdAt !== 'number'
    ) {
      continue;
    }
    seen.add(item.id);
    terminals.push({
      id: item.id,
      name: item.name,
      status: 'stopped',
      createdAt: item.createdAt,
      dynamicTitle: typeof item.dynamicTitle === 'string' ? item.dynamicTitle : undefined,
      layoutHint:
        item.layoutHint === 'tab' ||
        item.layoutHint === 'split-right' ||
        item.layoutHint === 'split-bottom'
          ? item.layoutHint
          : undefined,
      ...(typeof item.setupStepId === 'string' && item.setupStepId
        ? { setupStepId: item.setupStepId }
        : {}),
      executionLocation: 'workspace',
      ...encodeTerminalExecution({ kind: 'restored', persistedActive: item.remoteSessionActive }),
      attention: normalizePersistedAttention(item.attention),
      lastAcceptedHookDeliveryId:
        typeof item.lastAcceptedHookDeliveryId === 'string'
          ? item.lastAcceptedHookDeliveryId
          : undefined,
      lastJournalDeliveryId:
        typeof item.lastJournalDeliveryId === 'string' ? item.lastJournalDeliveryId : undefined,
    });
  }
  return terminals;
}

function normalizePersistedActiveAgentSources(
  value: unknown
): Map<WorkspaceAttentionSource, number> {
  const sources = new Map<WorkspaceAttentionSource, number>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return sources;
  for (const [source, count] of Object.entries(value)) {
    if (
      source.length < 1 ||
      source.length > 64 ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count < 1
    ) {
      continue;
    }
    sources.set(source, count);
  }
  return sources;
}

const GIT_FILE_STATUSES = new Set(['added', 'modified', 'deleted', 'renamed', 'untracked']);

function hasFieldsOfType(
  value: unknown,
  keys: readonly string[],
  type: 'boolean' | 'number' | 'string'
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    keys.every((key) => typeof (value as Record<string, unknown>)[key] === type)
  );
}

function normalizeLastKnownGitStatus(value: unknown): WorkspaceGitStatusSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const snapshot = value as Record<string, unknown>;
  const branchNumberKeys = [
    'behindTargetBranch',
    'aheadTargetBranch',
    'unpushedCommits',
    'behindRemote',
    'targetBranchAheadRemote',
    'targetBranchBehindRemote',
  ] as const;
  const branch = snapshot['branch'];
  if (
    typeof snapshot['updatedAt'] !== 'number' ||
    (snapshot['lastConfirmedAt'] !== undefined &&
      snapshot['lastConfirmedAt'] !== null &&
      (typeof snapshot['lastConfirmedAt'] !== 'number' ||
        !Number.isFinite(snapshot['lastConfirmedAt']))) ||
    !hasFieldsOfType(branch, branchNumberKeys, 'number') ||
    !hasFieldsOfType(branch, ['mainBranch', 'defaultBranch', 'currentBranch'], 'string') ||
    !hasFieldsOfType(branch, ['hasRemote', 'hasOriginRemote', 'targetBranchHasRemote'], 'boolean')
  ) {
    return undefined;
  }

  const diff = snapshot['diff'] as Record<string, unknown> | undefined;
  const files = diff?.['files'];
  const summary = diff?.['summary'];
  if (
    !Array.isArray(files) ||
    !hasFieldsOfType(summary, ['additions', 'deletions', 'filesChanged'], 'number') ||
    !files.every(
      (file) =>
        hasFieldsOfType(file, ['path', 'status'], 'string') &&
        GIT_FILE_STATUSES.has(file['status'] as string) &&
        hasFieldsOfType(file, ['staged'], 'boolean') &&
        hasFieldsOfType(file, ['additions', 'deletions'], 'number') &&
        (file['originalPath'] === undefined || typeof file['originalPath'] === 'string') &&
        (file['isDirectory'] === undefined || typeof file['isDirectory'] === 'boolean')
    )
  ) {
    return undefined;
  }

  return value as WorkspaceGitStatusSnapshot;
}

export function isValidPersistedWorkspace(obj: unknown): obj is PersistedWorkspace {
  if (typeof obj !== 'object' || obj === null) return false;
  const w = obj as Record<string, unknown>;
  return (
    typeof w['id'] === 'string' &&
    typeof w['name'] === 'string' &&
    typeof w['workingDirectory'] === 'string' &&
    typeof w['isWorktree'] === 'boolean' &&
    (typeof w['projectId'] === 'string' || w['projectId'] === null) &&
    (typeof w['windowId'] === 'string' || w['windowId'] === null) &&
    (typeof w['categoryId'] === 'string' || w['categoryId'] === null) &&
    typeof w['createdAt'] === 'number' &&
    typeof w['lastActivityAt'] === 'number' &&
    typeof w['order'] === 'number'
  );
}

function normalizeWorkspaceBackend(value: unknown): WorkspaceBackend | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const backend = value as Record<string, unknown>;
  if (backend.kind === 'local') return { kind: 'local' };
  if (
    backend.kind === 'ssh' &&
    typeof backend.hostId === 'string' &&
    typeof backend.remoteDirectory === 'string' &&
    typeof backend.remoteRepoPath === 'string' &&
    typeof backend.remoteProjectRoot === 'string' &&
    typeof backend.gitUrl === 'string'
  ) {
    const baseBranch =
      typeof backend.baseBranch === 'string'
        ? normalizeSshTargetBranch(backend.baseBranch)
        : undefined;
    return {
      kind: 'ssh',
      hostId: backend.hostId,
      remoteDirectory: backend.remoteDirectory,
      remoteRepoPath: backend.remoteRepoPath,
      remoteProjectRoot: backend.remoteProjectRoot,
      gitUrl: backend.gitUrl,
      ...(typeof backend.projectId === 'string' ? { projectId: backend.projectId } : {}),
      ...(typeof backend.projectName === 'string' ? { projectName: backend.projectName } : {}),
      ...(typeof backend.branchName === 'string' ? { branchName: backend.branchName } : {}),
      ...(backend.checkoutExistingBranch === true ? { checkoutExistingBranch: true } : {}),
      ...(baseBranch ? { baseBranch } : {}),
      ...(typeof backend.defaultBranch === 'string'
        ? { defaultBranch: backend.defaultBranch }
        : {}),
      ...(typeof backend.startPoint === 'string' ? { startPoint: backend.startPoint } : {}),
    };
  }
  return undefined;
}

function normalizeCustomNameSource(value: unknown): WorkspaceCustomNameSource | undefined {
  return value === 'generated' || value === 'manual' ? value : undefined;
}

function isLocalTerminalLocation(location: TerminalExecutionLocation | undefined): boolean {
  return isLocalTerminalExecutionLocation(location);
}

export function hydrateWorkspace(rawPersisted: PersistedWorkspace): {
  workspace: Workspace;
  /** Saved spinner sources by Terminal id, restored once the workspace is in the store. */
  agentSources: Map<string, Map<WorkspaceAttentionSource, number>>;
  /** Whether it was saved as running when Komla last quit, outside the Trash. */
  runningAtQuit: boolean;
} {
  const { runningAtQuit: persistedRunningAtQuit, ...persisted } = migrate(
    rawPersisted,
    WORKSPACE_VERSION,
    WORKSPACE_MIGRATIONS
  ) as PersistedWorkspace;

  const backend = normalizeWorkspaceBackend(persisted.backend);
  const terminals =
    backend?.kind === 'ssh' ? normalizePersistedSshTerminals(persisted.terminals) : [];
  const persistedPrimaryTerminalId = terminals.some(
    (terminal) => terminal.id === persisted.primaryTerminalId
  )
    ? persisted.primaryTerminalId
    : terminals[0]?.id;
  const persistedAttention =
    backend?.kind === 'ssh' ? normalizePersistedAttention(persisted.attention) : undefined;
  const inTrash = persisted.status === 'trashed';
  const workspace: Workspace = {
    ...persisted,
    promptSubmits: normalizePromptSubmits(persisted.promptSubmits),
    tag:
      typeof persisted.tag === 'string'
        ? normalizeWorkspaceTagName(persisted.tag) || undefined
        : undefined,
    tagSource: persisted.tagSource === 'pull-request' ? 'pull-request' : undefined,
    tagTooltip:
      persisted.tag && typeof persisted.tagTooltip === 'string'
        ? persisted.tagTooltip.slice(0, MAX_WORKSPACE_TAG_TOOLTIP) || undefined
        : undefined,
    pullRequestState: PULL_REQUEST_TAG_STATES.includes(
      persisted.pullRequestState as PullRequestTagState
    )
      ? persisted.pullRequestState
      : undefined,
    backend,
    lastKnownGitStatus:
      backend?.kind === 'ssh'
        ? normalizeLastKnownGitStatus(persisted.lastKnownGitStatus)
        : undefined,
    attention: persistedAttention,
    customNameSource: normalizeCustomNameSource(persisted.customNameSource),
    fileTreeOpen: typeof persisted.fileTreeOpen === 'boolean' ? persisted.fileTreeOpen : undefined,
    fileTreeMode:
      persisted.fileTreeMode === 'diff' || persisted.fileTreeMode === 'browse'
        ? persisted.fileTreeMode
        : undefined,
    sidebarPanelId:
      typeof persisted.sidebarPanelId === 'string' &&
      STATUS_ITEM_ID_PATTERN.test(persisted.sidebarPanelId)
        ? persisted.sidebarPanelId
        : undefined,
    // The IPC schema checks panes already; this scrubs a hand-edited file.
    savedLayout: normalizeSavedLayout(persisted.savedLayout),
    recentLinks: normalizeRecentLinks(persisted.recentLinks),
    virtualDesktops: normalizeVirtualDesktops(persisted.virtualDesktops),
    // Only a workspace saved in the Trash is in it, so a hand-edited status never deletes one.
    status: inTrash ? 'trashed' : 'active',
    trashedAt: inTrash ? (persisted.trashedAt ?? Date.now()) : undefined,
    terminals,
    terminalLayout:
      backend?.kind === 'ssh'
        ? normalizePersistedTerminalLayout(
            persisted.terminalLayout,
            new Set(terminals.map((terminal) => terminal.id))
          )
        : undefined,
    primaryTerminalId: persistedPrimaryTerminalId,
    lastDynamicTitle: persisted.lastDynamicTitle,
    defaultActionId: persisted.defaultActionId,
    paneDefaultActionId: persisted.paneDefaultActionId,
    windowId: null, // Reset on startup - windows get new UUIDs each launch
    agentActive: false,
  };
  const terminalIds = new Set(terminals.map((terminal) => terminal.id));
  const agentSources = new Map<string, Map<WorkspaceAttentionSource, number>>();
  for (const terminal of persisted.terminals ?? []) {
    if (!terminalIds.has(terminal.id)) continue;
    agentSources.set(
      terminal.id,
      normalizePersistedActiveAgentSources(terminal.activeAgentSources)
    );
  }
  return { workspace, agentSources, runningAtQuit: persistedRunningAtQuit === true && !inTrash };
}

export type PersistedTerminalSources = ReturnType<TerminalAttention['persistedSources']>;

/**
 * What is saved of a workspace; `persistedSources` gives a Terminal's saved spinner sources, and
 * `runningAtQuit` marks a local workspace to offer to restart at the next launch.
 */
export function serializeWorkspace(
  w: Workspace,
  persistedSources: (workspaceId: string, terminalId: string) => PersistedTerminalSources,
  runningAtQuit = false
): PersistedWorkspace {
  const persistedTerminals = isSshWorkspace(w)
    ? w.terminals.filter((terminal) => isResumable(w, terminal))
    : [];
  const persistedTerminalIds = new Set(persistedTerminals.map((terminal) => terminal.id));
  return {
    _version: WORKSPACE_VERSION,
    id: w.id,
    name: w.name,
    customName: w.customName,
    customDescription: w.customDescription,
    customNameSource: w.customNameSource,
    customNameGeneratedAt: w.customNameGeneratedAt,
    promptSubmitsSinceCustomNameGeneration: w.promptSubmitsSinceCustomNameGeneration,
    workingDirectory: w.workingDirectory,
    backend: w.backend,
    lastKnownGitStatus: isSshWorkspace(w) ? w.lastKnownGitStatus : undefined,
    branchName: w.branchName,
    isWorktree: w.isWorktree,
    projectId: w.projectId,
    repoName: w.repoName,
    baseBranch: w.baseBranch,
    branchedFrom: w.branchedFrom,
    primaryTerminalId: persistedTerminalIds.has(w.primaryTerminalId ?? '')
      ? w.primaryTerminalId
      : persistedTerminals[0]?.id,
    lastDynamicTitle: w.lastDynamicTitle,
    terminals: isSshWorkspace(w)
      ? persistedTerminals.map((terminal) => ({
          id: terminal.id,
          name: terminal.name,
          dynamicTitle: terminal.dynamicTitle,
          createdAt: terminal.createdAt,
          layoutHint: terminal.layoutHint,
          setupStepId: terminal.setupStepId,
          executionLocation: 'workspace',
          remoteSessionActive: persistedRemoteSessionActive(terminal),
          attention: terminal.attention,
          lastAcceptedHookDeliveryId: terminal.lastAcceptedHookDeliveryId,
          lastJournalDeliveryId: terminal.lastJournalDeliveryId,
          activeAgentSources: persistedSources(w.id, terminal.id),
        }))
      : undefined,
    terminalLayout: isSshWorkspace(w)
      ? normalizePersistedTerminalLayout(w.terminalLayout, persistedTerminalIds)
      : undefined,
    windowId: w.windowId,
    categoryId: w.categoryId,
    createdAt: w.createdAt,
    lastActivityAt: w.lastActivityAt,
    lastStoppedAt: w.lastStoppedAt,
    runningAtQuit: runningAtQuit || undefined,
    order: w.order,
    unread: w.unread,
    pinned: w.pinned,
    tag: w.tag,
    tagSource: w.tag ? w.tagSource : undefined,
    tagTooltip: w.tag ? w.tagTooltip : undefined,
    pullRequestState: w.pullRequestState,
    snoozedUntil: w.snoozedUntil,
    wakesOnNotification: w.wakesOnNotification,
    needsAttention: isSshWorkspace(w) && w.needsAttention ? true : undefined,
    attention: isSshWorkspace(w) ? w.attention : undefined,
    status: w.status,
    trashedAt: w.trashedAt,
    promptSubmits: w.promptSubmits && w.promptSubmits.length > 0 ? w.promptSubmits : undefined,
    provisioning: w.provisioning || undefined,
    provisionStatus: w.provisioning ? w.provisionStatus : undefined,
    provisioningRepoPath: w.provisioningRepoPath,
    provisioningBranchCreated: w.provisioningBranchCreated,
    provisioningWorktreeCreated: w.provisioningWorktreeCreated,
    presetId: w.presetId,
    launchModeId: w.launchModeId,
    reasoningLevelId: w.reasoningLevelId || undefined,
    modelId: w.modelId || undefined,
    linkedWorkspaceIds:
      w.linkedWorkspaceIds && w.linkedWorkspaceIds.length > 0 ? w.linkedWorkspaceIds : undefined,
    fileTreeOpen: w.fileTreeOpen,
    fileTreeMode: w.fileTreeMode,
    sidebarPanelId: w.sidebarPanelId || undefined,
    savedLayout: w.savedLayout,
    recentLinks: w.recentLinks && w.recentLinks.length > 0 ? w.recentLinks : undefined,
    virtualDesktops:
      w.virtualDesktops && w.virtualDesktops.length > 0 ? w.virtualDesktops : undefined,
    color: w.color,
    defaultActionId: w.defaultActionId,
    paneDefaultActionId: w.paneDefaultActionId,
  };
}
