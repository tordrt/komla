import { useConfigStore } from '@/stores/config.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  DEFAULT_WORKSPACE_TAGS,
  findWorkspaceTag,
  MAX_WORKSPACE_TAGS,
  normalizeWorkspaceTagName,
  withWorkspaceTag,
  workspaceTagKey,
  type PullRequestTagState,
  type WorkspaceTagDefinition,
  type WorkspaceTagTone,
} from '../../shared/lib/workspace-tags';

/** How each tone is named and drawn in tag pickers. Literal classes, so Tailwind sees them. */
export const WORKSPACE_TAG_TONE_LABELS: Record<WorkspaceTagTone, { label: string; dot: string }> = {
  neutral: { label: 'Gray', dot: 'bg-muted-foreground' },
  info: { label: 'Blue', dot: 'bg-info' },
  attention: { label: 'Violet', dot: 'bg-attention' },
  success: { label: 'Green', dot: 'bg-success' },
  warning: { label: 'Amber', dot: 'bg-warning' },
  error: { label: 'Red', dot: 'bg-error' },
};

/** When Komla puts each pull request tag on, as Settings says it under the tag. */
export const PULL_REQUEST_TAG_STATE_LABELS: Record<PullRequestTagState, string> = {
  'in-review': 'Added while its pull request waits for review',
  'needs-changes': 'Added when a reviewer requests changes',
};

/** What turning on tagging from pull requests does, naming the tags it puts on. */
export function pullRequestTaggingDescription(tags: readonly WorkspaceTagDefinition[]): string {
  const name = (state: PullRequestTagState) =>
    tags.find((tag) => tag.pullRequestState === state)?.name;
  const inReview = name('in-review');
  const needsChanges = name('needs-changes');
  const what = [
    inReview && `${inReview} while its GitHub pull request waits for review`,
    needsChanges && `${needsChanges} when a reviewer requests changes`,
  ].filter(Boolean);
  if (what.length === 0) {
    return 'The tags it would add were deleted, so it adds none.';
  }
  return `Tags a workspace ${what.join(', and ')}, and takes that tag off once the pull request is approved, merged or closed. Tags you add yourself stay. Uses the GitHub CLI (gh), every 5 minutes.`;
}

function currentTags(): readonly WorkspaceTagDefinition[] {
  return useConfigStore.getState().config?.workspaceTags ?? DEFAULT_WORKSPACE_TAGS;
}

export function useWorkspaceTags(): readonly WorkspaceTagDefinition[] {
  return useConfigStore((s) => s.config?.workspaceTags) ?? DEFAULT_WORKSPACE_TAGS;
}

/**
 * Saves the tag list, showing it at once, so a change made before the save returns builds on this
 * one instead of the list before it.
 */
export function saveWorkspaceTags(tags: readonly WorkspaceTagDefinition[]): void {
  const { config, updateConfig, loadConfig } = useConfigStore.getState();
  if (config) useConfigStore.setState({ config: { ...config, workspaceTags: [...tags] } });
  void updateConfig({ workspaceTags: [...tags] }).then(({ ok, error }) => {
    if (ok) return;
    useToastStore.getState().addToast(`Couldn't save the tags: ${error}`, 'error');
    void loadConfig();
  });
}

/**
 * Puts a tag on the workspaces. A name already in the list, in any case, is that tag; a new one
 * joins the list with `added`'s settings, unless the list is full.
 */
export function tagWorkspaces(
  workspaceIds: readonly string[],
  name: string,
  added?: Partial<Omit<WorkspaceTagDefinition, 'name'>>
): void {
  const normalized = normalizeWorkspaceTagName(name);
  if (!normalized) return;
  const tags = currentTags();
  const existing = findWorkspaceTag(tags, normalized);
  if (!existing && tags.length >= MAX_WORKSPACE_TAGS) {
    useToastStore
      .getState()
      .addToast(
        `You have ${MAX_WORKSPACE_TAGS} tags already. Delete one in Settings first.`,
        'error'
      );
    return;
  }
  if (!existing) saveWorkspaceTags(withWorkspaceTag(tags, normalized, added));
  useWorkspacesStore.getState().setTag(workspaceIds, existing?.name ?? normalized);
}

/** Changes a tag in the list; a new name carries over to the workspaces that have it. */
export function updateWorkspaceTag(
  name: string,
  changes: Partial<WorkspaceTagDefinition>
): { error?: string } {
  const tags = currentTags();
  const tag = findWorkspaceTag(tags, name);
  if (!tag) return {};
  const renamed = changes.name !== undefined ? normalizeWorkspaceTagName(changes.name) : tag.name;
  if (!renamed) return { error: 'Name the tag.' };
  const clash = findWorkspaceTag(tags, renamed);
  if (clash && clash !== tag) return { error: `There's a ${clash.name} tag already.` };
  saveWorkspaceTags(tags.map((t) => (t === tag ? { ...tag, ...changes, name: renamed } : t)));
  if (renamed !== tag.name) {
    retagWorkspaces(tag.name, renamed);
    useWorkspacesStore.getState().moveHiddenWorkspaceTag(tag.name, renamed);
  }
  return {};
}

/** Takes a tag out of the list and off every workspace that has it. */
export function deleteWorkspaceTag(name: string): void {
  const tags = currentTags();
  const tag = findWorkspaceTag(tags, name);
  if (!tag) return;
  saveWorkspaceTags(tags.filter((t) => t !== tag));
  retagWorkspaces(tag.name, undefined);
  useWorkspacesStore.getState().moveHiddenWorkspaceTag(tag.name, undefined);
}

/** Moves the workspaces that have a tag to another, each keeping where its tag came from. */
function retagWorkspaces(from: string, to: string | undefined): void {
  const key = workspaceTagKey(from);
  const tagged = useWorkspacesStore
    .getState()
    .workspaces.filter((workspace) => workspace.tag && workspaceTagKey(workspace.tag) === key);
  for (const source of [undefined, 'pull-request'] as const) {
    const ids = tagged.filter((w) => w.tagSource === source).map((w) => w.id);
    if (ids.length > 0) useWorkspacesStore.getState().setTag(ids, to, source);
  }
}
