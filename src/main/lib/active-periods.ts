/**
 * Whether a heartbeat sent `today` is the install's first in its ISO week and
 * in its calendar month (both UTC), given the date of the previous one. Counting
 * heartbeats flagged this way gives weekly and monthly active installs without
 * an install ID; only the previous date, kept on this device, is needed.
 */
export function activePeriodFlags(
  lastHeartbeatDate: string | undefined,
  today: string
): { firstThisWeek: boolean; firstThisMonth: boolean } {
  const last = parseDay(lastHeartbeatDate ?? '');
  const now = parseDay(today);
  if (!last || !now) return { firstThisWeek: true, firstThisMonth: true };
  return {
    firstThisWeek: isoWeek(last) !== isoWeek(now),
    firstThisMonth:
      last.getUTCFullYear() !== now.getUTCFullYear() || last.getUTCMonth() !== now.getUTCMonth(),
  };
}

function parseDay(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `YYYY-Www`: the ISO week, which starts on Monday and belongs to the year of its Thursday. */
function isoWeek(date: Date): string {
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
  return `${year}-W${week}`;
}
