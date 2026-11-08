import { STATUS_ITEM_ID_PATTERN } from '../types/status-items';

import {
  MAX_WORKSPACE_TAG_TOOLTIP,
  normalizeWorkspaceTagName,
  WORKSPACE_TAG_TONES,
  workspaceTagAppearance,
  workspaceTagKey,
  type WorkspaceTagAppearance,
  type WorkspaceTagDefinition,
  type WorkspaceTagTone,
} from './workspace-tags';

import type { Workspace } from '../types/workspace';

/**
 * Text a script shows on one workspace's card, such as "PR #12". It isn't one of the
 * user's tags: it never joins their list or a filter, and it leaves the workspace's tag be. It's
 * saved with the workspace, except one with a spinner, which is work under way and ends with Komla.
 */
export interface WorkspaceMarker {
  /** The script's name for it, so one script's marker never replaces another's. */
  key: string;
  label: string;
  tone: WorkspaceTagTone;
  /** What the script says about it, shown on hover. */
  tooltip?: string;
  /** Work under way, such as CI running: Workspace Progress. */
  spinner?: true;
}

/**
 * Keeps the card readable; a script that wants more says so in one marker's tooltip. Progress has
 * its own place beside these.
 */
export const MAX_WORKSPACE_MARKERS = 5;

/** A marker's key: as a status item's id, up to 40 letters, digits, dots, dashes and underscores. */
export const WORKSPACE_MARKER_KEY_PATTERN = STATUS_ITEM_ID_PATTERN;

/** The marker `komla progress` shows. */
export const PROGRESS_MARKER_KEY = 'progress';

/** A marker's label as shown: trimmed, on one line, and as short as a tag's name. */
export const normalizeWorkspaceMarkerLabel = normalizeWorkspaceTagName;

export function findWorkspaceMarker(
  workspace: Pick<Workspace, 'markers'>,
  key: string
): WorkspaceMarker | undefined {
  return workspace.markers?.find((marker) => marker.key === key);
}

/** Whether the marker shows this label, whatever its case. */
export function markerShows(marker: WorkspaceMarker | undefined, label: string): boolean {
  return marker !== undefined && workspaceTagKey(marker.label) === workspaceTagKey(label);
}

/** The progress `komla progress` shows on the workspace: its marker under the `progress` key. */
export function workspaceProgress(
  workspace: Pick<Workspace, 'markers'>
): WorkspaceMarker | undefined {
  return findWorkspaceMarker(workspace, PROGRESS_MARKER_KEY);
}

/** Whether the workspace shows progress of this label, whatever its case. */
export function showsWorkspaceProgress(
  workspace: Pick<Workspace, 'markers'>,
  label: string
): boolean {
  return markerShows(workspaceProgress(workspace), label);
}

/**
 * The markers with this one put on: in the place of the one with its key, or after the rest. No
 * markers is `undefined`, as a workspace without any saves none.
 */
export function withWorkspaceMarker(
  markers: readonly WorkspaceMarker[] | undefined,
  marker: WorkspaceMarker
): WorkspaceMarker[] {
  const list = markers ?? [];
  return list.some((existing) => existing.key === marker.key)
    ? list.map((existing) => (existing.key === marker.key ? marker : existing))
    : [...list, marker];
}

export function withoutWorkspaceMarker(
  markers: readonly WorkspaceMarker[] | undefined,
  key: string
): WorkspaceMarker[] | undefined {
  const rest = (markers ?? []).filter((marker) => marker.key !== key);
  return rest.length > 0 ? rest : undefined;
}

/** The markers in the order the card shows them: work under way first, then the rest. */
export function shownWorkspaceMarkers(
  markers: readonly WorkspaceMarker[] | undefined
): WorkspaceMarker[] {
  if (!markers) return [];
  return [
    ...markers.filter((marker) => marker.spinner),
    ...markers.filter((marker) => !marker.spinner),
  ];
}

function sameWorkspaceMarker(a: WorkspaceMarker, b: WorkspaceMarker): boolean {
  return (
    a.key === b.key &&
    a.label === b.label &&
    a.tone === b.tone &&
    a.tooltip === b.tooltip &&
    a.spinner === b.spinner
  );
}

/** Whether two workspaces' markers look the same, as a fresh copy of them from main does. */
export function sameWorkspaceMarkers(
  a: readonly WorkspaceMarker[] | undefined,
  b: readonly WorkspaceMarker[] | undefined
): boolean {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length && left.every((marker, i) => sameWorkspaceMarker(marker, right[i]))
  );
}

/** The markers a workspace saves: those without a spinner, as work under way ends with Komla. */
export function savedWorkspaceMarkers(
  markers: readonly WorkspaceMarker[] | undefined
): WorkspaceMarker[] | undefined {
  const saved = (markers ?? []).filter((marker) => !marker.spinner);
  return saved.length > 0 ? saved : undefined;
}

/** The saved markers, scrubbed as a hand-edited file might need. */
export function normalizePersistedWorkspaceMarkers(raw: unknown): WorkspaceMarker[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const markers: WorkspaceMarker[] = [];
  for (const entry of raw) {
    if (markers.length >= MAX_WORKSPACE_MARKERS) break;
    const marker = persistedWorkspaceMarker(entry);
    if (marker && !markers.some((other) => other.key === marker.key)) markers.push(marker);
  }
  return markers.length > 0 ? markers : undefined;
}

/** One saved marker, or `undefined` for one Komla wouldn't have saved. */
function persistedWorkspaceMarker(entry: unknown): WorkspaceMarker | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const { key, label, tone, tooltip } = entry as Record<string, unknown>;
  if (typeof key !== 'string' || !WORKSPACE_MARKER_KEY_PATTERN.test(key)) return undefined;
  // Progress ends with Komla, so a saved one is a hand-edited file's.
  if (key === PROGRESS_MARKER_KEY) return undefined;
  const normalized = typeof label === 'string' ? normalizeWorkspaceMarkerLabel(label) : '';
  if (!normalized) return undefined;
  const text = typeof tooltip === 'string' ? tooltip.slice(0, MAX_WORKSPACE_TAG_TOOLTIP) : '';
  return {
    key,
    label: normalized,
    tone: WORKSPACE_TAG_TONES.includes(tone as WorkspaceTagTone)
      ? (tone as WorkspaceTagTone)
      : 'neutral',
    ...(text && { tooltip: text }),
  };
}

/**
 * What the workspace's card shows in its tag's place, for a device without the tag list or
 * markers: its first progress, spinning, or else its tag.
 */
export function workspaceCardTagAppearance(
  tags: readonly WorkspaceTagDefinition[],
  workspace: Pick<Workspace, 'tag' | 'markers'>
): WorkspaceTagAppearance | undefined {
  const progress = workspace.markers?.find((marker) => marker.spinner);
  if (progress) return { name: progress.label, tone: progress.tone, spinner: true };
  return workspace.tag ? workspaceTagAppearance(tags, workspace.tag) : undefined;
}
