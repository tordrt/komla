import { MAX_STATUS_ICON_BYTES } from '../types/status-items';

import type { PullRequestSummary } from '../types/pull-request';
import type { Workspace } from '../types/workspace';

/** A workspace tag's color: one of the theme's tones. */
export const WORKSPACE_TAG_TONES = [
  'neutral',
  'info',
  'attention',
  'success',
  'warning',
  'error',
] as const;
export type WorkspaceTagTone = (typeof WORKSPACE_TAG_TONES)[number];

/** Where a pull request stands, for the tag that says so. */
export const PULL_REQUEST_TAG_STATES = ['in-review', 'needs-changes'] as const;
export type PullRequestTagState = (typeof PULL_REQUEST_TAG_STATES)[number];

/** A tag the user puts on workspaces to say why one waits, such as "Waiting for review". */
export interface WorkspaceTagDefinition {
  name: string;
  tone: WorkspaceTagTone;
  /** Komla puts this tag on a workspace whose pull request stands so, whatever its name. */
  pullRequestState?: PullRequestTagState;
  /** An image data URL shown in place of the tag glyph, its shape in the tag's color. */
  icon?: string;
  /** Shows a spinner in place of the glyph, for work under way such as CI running. */
  spinner?: boolean;
}

export const MAX_WORKSPACE_TAG_LENGTH = 40;
export const MAX_WORKSPACE_TAGS = 50;
/** The longest hover text a script gives one workspace's tag. */
export const MAX_WORKSPACE_TAG_TOOLTIP = 500;

const TAG_ICON = /^data:image\/(?:svg\+xml|png|webp|gif|jpeg);base64,[A-Za-z0-9+/]+=*$/;
const MAX_TAG_ICON_LENGTH = 64 + Math.ceil(MAX_STATUS_ICON_BYTES / 3) * 4;

/** A tag icon as saved: a base64 image data URL of at most a status item icon's size. */
export function isWorkspaceTagIcon(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_TAG_ICON_LENGTH && TAG_ICON.test(value);
}

/** The tags offered until the user changes the list; the first two also come from pull requests. */
export const DEFAULT_WORKSPACE_TAGS: readonly WorkspaceTagDefinition[] = [
  { name: 'In review', tone: 'info', pullRequestState: 'in-review' },
  { name: 'Needs changes', tone: 'warning', pullRequestState: 'needs-changes' },
  { name: 'Blocked', tone: 'error' },
  { name: 'On hold', tone: 'neutral' },
];

/** Hidden until the user shows them, so workspaces put on hold leave the list. */
export const DEFAULT_HIDDEN_WORKSPACE_TAGS: readonly string[] = [workspaceTagKey('On hold')];

/** A tag name as saved: trimmed, on one line, and short enough for the card's pill. */
export function normalizeWorkspaceTagName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_WORKSPACE_TAG_LENGTH).trim();
}

/** What tags of one name share whatever their case, such as in the sidebar's hidden tags. */
export function workspaceTagKey(name: string): string {
  return name.toLocaleLowerCase();
}

/** Stands for "no tag" where tags go by key. No tag name is empty, so none shares it. */
export const UNTAGGED_WORKSPACE_TAG_KEY = '';

/** The key of the workspace's tag, or the untagged key when it has none. */
export function workspaceTagKeyOf(workspace: Pick<Workspace, 'tag'>): string {
  return workspace.tag ? workspaceTagKey(workspace.tag) : UNTAGGED_WORKSPACE_TAG_KEY;
}

/** The tag of this name, whatever its case. */
export function findWorkspaceTag(
  tags: readonly WorkspaceTagDefinition[],
  name: string
): WorkspaceTagDefinition | undefined {
  const key = workspaceTagKey(name);
  return tags.find((tag) => workspaceTagKey(tag.name) === key);
}

/** A tag on some of the workspaces, as a filter offers it. */
export interface WorkspaceTagOption {
  key: string;
  name: string;
  tone: WorkspaceTagTone;
  count: number;
}

/**
 * The tags on these workspaces, in the tag list's order, with their workspace counts. A tag missing
 * from the list comes last, gray.
 */
export function getWorkspaceTagOptions(
  tags: readonly WorkspaceTagDefinition[],
  workspaces: readonly Pick<Workspace, 'tag'>[]
): WorkspaceTagOption[] {
  const options = new Map<string, WorkspaceTagOption>();
  for (const workspace of workspaces) {
    if (!workspace.tag) continue;
    const key = workspaceTagKey(workspace.tag);
    const option = options.get(key);
    if (option) option.count++;
    else {
      const tag = findWorkspaceTag(tags, workspace.tag);
      options.set(key, {
        key,
        name: tag?.name ?? workspace.tag,
        tone: tag?.tone ?? 'neutral',
        count: 1,
      });
    }
  }
  const order = new Map(tags.map((tag, index) => [workspaceTagKey(tag.name), index]));
  const rank = (key: string) => order.get(key) ?? tags.length;
  return [...options.values()].sort((a, b) => rank(a.key) - rank(b.key));
}

/** The list with a tag of this name, added with the new-tag defaults when it isn't there. */
export function withWorkspaceTag(
  tags: readonly WorkspaceTagDefinition[],
  name: string,
  added: Partial<Omit<WorkspaceTagDefinition, 'name'>> = {}
): readonly WorkspaceTagDefinition[] {
  // A full list stays as it is: dropping a tag to make room would take it off its workspaces.
  if (findWorkspaceTag(tags, name) || tags.length >= MAX_WORKSPACE_TAGS) return tags;
  const tag: WorkspaceTagDefinition = { name, tone: 'neutral', ...added };
  return [...tags, tag];
}

/** The saved tag list, or the defaults when it was never saved; scrubs a hand-edited file. */
export function normalizeWorkspaceTags(raw: unknown): WorkspaceTagDefinition[] {
  if (!Array.isArray(raw)) return DEFAULT_WORKSPACE_TAGS.map((tag) => ({ ...tag }));
  const tags: WorkspaceTagDefinition[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, tone, pullRequestState, icon, spinner } = entry as Record<string, unknown>;
    if (typeof name !== 'string') continue;
    const normalized = normalizeWorkspaceTagName(name);
    if (!normalized || findWorkspaceTag(tags, normalized)) continue;
    // One tag per pull request state: the first in the list.
    const state =
      PULL_REQUEST_TAG_STATES.includes(pullRequestState as PullRequestTagState) &&
      !tags.some((tag) => tag.pullRequestState === pullRequestState)
        ? (pullRequestState as PullRequestTagState)
        : undefined;
    tags.push({
      name: normalized,
      tone: WORKSPACE_TAG_TONES.includes(tone as WorkspaceTagTone)
        ? (tone as WorkspaceTagTone)
        : 'neutral',
      ...(state ? { pullRequestState: state } : {}),
      ...(isWorkspaceTagIcon(icon) ? { icon } : {}),
      ...(spinner === true ? { spinner } : {}),
    });
  }
  return tags.slice(0, MAX_WORKSPACE_TAGS);
}

/**
 * Where an open pull request waits: on a review, or on changes. Approved, merged, closed and draft
 * ones wait on neither, so their tag comes off.
 */
export function pullRequestTagState(
  pullRequest: PullRequestSummary | undefined
): PullRequestTagState | undefined {
  if (pullRequest?.state !== 'open' || pullRequest.review === 'approved') return undefined;
  return pullRequest.review === 'changes-requested' ? 'needs-changes' : 'in-review';
}

type TaggedWorkspace = Pick<Workspace, 'tag' | 'tagSource' | 'pullRequestState'>;

/**
 * What changes when a workspace's pull request stands somewhere, or nowhere: nothing while it
 * stands where it did last time, so a tag the user took off stays off, also through a rename. A
 * tag the user put on stays too. The tag is the one for that state, none if the user deleted it.
 */
export function pullRequestTagUpdate(
  workspace: TaggedWorkspace,
  state: PullRequestTagState | undefined,
  tags: readonly WorkspaceTagDefinition[]
): TaggedWorkspace | undefined {
  if (state === workspace.pullRequestState) return undefined;
  if (workspace.tag && workspace.tagSource !== 'pull-request') return { pullRequestState: state };
  const tag = state && tags.find((t) => t.pullRequestState === state)?.name;
  return { pullRequestState: state, tag, tagSource: tag ? 'pull-request' : undefined };
}
