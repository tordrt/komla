import {
  isWorkspaceAttentionActionable,
  isWorkspaceSnoozed,
  type Workspace,
} from '../../shared/types';

// Checked at least this often, so a snooze that ends while the computer sleeps wakes soon after.
const MAX_CHECK_DELAY_MS = 60_000;

const DURATION_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * When a snooze given to `komla snooze` ends: after a duration such as 30m, 2h or 1h30m; at a time
 * of day such as 17:30, the next time it comes; or at a local date and time such as
 * 2026-10-21 09:00, which can have passed. Undefined when the input is none of these.
 */
export function parseSnoozeUntil(input: string, now: Date): number | undefined {
  const text = input.trim().toLowerCase();

  if (/^(\d+[mhd])+$/.test(text)) {
    let ms = 0;
    for (const [, amount, unit] of text.matchAll(/(\d+)([mhd])/g)) {
      ms += Number(amount) * DURATION_UNIT_MS[unit];
    }
    return ms > 0 ? now.getTime() + ms : undefined;
  }

  const timeOfDay = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (timeOfDay) {
    const [hours, minutes] = [Number(timeOfDay[1]), Number(timeOfDay[2])];
    if (hours > 23 || minutes > 59) return undefined;
    const until = new Date(now);
    until.setHours(hours, minutes, 0, 0);
    if (until <= now) until.setDate(until.getDate() + 1);
    return until.getTime();
  }

  const dateTime = /^(\d{4})-(\d{2})-(\d{2})[ t](\d{1,2}):(\d{2})$/.exec(text);
  if (dateTime) {
    const [year, month, day, hours, minutes] = dateTime.slice(1).map(Number);
    const until = new Date(year, month - 1, day, hours, minutes);
    // Date rolls days past the end of a month into the next one; such a date doesn't exist.
    const exists =
      until.getMonth() === month - 1 &&
      until.getDate() === day &&
      until.getHours() === hours &&
      until.getMinutes() === minutes;
    return exists ? until.getTime() : undefined;
  }

  return undefined;
}

/** What waking from a snooze changes: back in the sidebar, marked unread so it stands out. */
export function wokenMarks(
  at: number
): Pick<Workspace, 'snoozedUntil' | 'wakesOnNotification' | 'unread'> {
  return {
    snoozedUntil: undefined,
    wakesOnNotification: undefined,
    unread: { reason: 'snooze-ended', at },
  };
}

/** Wakes a snoozed workspace in place. */
export function wakeWorkspace(workspace: Workspace, at: number): void {
  Object.assign(workspace, wokenMarks(at));
}

/** Wakes snoozed workspaces when their snooze ends. */
export class WorkspaceSnoozeAlarm {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly deps: {
      workspaces: () => Iterable<Workspace>;
      /** The workspaces just woken, to save and show. */
      woke: (workspaces: Workspace[]) => void;
    }
  ) {}

  /**
   * Wakes the workspaces whose snooze is over, or whose agent already waits on the user or failed,
   * and waits for the next; call when a snooze changes. At `startup`, a snooze until notified
   * with no time to end at wakes too: the agents and commands it waited on are gone.
   */
  check({ startup = false }: { startup?: boolean } = {}): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    const woken: Workspace[] = [];
    let next = Infinity;
    for (const workspace of this.deps.workspaces()) {
      if (!isWorkspaceSnoozed(workspace)) continue;
      // Until notified only, it has no time to end at.
      const until = workspace.snoozedUntil ?? Infinity;
      if (
        until <= now ||
        (startup && until === Infinity) ||
        isWorkspaceAttentionActionable(workspace.attention)
      ) {
        wakeWorkspace(workspace, Math.min(until, now));
        woken.push(workspace);
      } else {
        next = Math.min(next, until);
      }
    }
    if (woken.length > 0) this.deps.woke(woken);
    if (next === Infinity) return;
    this.timer = setTimeout(() => this.check(), Math.min(next - now, MAX_CHECK_DELAY_MS));
    this.timer.unref?.();
  }
}
