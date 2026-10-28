import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import { isResumable } from '../../../shared/lib/terminal-execution-state';
import {
  isSshWorkspace,
  type Workspace,
  type WorkspaceTerminalLayout,
} from '../../../shared/types/workspace';

import {
  normalizePersistedTerminalLayout,
  terminalArrangement,
  terminalLayoutLeaves,
  withTerminalTabs,
} from './terminal-layout';

import type {
  SshWorkspaceLaunch,
  SshWorkspaceManifest,
} from '../../../shared/types/ssh-workspace-manifest';

export const SSH_WORKSPACE_MANIFEST_DIRECTORY = 'workspaces';
/** Under the manifest directory: one empty file per workspace a Komla installation deleted. */
export const SSH_WORKSPACE_TOMBSTONE_DIRECTORY = 'deleted';
export const SSH_WORKSPACE_TOMBSTONE_RETENTION_DAYS = 30;
export const MAX_SSH_WORKSPACE_MANIFEST_BYTES = 256 * 1024;

/**
 * What a host holds for a workspace: its files, with the current manifest
 * text if there is one, or why they are gone. `deleted` means a Komla
 * installation deleted it and left a tombstone.
 */
export type SshWorkspaceOnHost =
  | { state: 'present'; manifest?: string }
  | { state: 'missing' }
  | { state: 'deleted' };

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isSshWorkspaceManifestId(value: string): boolean {
  return WORKSPACE_ID_PATTERN.test(value);
}

const optionalString = z.string().max(4096).optional();

const manifestSchema = z.object({
  schema: z.literal(1),
  workspaceId: z.string().regex(WORKSPACE_ID_PATTERN),
  name: z.string().max(4096),
  customName: optionalString,
  customDescription: optionalString,
  customNameSource: z.enum(['generated', 'manual']).optional(),
  branchName: optionalString,
  baseBranch: optionalString,
  repoName: optionalString,
  backend: z.object({
    remoteDirectory: z.string().min(1).max(4096),
    remoteRepoPath: z.string().min(1).max(4096),
    remoteProjectRoot: z.string().min(1).max(4096),
    gitUrl: z.string().max(4096),
    projectName: optionalString,
    branchName: optionalString,
    checkoutExistingBranch: z.boolean().optional(),
    baseBranch: optionalString,
    defaultBranch: optionalString,
    startPoint: optionalString,
  }),
  terminals: z
    .array(
      z.object({
        id: z.string().regex(WORKSPACE_ID_PATTERN),
        name: z.string().max(4096),
        createdAt: z.number().finite(),
        layoutHint: z.enum(['tab', 'split-right', 'split-bottom']).optional(),
      })
    )
    .max(256),
  primaryTerminalId: optionalString,
  // The adopting installation validates layout structure while hydrating.
  terminalLayout: z
    .object({
      activeTab: optionalString,
      tabs: z.array(z.string()),
      layouts: z.record(z.string(), z.unknown()),
    })
    .optional(),
  status: z.enum(['active', 'trashed']).optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  writtenBy: z.string().max(128).optional(),
  syncs: z.boolean().optional(),
  syncsLayout: z.boolean().optional(),
  launch: z
    .object({
      agentName: z.string().max(4096),
      promptCommand: z.string().min(1).max(16_384),
      openCommand: z.string().min(1).max(16_384),
      continueCommand: z.string().min(1).max(16_384).optional(),
    })
    .optional(),
  sourceWorkspaceId: z.string().regex(WORKSPACE_ID_PATTERN).optional(),
  adoptOnConnect: z.boolean().optional(),
});

/** Returns the manifest another installation needs to adopt `workspace`, if it has one. */
export function buildSshWorkspaceManifest(
  workspace: Workspace,
  updatedAt: number,
  launch?: SshWorkspaceLaunch,
  writtenBy?: string,
  syncs?: boolean
): SshWorkspaceManifest | undefined {
  if (!isSshWorkspace(workspace) || workspace.provisioning || workspace.provisionError) {
    return undefined;
  }
  const { remoteDirectory, remoteRepoPath, remoteProjectRoot, gitUrl } = workspace.backend;
  const terminals = workspace.terminals
    .filter((terminal) => isResumable(workspace, terminal))
    .map((terminal) => ({
      id: terminal.id,
      name: terminal.name,
      createdAt: terminal.createdAt,
      ...(terminal.layoutHint ? { layoutHint: terminal.layoutHint } : {}),
    }));
  return {
    schema: 1,
    workspaceId: workspace.id,
    name: workspace.name,
    customName: workspace.customName,
    customDescription: workspace.customDescription,
    customNameSource: workspace.customNameSource,
    branchName: workspace.branchName,
    baseBranch: workspace.baseBranch,
    repoName: workspace.repoName,
    backend: {
      remoteDirectory,
      remoteRepoPath,
      remoteProjectRoot,
      gitUrl,
      projectName: workspace.backend.projectName,
      branchName: workspace.backend.branchName,
      checkoutExistingBranch: workspace.backend.checkoutExistingBranch,
      baseBranch: workspace.backend.baseBranch,
      defaultBranch: workspace.backend.defaultBranch,
      startPoint: workspace.backend.startPoint,
    },
    terminals,
    primaryTerminalId: terminals.some((terminal) => terminal.id === workspace.primaryTerminalId)
      ? workspace.primaryTerminalId
      : terminals[0]?.id,
    terminalLayout: workspace.terminalLayout,
    status: workspace.status,
    createdAt: workspace.createdAt,
    updatedAt,
    ...(writtenBy ? { writtenBy } : {}),
    ...(syncs ? { syncs, syncsLayout: syncs } : {}),
    ...(launch ? { launch } : {}),
  };
}

/**
 * Identifies manifest content that matters to another installation, ignoring
 * who wrote it and when.
 */
export function sshWorkspaceManifestContentKey(manifest: SshWorkspaceManifest): string {
  return JSON.stringify(withSortedKeys({ ...manifest, updatedAt: 0, writtenBy: undefined }));
}

/** Parsing a manifest reorders its keys, so the same content must compare equal in any order. */
function withSortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withSortedKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, withSortedKeys((value as Record<string, unknown>)[key])])
  );
}

/**
 * The fields installations reconcile with each other. The tab shown, panes only
 * one installation has, launch commands and the like stay per installation, so
 * differences in them never cause a write in response to another installation's.
 */
export function sshWorkspaceManifestSyncedFieldsEqual(
  local: SshWorkspaceManifest,
  remote: SshWorkspaceManifest
): boolean {
  // Installations that predate status don't write one.
  const status = remote.status !== undefined;
  // Nor do ones that predate layout sync keep theirs in step. A tab one hasn't placed yet, e.g.
  // opened moments before it wrote, may have any place in the other.
  const placed = remote.syncsLayout
    ? intersection(placedTerminalIds(local), placedTerminalIds(remote))
    : undefined;
  const synced = (manifest: SshWorkspaceManifest) => ({
    name: manifest.name,
    customName: manifest.customName,
    customDescription: manifest.customDescription,
    status: status ? manifest.status : undefined,
    terminals: manifest.terminals
      .map(({ id, name }) => ({ id, name }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    layout: placed && terminalArrangement(manifest.terminalLayout, placed),
  });
  return isDeepStrictEqual(synced(local), synced(remote));
}

/** The agent tabs a manifest's layout gives a place. */
function placedTerminalIds(manifest: SshWorkspaceManifest | undefined): Set<string> {
  if (!manifest?.terminalLayout) return new Set();
  const ids = new Set(manifest.terminals.map((terminal) => terminal.id));
  return new Set(
    terminalLayoutLeaves(manifest.terminalLayout)
      .map((leaf) => leaf.terminalId)
      .filter((terminalId) => ids.has(terminalId))
  );
}

function intersection(a: Set<string>, b: Set<string>): Set<string> {
  return new Set([...a].filter((value) => b.has(value)));
}

/**
 * Whether `remote` arranged its agent tabs differently from `base`, placing
 * new ones included. Panes only it has and tabs it closed don't count.
 */
function rearrangedRemotely(
  base: SshWorkspaceManifest | undefined,
  remote: SshWorkspaceManifest
): boolean {
  const placed = placedTerminalIds(remote);
  return !isDeepStrictEqual(
    terminalArrangement(remote.terminalLayout, placed),
    terminalArrangement(base?.terminalLayout, placed)
  );
}

/**
 * Whether this installation arranged its agent tabs differently from `base`,
 * e.g. while the host was unreachable or before its write landed. Tabs the
 * base lists without a place may have any place here.
 */
function rearrangedHere(base: SshWorkspaceManifest | undefined, local: SshWorkspaceManifest) {
  const placedInBase = placedTerminalIds(base);
  const unplacedInBase = new Set(
    base?.terminals.map((terminal) => terminal.id).filter((id) => !placedInBase.has(id))
  );
  const ids = new Set(
    local.terminals.map((terminal) => terminal.id).filter((id) => !unplacedInBase.has(id))
  );
  return !isDeepStrictEqual(
    terminalArrangement(local.terminalLayout, ids),
    terminalArrangement(base?.terminalLayout, ids)
  );
}

/**
 * This installation's layout after a merge. It takes the other installation's
 * arrangement when that one rearranged its tabs since `base` and this one
 * didn't; panes only this installation has then follow as tabs of their own.
 * Otherwise this one's stays, and the other's new tabs join it as tabs.
 */
function mergeTerminalLayout(
  base: SshWorkspaceManifest | undefined,
  local: SshWorkspaceManifest,
  remote: SshWorkspaceManifest,
  terminals: SshWorkspaceManifest['terminals'],
  added: SshWorkspaceManifest['terminals']
): { terminalLayout?: WorkspaceTerminalLayout; arranged: boolean } {
  const own = local.terminalLayout;
  const arranged =
    remote.syncsLayout === true &&
    rearrangedRemotely(base, remote) &&
    (!own || !rearrangedHere(base, local));
  let layout = own;
  if (arranged) {
    // Without the tabs closed here, or the tab it shows.
    const theirs = normalizePersistedTerminalLayout(
      remote.terminalLayout,
      new Set(terminals.map((terminal) => terminal.id))
    );
    layout = withTerminalTabs(
      { tabs: theirs?.tabs ?? [], layouts: theirs?.layouts ?? {} },
      own ? terminalLayoutLeaves(own) : []
    );
    if (own?.activeTab && layout.tabs.includes(own.activeTab)) {
      layout = { ...layout, activeTab: own.activeTab };
    }
  }
  // Without a saved layout here, the renderer lays out every terminal itself.
  const withAdded =
    layout &&
    withTerminalTabs(
      layout,
      added.map(({ id }) => ({ type: 'leaf', id: `pane-${id}`, terminalId: id }))
    );
  return { terminalLayout: withAdded?.tabs.length ? withAdded : undefined, arranged };
}

/** A merged manifest, and whether it took the other installation's arrangement of tabs. */
export interface SshWorkspaceManifestMerge {
  manifest: SshWorkspaceManifest;
  arranged: boolean;
}

/**
 * Three-way merges another installation's copy of a workspace into this one's.
 * A field the other installation changed since `base`, the copy last known to
 * be on the host, takes its value; every other field keeps the local one. Its
 * new agent tabs are added and its renames applied. Tabs it closed stay: the
 * caller first removes the ones tmux confirms ended. Its arrangement of the
 * tabs replaces this one's if only it rearranged them.
 */
export function mergeSshWorkspaceManifest(
  base: SshWorkspaceManifest | undefined,
  local: SshWorkspaceManifest,
  remote: SshWorkspaceManifest
): SshWorkspaceManifestMerge {
  const changedRemotely = <T>(theirs: T, before: T | undefined) =>
    !isDeepStrictEqual(theirs, before);
  const pick = <K extends 'name' | 'customName' | 'customDescription'>(key: K) =>
    changedRemotely(remote[key], base?.[key]) ? remote[key] : local[key];
  // Whether a name was generated moves with it, so a rename made elsewhere isn't regenerated here.
  const customNameSource = changedRemotely(remote.customName, base?.customName)
    ? remote.customNameSource
    : local.customNameSource;

  const baseTerminals = new Map(base?.terminals.map((terminal) => [terminal.id, terminal]));
  const remoteTerminals = new Map(remote.terminals.map((terminal) => [terminal.id, terminal]));
  const localIds = new Set(local.terminals.map((terminal) => terminal.id));
  const terminals = local.terminals.map((terminal) => {
    const theirs = remoteTerminals.get(terminal.id);
    return theirs && changedRemotely(theirs.name, baseTerminals.get(terminal.id)?.name)
      ? { ...terminal, name: theirs.name }
      : terminal;
  });
  // A tab the base already had but this installation lacks was closed here.
  const added = remote.terminals.filter(
    (terminal) => !localIds.has(terminal.id) && !baseTerminals.has(terminal.id)
  );
  terminals.push(...added);

  const { terminalLayout, arranged } = mergeTerminalLayout(base, local, remote, terminals, added);

  // A base without a status, e.g. on the first sync after updating, can't tell a change from
  // installations that disagreed before syncing. Settling on active never stops agents or
  // hides one.
  const statusChanged =
    remote.status !== undefined &&
    (base?.status === undefined ? remote.status === 'active' : remote.status !== base.status);

  return {
    manifest: {
      ...local,
      name: pick('name'),
      customName: pick('customName'),
      customDescription: pick('customDescription'),
      customNameSource,
      status: statusChanged ? remote.status : local.status,
      terminals,
      terminalLayout,
    },
    arranged,
  };
}

/** Parses a manifest read from a host. The file is untrusted, so invalid content yields undefined. */
export function parseSshWorkspaceManifest(text: string): SshWorkspaceManifest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return validSshWorkspaceManifest(value);
}

/** Returns `value` if it is a valid manifest, e.g. one parsed from a host's file or saved locally. */
export function validSshWorkspaceManifest(value: unknown): SshWorkspaceManifest | undefined {
  const parsed = manifestSchema.safeParse(value);
  return parsed.success ? (parsed.data as SshWorkspaceManifest) : undefined;
}
