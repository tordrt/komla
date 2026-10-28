/** The schedule picker's choices, and the cron expressions they stand for. */

export type ScheduleFrequency = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'custom';

export interface ScheduleDraft {
  frequency: ScheduleFrequency;
  /** `HH:MM`, for daily, weekday, and weekly schedules. */
  time: string;
  /** Minutes past the hour, for hourly schedules. */
  minute: number;
  /** 0 is Sunday, for weekly schedules. */
  days: number[];
  /** The expression itself, for custom schedules. */
  cron: string;
}

export const DEFAULT_SCHEDULE_DRAFT: ScheduleDraft = {
  frequency: 'weekdays',
  time: '09:00',
  minute: 0,
  days: [1],
  cron: '0 9 * * 1-5',
};

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
/** Monday first, as the picker shows them. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
export const WEEKDAY_SHORT_NAMES = WEEKDAY_NAMES.map((name) => name.slice(0, 3));

function splitTime(time: string): { hour: number; minute: number } {
  const [hour = '9', minute = '0'] = time.split(':');
  return { hour: Number(hour), minute: Number(minute) };
}

const pad = (value: number) => String(value).padStart(2, '0');

export function draftToCron(draft: ScheduleDraft): string {
  const { hour, minute } = splitTime(draft.time);
  switch (draft.frequency) {
    case 'hourly':
      return `${draft.minute} * * * *`;
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly':
      return `${minute} ${hour} * * ${[...draft.days].sort((a, b) => a - b).join(',')}`;
    case 'custom':
      return draft.cron.trim();
  }
}

/** The picker's view of a saved expression; anything it can't show is custom. */
export function cronToDraft(cron: string): ScheduleDraft {
  const fields = cron.trim().split(/\s+/);
  const base = { ...DEFAULT_SCHEDULE_DRAFT, cron: cron.trim() };
  const number = (value: string | undefined, max: number) =>
    value !== undefined && /^\d{1,2}$/.test(value) && Number(value) <= max
      ? Number(value)
      : undefined;
  if (fields.length !== 5) return { ...base, frequency: 'custom' };
  const [minuteField, hourField, dayOfMonth, month, dayOfWeek] = fields;
  const minute = number(minuteField, 59);
  if (minute === undefined || dayOfMonth !== '*' || month !== '*') {
    return { ...base, frequency: 'custom' };
  }
  if (hourField === '*' && dayOfWeek === '*') {
    return { ...base, frequency: 'hourly', minute };
  }
  const hour = number(hourField, 23);
  if (hour === undefined) return { ...base, frequency: 'custom' };
  const time = `${pad(hour)}:${pad(minute)}`;
  if (dayOfWeek === '*') return { ...base, frequency: 'daily', time };
  if (dayOfWeek === '1-5') return { ...base, frequency: 'weekdays', time };
  if (dayOfWeek && /^[0-6](,[0-6])*$/.test(dayOfWeek)) {
    const days = [...new Set(dayOfWeek.split(',').map(Number))];
    return { ...base, frequency: 'weekly', time, days };
  }
  return { ...base, frequency: 'custom' };
}

function listDays(days: number[]): string {
  const chosen = new Set(days);
  const ordered = WEEKDAY_ORDER.filter((day) => chosen.has(day));
  if (ordered.length <= 2) return ordered.map((day) => `${WEEKDAY_NAMES[day]}s`).join(' and ');
  return ordered.map((day) => WEEKDAY_SHORT_NAMES[day]).join(', ');
}

/** `Weekdays at 09:00`, `Every hour at :15`, or the expression itself. */
export function describeSchedule(cron: string): string {
  const draft = cronToDraft(cron);
  switch (draft.frequency) {
    case 'hourly':
      return draft.minute === 0 ? 'Every hour' : `Every hour at :${pad(draft.minute)}`;
    case 'daily':
      return `Every day at ${draft.time}`;
    case 'weekdays':
      return `Weekdays at ${draft.time}`;
    case 'weekly':
      return `${listDays(draft.days)} at ${draft.time}`;
    case 'custom':
      return `Cron ${draft.cron}`;
  }
}

const runTimeFormatters = new Map<
  string,
  { day: Intl.DateTimeFormat; time: Intl.DateTimeFormat; date: Intl.DateTimeFormat }
>();

function runTimeFormatter(timeZone: string) {
  let formatter = runTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = {
      day: new Intl.DateTimeFormat('en-CA', { timeZone, dateStyle: 'short' }),
      time: new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }),
      date: new Intl.DateTimeFormat('en-US', {
        timeZone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
    };
    runTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** `Today 09:00`, `Tomorrow 09:00`, or `Tue, Oct 20, 09:00`, in the schedule's time zone. */
export function formatRunTime(instant: number, timeZone: string, now = Date.now()): string {
  const formatter = runTimeFormatter(timeZone);
  const day = (value: number) => formatter.day.format(value);
  const time = formatter.time.format(instant);
  if (day(instant) === day(now)) return `Today ${time}`;
  if (day(instant) === day(now + 24 * 60 * 60 * 1000)) return `Tomorrow ${time}`;
  return `${formatter.date.format(instant)}, ${time}`;
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Every zone the picker offers, with the given ones first if this runtime doesn't list them. */
export function timeZoneOptions(...include: string[]): string[] {
  const supported =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return [...new Set([...include.filter(Boolean), ...supported, 'UTC'])].sort((a, b) =>
    a.localeCompare(b)
  );
}
