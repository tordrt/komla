import {
  isWorkspaceAttentionActionable,
  pickWorkspaceAttention,
  showsWorking,
  type Terminal,
  type Workspace,
  type WorkspaceAttention,
} from '@/types';

import type { BadgeTone } from '@/components/ui/badge';
import type { CSSProperties } from 'react';

export interface WorkspaceAttentionAppearance {
  label: string;
  body?: string;
  tooltip: string;
  /** The notification card's first line: a custom title, or what happened. */
  heading: string;
  /** Everything the agent or hook said, for the card under the heading. */
  detail?: string;
  badgeClassName: string;
  badgeStyle?: CSSProperties;
  dotClassName: string;
  borderColor: string;
  borderOpacity?: number;
  /** Tone for a soft `<Badge>` status pill: input and error stand out by hue, not by a solid fill. */
  tone: BadgeTone;
}

export interface TabAttentionDisplay {
  showSpinner: boolean;
  /** The spinner is only for commands run with `komla notify --`. */
  commandsOnly?: boolean;
  attention: WorkspaceAttention | undefined;
}

// A tab keeps a prompt or error badge until the notified terminal is actually
// focused. Visibility alone is not enough: split panes can show several
// terminals while only one is the user's current context. A done, idle or
// notice on a pane in view is seen instead, and leaves the badge (`seen`).
// Actionable attention (a prompt/error) wins over informational attention so a
// done/idle terminal in the same tab can't mask one that needs the user, and
// done wins over idle.
export function getTabAttentionDisplay(
  tabTerminals: Terminal[],
  contentVisible: boolean,
  focusedTerminalId?: string | null
): TabAttentionDisplay {
  if (contentVisible && !focusedTerminalId) {
    return { showSpinner: false, attention: undefined };
  }

  const terminalsWithUnfocusedAttention = tabTerminals.filter(
    (terminal) => terminal.id !== focusedTerminalId
  );
  const working = tabTerminals.filter((terminal) => !!terminal.agentActive);
  const attention = pickWorkspaceAttention(
    terminalsWithUnfocusedAttention.map((terminal) => terminal.attention)
  );
  const commandsOnly = working.length > 0 && working.every((terminal) => !!terminal.commandActive);
  return {
    showSpinner: contentVisible ? false : working.length > 0,
    ...(commandsOnly && { commandsOnly }),
    attention,
  };
}

// The tab's status dot and spinner are color/motion only, so its tooltip and
// accessible name spell the status out.
export function getTerminalTabLabel(
  tabName: string,
  attentionAppearance: Pick<WorkspaceAttentionAppearance, 'tooltip'> | null,
  showSpinner: boolean,
  commandsOnly = false
): string {
  const spinnerStatus = commandsOnly ? 'Command running' : 'Agent processing';
  const status = attentionAppearance?.tooltip ?? (showSpinner ? spinnerStatus : null);
  return status ? `${tabName} — ${status}` : tabName;
}

export interface AttentionDeliveryContext {
  currentWindowId: string;
  ownerWindowId: string | null | undefined;
  openWindows: { id: string; displayNumber: number }[];
  isSelected: boolean;
  windowFocused: boolean;
  previewFullscreen: boolean;
  focusedTerminalId: string | null;
  /** The user was away from the computer when the attention arrived. */
  userAway?: boolean;
  /** The workspace is snoozed: attention that doesn't wake it plays no sound. */
  snoozed?: boolean;
}

export interface AttentionDelivery {
  action: 'set' | 'clear-workspace';
  playSound: boolean;
  /** Shown on what the user is looking at: it stays until their next input shows they're there. */
  awaitReturn?: boolean;
}

function getFirstWindowId(windows: AttentionDeliveryContext['openWindows']): string | undefined {
  let first = windows[0];
  for (const w of windows) if (w.displayNumber < first.displayNumber) first = w;
  return first?.id;
}

// Every window receives attention events so badges stay in sync, but only one
// window plays the sound: the workspace's owner, or the first open window when
// the owner is unknown or closed (none until the window list loads). A focused terminal only counts as seen while
// the window itself has OS focus, and only once the user's input shows they're at the computer.
export function resolveAttentionDelivery(
  attention: WorkspaceAttention,
  ctx: AttentionDeliveryContext
): AttentionDelivery {
  const isSoundWindow =
    ctx.ownerWindowId === ctx.currentWindowId ||
    (!ctx.openWindows.some((w) => w.id === ctx.ownerWindowId) &&
      getFirstWindowId(ctx.openWindows) === ctx.currentWindowId);
  // A snoozed workspace stays quiet; what wakes it is heard.
  const playSound = isSoundWindow && !(ctx.snoozed && !isWorkspaceAttentionActionable(attention));

  if (!ctx.isSelected || !ctx.windowFocused) {
    return { action: 'set', playSound };
  }
  if (
    attention.terminalId &&
    (ctx.previewFullscreen || ctx.focusedTerminalId !== attention.terminalId)
  ) {
    return { action: 'set', playSound };
  }
  // A focused window on a locked or idle computer shows the workspace to nobody.
  if (ctx.userAway) {
    return { action: 'set', playSound, awaitReturn: true };
  }
  if (!attention.terminalId) {
    return { action: 'clear-workspace', playSound };
  }
  // The user may have stepped away from the pane they left focused, so its attention waits for them.
  return { action: 'set', playSound: false, awaitReturn: true };
}

type ToneAppearance = Pick<
  WorkspaceAttentionAppearance,
  'badgeClassName' | 'dotClassName' | 'borderColor' | 'borderOpacity' | 'tone'
>;

// How each tone looks, following the theme. A notification's `color` can name one to look like
// Komla's own.
const TONE_APPEARANCES: Record<string, ToneAppearance> = {
  success: {
    badgeClassName: 'bg-success/15 text-success ring-1 ring-success/30',
    dotClassName: 'bg-success',
    borderColor: 'oklch(var(--success))',
    tone: 'success',
  },
  warning: {
    badgeClassName: 'bg-warning/15 text-warning ring-1 ring-warning/30',
    dotClassName: 'bg-warning',
    borderColor: 'oklch(var(--warning))',
    tone: 'warning',
  },
  error: {
    badgeClassName: 'bg-error/15 text-error ring-1 ring-error/30',
    dotClassName: 'bg-error',
    borderColor: 'oklch(var(--error))',
    tone: 'error',
  },
  info: {
    badgeClassName: 'bg-info/15 text-info ring-1 ring-info/30',
    dotClassName: 'bg-info',
    borderColor: 'oklch(var(--info))',
    tone: 'info',
  },
  attention: {
    badgeClassName: 'bg-attention/15 text-attention ring-1 ring-attention/30',
    dotClassName: 'bg-attention',
    borderColor: 'oklch(var(--attention))',
    tone: 'attention',
  },
  muted: {
    badgeClassName: 'bg-muted text-muted-foreground ring-1 ring-border',
    dotClassName: 'bg-muted-foreground/60',
    borderColor: 'oklch(var(--muted-foreground) / 0.6)',
    borderOpacity: 0.85,
    tone: 'neutral',
  },
};

export function getWorkspaceAttentionAppearance(
  attention: WorkspaceAttention | undefined
): WorkspaceAttentionAppearance | null {
  if (!attention) return null;

  let appearance: Omit<WorkspaceAttentionAppearance, 'heading' | 'detail'>;
  switch (attention.kind) {
    case 'input-required':
      appearance = {
        label: 'Input',
        tooltip: 'Agent needs your input',
        ...TONE_APPEARANCES.attention,
      };
      break;
    case 'turn-complete':
      appearance = { label: 'Done', tooltip: 'Agent finished a turn', ...TONE_APPEARANCES.success };
      break;
    case 'error':
      appearance = {
        label: 'Error',
        tooltip: 'Agent reported an error',
        ...TONE_APPEARANCES.error,
      };
      break;
    case 'idle':
      appearance = { label: 'Idle', tooltip: 'Agent is idle', ...TONE_APPEARANCES.muted };
      break;
    case 'generic':
    default:
      appearance = {
        label: 'Notice',
        tooltip: 'Workspace has a notification',
        ...TONE_APPEARANCES.muted,
        // Quieter than an idle reminder: no ring.
        badgeClassName: 'bg-muted text-muted-foreground',
      };
      break;
  }

  const title = attention.title?.trim() || undefined;
  const explicitBody = attention.body?.trim() || undefined;
  const message = attention.message?.trim();
  const usesMessageAsLabel = !title && attention.kind === 'generic' && !!message;
  const name = title ?? (usesMessageAsLabel ? message : appearance.label);
  const tooltipDetail = explicitBody ?? (usesMessageAsLabel ? undefined : message);
  const tooltip = tooltipDetail
    ? `${name}: ${tooltipDetail}`
    : title || usesMessageAsLabel
      ? name
      : appearance.tooltip;
  const color = attention.color?.trim() || undefined;
  // Own keys only: a color such as "constructor" isn't a tone.
  const toneAppearance =
    color && Object.hasOwn(TONE_APPEARANCES, color) ? TONE_APPEARANCES[color] : undefined;

  return {
    ...appearance,
    label: attention.badge?.trim() || name,
    body: explicitBody,
    tooltip,
    heading: title ?? appearance.tooltip,
    detail: explicitBody ?? (message || undefined),
    ...(toneAppearance
      ? { borderOpacity: undefined, ...toneAppearance }
      : color
        ? {
            badgeStyle: { backgroundColor: color },
            borderColor: color,
          }
        : {}),
  };
}

/** The source of the attention an unread mark shows as; a woken snooze's has its own glyph. */
export const UNREAD_ATTENTION_SOURCE = 'unread';
export const SNOOZE_ATTENTION_SOURCE = 'snooze';

/**
 * A workspace's unread mark as a card badge: marked by hand, it reads Done, as an agent's
 * finished turn would; back from a snooze, it reads Woke.
 */
export function getUnreadBadge(
  workspace: Workspace
): { attention: WorkspaceAttention; appearance: WorkspaceAttentionAppearance } | undefined {
  const unread = workspace.unread;
  if (!unread) return undefined;
  if (unread.reason === 'snooze-ended') {
    const attention: WorkspaceAttention = {
      kind: 'generic',
      source: SNOOZE_ATTENTION_SOURCE,
      updatedAt: unread.at,
    };
    return {
      attention,
      appearance: {
        ...getWorkspaceAttentionAppearance(attention)!,
        label: 'Woke',
        tooltip: 'Back from snooze',
        heading: 'Back from snooze',
        badgeClassName: 'bg-warning/15 text-warning ring-1 ring-warning/30',
        dotClassName: 'bg-warning',
        borderColor: 'oklch(var(--warning))',
        tone: 'warning',
      },
    };
  }
  const attention: WorkspaceAttention = {
    kind: 'turn-complete',
    source: UNREAD_ATTENTION_SOURCE,
    updatedAt: unread.at,
  };
  return {
    attention,
    appearance: {
      ...getWorkspaceAttentionAppearance(attention)!,
      tooltip: 'Marked as unread',
      heading: 'Marked as unread',
    },
  };
}

export interface WorkspaceAttentionSummary {
  needsInput: number;
  errors: number;
  /** Agents still working, not counting workspaces already waiting on the user. */
  running: number;
}

// What a collapsed sidebar group would otherwise hide: who is waiting on the
// user, who failed, and who is still working.
export function summarizeWorkspaceAttention(workspaces: Workspace[]): WorkspaceAttentionSummary {
  const summary: WorkspaceAttentionSummary = { needsInput: 0, errors: 0, running: 0 };
  for (const workspace of workspaces) {
    const kind = workspace.attention?.kind;
    if (kind === 'input-required') summary.needsInput++;
    else if (kind === 'error') summary.errors++;
    else if (showsWorking(workspace)) {
      summary.running++;
    }
  }
  return summary;
}

// Attention the "next workspace needing input" shortcut visits, most urgent first.
const JUMP_ATTENTION_KINDS: WorkspaceAttention['kind'][] = ['input-required', 'error'];

/**
 * The next workspace after `currentWorkspaceId` (in sidebar order, wrapping
 * around) that needs input, or, when none does, the next one with an error.
 * Returns null when no other workspace needs the user.
 */
export function findNextAttentionWorkspaceId(
  orderedWorkspaces: Pick<Workspace, 'id' | 'attention'>[],
  currentWorkspaceId: string | null
): string | null {
  const currentIndex = orderedWorkspaces.findIndex(
    (workspace) => workspace.id === currentWorkspaceId
  );
  for (const kind of JUMP_ATTENTION_KINDS) {
    const candidates = orderedWorkspaces.flatMap((workspace, index) =>
      workspace.attention?.kind === kind && workspace.id !== currentWorkspaceId
        ? [{ id: workspace.id, index }]
        : []
    );
    if (candidates.length === 0) continue;
    return (candidates.find((candidate) => candidate.index > currentIndex) ?? candidates[0]).id;
  }
  return null;
}
