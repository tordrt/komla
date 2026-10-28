import { showsWorking } from '@/types';

import type { Workspace } from '@/types';

export interface SnoozePreset {
  label: string;
  until: number;
}

export const HOUR_MS = 60 * 60 * 1000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/** `hour`:00 local time, `days` after `now`'s day. */
function atHour(now: Date, days: number, hour: number): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour).getTime();
}

/**
 * Whether Snooze ▸ Until Notified fits the workspace: its spinner shows, or a background Quick
 * Command runs there, and both notify when they end.
 */
export function waitsForNotification(workspace: Workspace): boolean {
  return (
    showsWorking(workspace) ||
    (workspace.setupActivities ?? []).some(
      (run) => run.actionId !== undefined && (run.state === 'preparing' || run.state === 'running')
    )
  );
}

/** The snooze menu's choices: an hour, three, this evening, tomorrow and next week's mornings. */
export function getSnoozePresets(now: Date): SnoozePreset[] {
  const presets: SnoozePreset[] = [
    { label: 'In 1 Hour', until: now.getTime() + HOUR_MS },
    { label: 'In 3 Hours', until: now.getTime() + 3 * HOUR_MS },
  ];
  const evening = atHour(now, 0, EVENING_HOUR);
  if (evening - now.getTime() > HOUR_MS) presets.push({ label: 'This Evening', until: evening });
  const tomorrow = atHour(now, 1, MORNING_HOUR);
  presets.push({ label: 'Tomorrow', until: tomorrow });
  // Monday morning; on a Sunday, that's tomorrow already.
  const nextWeek = atHour(now, 8 - (now.getDay() || 7), MORNING_HOUR);
  if (nextWeek !== tomorrow) presets.push({ label: 'Next Week', until: nextWeek });
  return presets;
}

/** When a snooze ends, as briefly as is clear from `now`: "6:00 PM", "Mon 9:00 AM" or "Nov 3, 9:00 AM". */
export function formatSnoozeTime(until: number, now: Date): string {
  const date = new Date(until);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const days = Math.round((atHour(date, 0, 0) - atHour(now, 0, 0)) / (24 * HOUR_MS));
  if (days === 0) return time;
  if (days > 0 && days < 7) {
    return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/** How long until a snooze ends: "45m", "3h" or "2d". */
export function formatSnoozeRemaining(until: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** A local time as a datetime-local input's value. */
export function toDateTimeInputValue(time: number): string {
  const date = new Date(time);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
