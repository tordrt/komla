import {
  normalizeWorkspaceTagName,
  workspaceTagAppearance,
  workspaceTagKey,
  type WorkspaceTagAppearance,
  type WorkspaceTagDefinition,
  type WorkspaceTagTone,
} from './workspace-tags';

import type { Workspace } from '../types/workspace';

/**
 * Work under way in a workspace that a script shows, such as "CI running", with a spinner in its
 * tag's place. It isn't one of the user's tags: it never joins their list or a filter, it leaves
 * the workspace's tag be, and it isn't saved, so it ends with Komla.
 */
export interface WorkspaceProgress {
  label: string;
  tone: WorkspaceTagTone;
  /** What the script says about it, shown on hover. */
  tooltip?: string;
}

/** A progress label as shown: trimmed, on one line, and as short as a tag's name. */
export const normalizeWorkspaceProgressLabel = normalizeWorkspaceTagName;

/** Whether the workspace shows progress of this label, whatever its case. */
export function showsWorkspaceProgress(
  workspace: Pick<Workspace, 'progress'>,
  label: string
): boolean {
  return (
    workspace.progress !== undefined &&
    workspaceTagKey(workspace.progress.label) === workspaceTagKey(label)
  );
}

/** Whether two progresses look the same, as a fresh copy of one from main does. */
export function sameWorkspaceProgress(
  a: WorkspaceProgress | undefined,
  b: WorkspaceProgress | undefined
): boolean {
  return a?.label === b?.label && a?.tone === b?.tone && a?.tooltip === b?.tooltip;
}

/**
 * What the workspace's card shows in its tag's place, for a device without the tag list: its
 * progress, spinning, or else its tag.
 */
export function workspaceCardTagAppearance(
  tags: readonly WorkspaceTagDefinition[],
  workspace: Pick<Workspace, 'tag' | 'progress'>
): WorkspaceTagAppearance | undefined {
  if (workspace.progress) {
    const { label, tone } = workspace.progress;
    return { name: label, tone, spinner: true };
  }
  return workspace.tag ? workspaceTagAppearance(tags, workspace.tag) : undefined;
}
