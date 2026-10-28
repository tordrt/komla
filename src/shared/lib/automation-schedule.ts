/**
 * Cron schedules for automations, evaluated in an IANA time zone. The host's
 * `komla automation tick` (native/src/automation/schedule.rs)
 * implements the same rules, and both are tested against
 * src/shared/automation-schedule-cases.json.
 *
 * - Five fields: minute hour day-of-month month day-of-week. Each is `*`, a
 *   number, a range `a-b`, a step `*\/n` or `a-b/n`, or a comma list of them.
 *   Months and weekdays also take three-letter names; weekday 7 is Sunday.
 * - When both day fields are restricted, a day matching either one matches,
 *   as in cron.
 * - A wall-clock time skipped by a daylight-saving change runs at the same
 *   distance after the change (02:30 becomes 03:30); a repeated one runs once,
 *   at its first instance.
 */
import type { AutomationSchedule } from '../types/automation';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** How far back a tick looks for a scheduled time it hasn't handled yet. */
export const AUTOMATION_LOOKBACK_MS = 8 * DAY_MS;
/** A tick starts up to a minute after the scheduled minute, and may itself be late. */
export const AUTOMATION_TICK_SLACK_MS = 2 * MINUTE_MS;
/** How far ahead `nextAutomationOccurrence` looks, enough for February 29. */
const MAX_SEARCH_DAYS = 366 * 5;

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const WEEKDAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  names?: string[];
  /** The first name's value. */
  namesStart?: number;
}

const FIELDS: FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, namesStart: 1 },
  { label: 'day of week', min: 0, max: 7, names: WEEKDAY_NAMES, namesStart: 0 },
];

export interface ParsedCron {
  minutes: number[];
  hours: number[];
  daysOfMonth: Set<number>;
  months: Set<number>;
  /** 0 is Sunday; 7 is folded into 0. */
  daysOfWeek: Set<number>;
  /** Both day fields restricted: a day matching either one matches. */
  eitherDay: boolean;
}

export class AutomationScheduleError extends Error {}

function parseValue(text: string, spec: FieldSpec): number {
  const nameIndex = spec.names?.indexOf(text.toLowerCase()) ?? -1;
  if (nameIndex >= 0) return nameIndex + (spec.namesStart ?? 0);
  if (!/^\d{1,2}$/.test(text)) {
    throw new AutomationScheduleError(`“${text}” isn’t a valid ${spec.label}.`);
  }
  const value = Number(text);
  if (value < spec.min || value > spec.max) {
    throw new AutomationScheduleError(
      `The ${spec.label} must be between ${spec.min} and ${spec.max}.`
    );
  }
  return value;
}

function parseStep(part: string, stepText: string | undefined): number {
  if (stepText === undefined) return 1;
  if (!/^\d{1,2}$/.test(stepText) || Number(stepText) === 0) {
    throw new AutomationScheduleError(`“${part}” has an invalid step.`);
  }
  return Number(stepText);
}

/** The first and last value of `*`, `a`, or `a-b`. */
function parseRange(
  part: string,
  range: string,
  stepped: boolean,
  spec: FieldSpec
): [number, number] {
  if (range === '*') return [spec.min, spec.max];
  const bounds = range.split('-');
  if (bounds.length > 2) {
    throw new AutomationScheduleError(`“${part}” isn’t a valid ${spec.label}.`);
  }
  if (stepped && bounds.length === 1) {
    throw new AutomationScheduleError(`“${part}” needs a range before its step, like 0-59/5.`);
  }
  const start = parseValue(bounds[0] ?? '', spec);
  const end = bounds.length === 2 ? parseValue(bounds[1] ?? '', spec) : start;
  if (end < start) {
    throw new AutomationScheduleError(`“${part}” is a range that ends before it starts.`);
  }
  return [start, end];
}

function parseField(text: string, spec: FieldSpec): number[] {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', stepText, extra] = part.split('/');
    if (extra !== undefined || range === '') {
      throw new AutomationScheduleError(`“${part}” isn’t a valid ${spec.label}.`);
    }
    const step = parseStep(part, stepText);
    const [start, end] = parseRange(part, range, stepText !== undefined, spec);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5 || fields[0] === '') {
    throw new AutomationScheduleError(
      'A schedule needs five fields: minute, hour, day of month, month, and day of week.'
    );
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = fields.map((field, index) =>
    parseField(field, FIELDS[index])
  ) as [number[], number[], number[], number[], number[]];
  return {
    minutes,
    hours,
    daysOfMonth: new Set(daysOfMonth),
    months: new Set(months),
    daysOfWeek: new Set(daysOfWeek.map((day) => day % 7)),
    eitherDay: !fields[2].startsWith('*') && !fields[4].startsWith('*'),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      era: 'short',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false;
  try {
    zoneFormatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** The wall-clock time in `timeZone` at `instant`, to the second as UTC milliseconds. */
function wallClockMs(timeZone: string, instant: number): number {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);
  const era = parts.find((part) => part.type === 'era')?.value;
  const year = era === 'BC' ? 1 - get('year') : get('year');
  const utc = new Date(0);
  utc.setUTCFullYear(year, get('month') - 1, get('day'));
  utc.setUTCHours(get('hour'), get('minute'), get('second'), 0);
  return utc.getTime();
}

function offsetAt(timeZone: string, instant: number): number {
  const second = Math.floor(instant / 1000) * 1000;
  return wallClockMs(timeZone, second) - second;
}

/** The instant of a wall-clock time, moved past a skipped one and at the first of a repeated one. */
function instantOf(timeZone: string, wall: WallClock): number {
  const local = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
  const before = offsetAt(timeZone, local - DAY_MS);
  const after = offsetAt(timeZone, local + DAY_MS);
  const valid = [...new Set([before, after])]
    .map((offset) => local - offset)
    .filter((instant) => offsetAt(timeZone, instant) === local - instant);
  return valid.length > 0 ? Math.min(...valid) : local - before;
}

function wallDateOf(
  timeZone: string,
  instant: number
): { year: number; month: number; day: number } {
  const wall = new Date(wallClockMs(timeZone, instant));
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth() + 1, day: wall.getUTCDate() };
}

function dayMatches(cron: ParsedCron, date: Date): boolean {
  if (!cron.months.has(date.getUTCMonth() + 1)) return false;
  const byMonthDay = cron.daysOfMonth.has(date.getUTCDate());
  const byWeekday = cron.daysOfWeek.has(date.getUTCDay());
  return cron.eitherDay ? byMonthDay || byWeekday : byMonthDay && byWeekday;
}

/** Scheduled instants on each wall-clock day from the day of `from`, a day at a time. */
function* occurrenceDays(
  cron: ParsedCron,
  timeZone: string,
  from: number,
  maxDays: number
): Generator<number[]> {
  const start = wallDateOf(timeZone, from);
  // The day before too: a time it skips can move past midnight.
  for (let offset = -1; offset <= maxDays; offset += 1) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + offset));
    if (!dayMatches(cron, date)) {
      yield [];
      continue;
    }
    const instants = new Set<number>();
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        instants.add(
          instantOf(timeZone, {
            year: date.getUTCFullYear(),
            month: date.getUTCMonth() + 1,
            day: date.getUTCDate(),
            hour,
            minute,
          })
        );
      }
    }
    yield [...instants].sort((a, b) => a - b);
  }
}

function assertSchedule(schedule: AutomationSchedule): ParsedCron {
  const cron = parseCron(schedule.cron);
  if (!isValidTimeZone(schedule.timeZone)) {
    throw new AutomationScheduleError(`“${schedule.timeZone}” isn’t a known time zone.`);
  }
  return cron;
}

/** Why a schedule can't run, or undefined when it's valid. */
export function automationScheduleError(schedule: AutomationSchedule): string | undefined {
  try {
    assertSchedule(schedule);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The first scheduled instant after `after`, within five years. */
export function nextAutomationOccurrence(
  schedule: AutomationSchedule,
  after: number
): number | undefined {
  const cron = assertSchedule(schedule);
  for (const day of occurrenceDays(cron, schedule.timeZone, after, MAX_SEARCH_DAYS)) {
    const found = day.find((instant) => instant > after);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The last scheduled instant in (`after`, `until`]. */
export function latestAutomationOccurrence(
  schedule: AutomationSchedule,
  after: number,
  until: number
): number | undefined {
  const cron = assertSchedule(schedule);
  const days = Math.ceil((until - after) / DAY_MS) + 1;
  let latest: number | undefined;
  for (const day of occurrenceDays(cron, schedule.timeZone, after, days)) {
    for (const instant of day) {
      if (instant > after && instant <= until) latest = instant;
    }
  }
  return latest;
}

export type AutomationDue =
  | { kind: 'none' }
  | { kind: 'run'; scheduledFor: number }
  | { kind: 'missed'; scheduledFor: number };

/**
 * What a tick at `now` does for an automation: start the latest scheduled
 * time it hasn't handled, or record it as missed when it is later than the
 * grace allows. Times before the last edit, or before the last handled time,
 * never run, so re-enabling an automation doesn't replay its pause.
 */
export function dueAutomationOccurrence(
  automation: {
    enabled: boolean;
    schedule: AutomationSchedule;
    missedRunGraceMinutes: number;
    updatedAt: number;
  },
  lastScheduledFor: number | undefined,
  now: number
): AutomationDue {
  if (!automation.enabled) return { kind: 'none' };
  const lower = Math.max(lastScheduledFor ?? 0, automation.updatedAt, now - AUTOMATION_LOOKBACK_MS);
  if (lower >= now) return { kind: 'none' };
  const latest = latestAutomationOccurrence(automation.schedule, lower, now);
  if (latest === undefined) return { kind: 'none' };
  const lateness = now - latest;
  return lateness > automation.missedRunGraceMinutes * MINUTE_MS + AUTOMATION_TICK_SLACK_MS
    ? { kind: 'missed', scheduledFor: latest }
    : { kind: 'run', scheduledFor: latest };
}
