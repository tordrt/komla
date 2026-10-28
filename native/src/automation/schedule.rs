//! Cron schedules for automations, evaluated in an IANA time zone, by the same
//! rules as Komla's src/shared/lib/automation-schedule.ts. Both are tested
//! against src/shared/automation-schedule-cases.json.
//!
//! - Five fields: minute hour day-of-month month day-of-week. Each is `*`, a
//!   number, a range `a-b`, a step `*/n` or `a-b/n`, or a comma list of them.
//!   Months and weekdays also take three-letter names; weekday 7 is Sunday.
//! - When both day fields are restricted, a day matching either one matches.
//! - A wall-clock time skipped by a daylight-saving change runs at the same
//!   distance after the change; a repeated one runs once, at its first instance.

use std::collections::BTreeSet;

use anyhow::{bail, Context};
use jiff::civil::{Date, DateTime};
use jiff::tz::TimeZone;
use jiff::{Span, Timestamp};

use super::AutomationSchedule;

const MINUTE_MS: i64 = 60_000;
const DAY_MS: i64 = 24 * 60 * MINUTE_MS;
/// How far back a tick looks for a scheduled time it hasn't handled yet.
pub(crate) const LOOKBACK_MS: i64 = 8 * DAY_MS;
/// A tick starts up to a minute after the scheduled minute, and may itself be late.
pub(crate) const TICK_SLACK_MS: i64 = 2 * MINUTE_MS;
/// How far ahead `next_occurrence` looks, enough for February 29.
#[cfg(test)]
const MAX_SEARCH_DAYS: i64 = 366 * 5;

const MONTH_NAMES: [&str; 12] = [
    "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAY_NAMES: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

struct FieldSpec {
    label: &'static str,
    min: u8,
    max: u8,
    names: &'static [&'static str],
    names_start: u8,
}

const FIELDS: [FieldSpec; 5] = [
    FieldSpec {
        label: "minute",
        min: 0,
        max: 59,
        names: &[],
        names_start: 0,
    },
    FieldSpec {
        label: "hour",
        min: 0,
        max: 23,
        names: &[],
        names_start: 0,
    },
    FieldSpec {
        label: "day of month",
        min: 1,
        max: 31,
        names: &[],
        names_start: 0,
    },
    FieldSpec {
        label: "month",
        min: 1,
        max: 12,
        names: &MONTH_NAMES,
        names_start: 1,
    },
    FieldSpec {
        label: "day of week",
        min: 0,
        max: 7,
        names: &WEEKDAY_NAMES,
        names_start: 0,
    },
];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedCron {
    minutes: Vec<u8>,
    hours: Vec<u8>,
    days_of_month: BTreeSet<u8>,
    months: BTreeSet<u8>,
    /// 0 is Sunday; 7 is folded into 0.
    days_of_week: BTreeSet<u8>,
    /// Both day fields restricted: a day matching either one matches.
    either_day: bool,
}

fn is_number(text: &str) -> bool {
    (1..=2).contains(&text.len()) && text.bytes().all(|byte| byte.is_ascii_digit())
}

fn parse_value(text: &str, spec: &FieldSpec) -> anyhow::Result<u8> {
    let lower = text.to_ascii_lowercase();
    if let Some(index) = spec.names.iter().position(|name| *name == lower) {
        return Ok(index as u8 + spec.names_start);
    }
    if !is_number(text) {
        bail!("“{text}” isn’t a valid {}.", spec.label);
    }
    let value: u8 = text.parse()?;
    if value < spec.min || value > spec.max {
        bail!(
            "The {} must be between {} and {}.",
            spec.label,
            spec.min,
            spec.max
        );
    }
    Ok(value)
}

fn parse_field(text: &str, spec: &FieldSpec) -> anyhow::Result<Vec<u8>> {
    let mut values = BTreeSet::new();
    for part in text.split(',') {
        let mut pieces = part.split('/');
        let range = pieces.next().unwrap_or_default();
        let step_text = pieces.next();
        if pieces.next().is_some() || range.is_empty() {
            bail!("“{part}” isn’t a valid {}.", spec.label);
        }
        let step = match step_text {
            Some(step) if is_number(step) && step.parse::<u8>()? > 0 => step.parse::<u8>()?,
            Some(_) => bail!("“{part}” has an invalid step."),
            None => 1,
        };
        let (start, end) = if range == "*" {
            (spec.min, spec.max)
        } else {
            let bounds: Vec<&str> = range.split('-').collect();
            if bounds.len() > 2 {
                bail!("“{part}” isn’t a valid {}.", spec.label);
            }
            let start = parse_value(bounds[0], spec)?;
            let end = match bounds.get(1) {
                Some(end) => parse_value(end, spec)?,
                None => start,
            };
            if step_text.is_some() && bounds.len() == 1 {
                bail!("“{part}” needs a range before its step, like 0-59/5.");
            }
            if end < start {
                bail!("“{part}” is a range that ends before it starts.");
            }
            (start, end)
        };
        let mut value = start;
        while value <= end {
            values.insert(value);
            match value.checked_add(step) {
                Some(next) => value = next,
                None => break,
            }
        }
    }
    Ok(values.into_iter().collect())
}

pub(crate) fn parse_cron(expression: &str) -> anyhow::Result<ParsedCron> {
    let fields: Vec<&str> = expression.split_whitespace().collect();
    if fields.len() != 5 {
        bail!("A schedule needs five fields: minute, hour, day of month, month, and day of week.");
    }
    let mut parsed = Vec::with_capacity(5);
    for (field, spec) in fields.iter().zip(FIELDS.iter()) {
        parsed.push(parse_field(field, spec)?);
    }
    let days_of_week = parsed.pop().unwrap_or_default();
    let months = parsed.pop().unwrap_or_default();
    let days_of_month = parsed.pop().unwrap_or_default();
    let hours = parsed.pop().unwrap_or_default();
    let minutes = parsed.pop().unwrap_or_default();
    Ok(ParsedCron {
        minutes,
        hours,
        days_of_month: days_of_month.into_iter().collect(),
        months: months.into_iter().collect(),
        days_of_week: days_of_week.into_iter().map(|day| day % 7).collect(),
        either_day: !fields[2].starts_with('*') && !fields[4].starts_with('*'),
    })
}

/// The named zone from this host's time zone data.
pub(crate) fn time_zone(name: &str) -> anyhow::Result<TimeZone> {
    if name.is_empty() || name.len() > 64 || name.eq_ignore_ascii_case("Etc/Unknown") {
        bail!("“{name}” isn’t a known time zone.");
    }
    TimeZone::get(name).map_err(|_| {
        anyhow::anyhow!(
            "This host doesn’t know the time zone {name}. Install its time zone data (tzdata) or pick another zone."
        )
    })
}

/// Checks a schedule, returning the cron fields and zone to evaluate it with.
pub(crate) fn compile(schedule: &AutomationSchedule) -> anyhow::Result<(ParsedCron, TimeZone)> {
    let cron = parse_cron(&schedule.cron)?;
    let zone = time_zone(&schedule.time_zone)?;
    Ok((cron, zone))
}

fn day_matches(cron: &ParsedCron, date: Date) -> bool {
    if !cron.months.contains(&(date.month() as u8)) {
        return false;
    }
    let by_month_day = cron.days_of_month.contains(&(date.day() as u8));
    let by_weekday = cron
        .days_of_week
        .contains(&(date.weekday().to_sunday_zero_offset() as u8));
    if cron.either_day {
        by_month_day || by_weekday
    } else {
        by_month_day && by_weekday
    }
}

fn timestamp(ms: i64) -> anyhow::Result<Timestamp> {
    Timestamp::from_millisecond(ms).context("time out of range")
}

/// Scheduled instants on each wall-clock day from the day of `from`, a day at a time.
fn occurrence_days<'a>(
    cron: &'a ParsedCron,
    zone: &'a TimeZone,
    from_ms: i64,
    max_days: i64,
) -> anyhow::Result<impl Iterator<Item = Vec<i64>> + 'a> {
    let start = timestamp(from_ms)?.to_zoned(zone.clone()).date();
    // The day before too: a time it skips can move past midnight.
    Ok((-1..=max_days).filter_map(move |offset| {
        let date = start.checked_add(Span::new().days(offset)).ok()?;
        if !day_matches(cron, date) {
            return Some(Vec::new());
        }
        let mut instants = BTreeSet::new();
        for hour in &cron.hours {
            for minute in &cron.minutes {
                let wall =
                    DateTime::from_parts(date, jiff::civil::time(*hour as i8, *minute as i8, 0, 0));
                if let Ok(zoned) = wall.to_zoned(zone.clone()) {
                    instants.insert(zoned.timestamp().as_millisecond());
                }
            }
        }
        Some(instants.into_iter().collect())
    }))
}

/// The first scheduled instant after `after_ms`, within five years. Desktops
/// show it from their own copy of these rules; this one keeps them in step.
#[cfg(test)]
pub(crate) fn next_occurrence(
    schedule: &AutomationSchedule,
    after_ms: i64,
) -> anyhow::Result<Option<i64>> {
    let (cron, zone) = compile(schedule)?;
    for day in occurrence_days(&cron, &zone, after_ms, MAX_SEARCH_DAYS)? {
        if let Some(found) = day.into_iter().find(|instant| *instant > after_ms) {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

/// The last scheduled instant in (`after_ms`, `until_ms`].
pub(crate) fn latest_occurrence(
    schedule: &AutomationSchedule,
    after_ms: i64,
    until_ms: i64,
) -> anyhow::Result<Option<i64>> {
    let (cron, zone) = compile(schedule)?;
    // Rounded up like the desktop's copy: a day daylight saving shortens is under 24 hours.
    let days = (until_ms - after_ms + DAY_MS - 1).div_euclid(DAY_MS) + 1;
    let mut latest = None;
    for day in occurrence_days(&cron, &zone, after_ms, days)? {
        for instant in day {
            if instant > after_ms && instant <= until_ms {
                latest = Some(instant);
            }
        }
    }
    Ok(latest)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Due {
    None,
    Run(i64),
    Missed(i64),
}

/// What a tick at `now_ms` does for an automation: start the latest scheduled
/// time it hasn't handled, or record it as missed when it is later than the
/// grace allows. Times before the last edit, or before the last handled time,
/// never run, so re-enabling an automation doesn't replay its pause.
pub(crate) fn due(
    enabled: bool,
    schedule: &AutomationSchedule,
    missed_run_grace_minutes: i64,
    updated_at_ms: i64,
    last_scheduled_for_ms: Option<i64>,
    now_ms: i64,
) -> anyhow::Result<Due> {
    if !enabled {
        return Ok(Due::None);
    }
    let lower = last_scheduled_for_ms
        .unwrap_or(0)
        .max(updated_at_ms)
        .max(now_ms - LOOKBACK_MS);
    if lower >= now_ms {
        return Ok(Due::None);
    }
    let Some(latest) = latest_occurrence(schedule, lower, now_ms)? else {
        return Ok(Due::None);
    };
    let lateness = now_ms - latest;
    Ok(
        if lateness > missed_run_grace_minutes.max(0) * MINUTE_MS + TICK_SLACK_MS {
            Due::Missed(latest)
        } else {
            Due::Run(latest)
        },
    )
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;

    fn cases() -> Value {
        serde_json::from_str(include_str!(
            "../../../src/shared/automation-schedule-cases.json"
        ))
        .expect("valid shared automation schedule cases")
    }

    fn at(value: &Value) -> i64 {
        value
            .as_str()
            .unwrap()
            .parse::<Timestamp>()
            .unwrap()
            .as_millisecond()
    }

    fn schedule(case: &Value) -> AutomationSchedule {
        AutomationSchedule {
            cron: case["cron"].as_str().unwrap().to_owned(),
            time_zone: case["timeZone"].as_str().unwrap().to_owned(),
        }
    }

    #[test]
    fn finds_the_next_time_for_every_shared_case() {
        for case in cases()["next"].as_array().unwrap() {
            let next = next_occurrence(&schedule(case), at(&case["after"])).unwrap();
            assert_eq!(next, Some(at(&case["expected"])), "{}", case["name"]);
        }
    }

    #[test]
    fn decides_what_a_tick_does_for_every_shared_case() {
        for case in cases()["due"].as_array().unwrap() {
            let decided = due(
                case["enabled"].as_bool().unwrap(),
                &schedule(case),
                case["missedRunGraceMinutes"].as_i64().unwrap(),
                at(&case["updatedAt"]),
                case.get("lastScheduledFor").map(at),
                at(&case["now"]),
            )
            .unwrap();
            let expected = &case["expected"];
            let wanted = match expected["kind"].as_str().unwrap() {
                "none" => Due::None,
                "run" => Due::Run(at(&expected["scheduledFor"])),
                "missed" => Due::Missed(at(&expected["scheduledFor"])),
                other => panic!("unknown kind {other}"),
            };
            assert_eq!(decided, wanted, "{}", case["name"]);
        }
    }

    #[test]
    fn refuses_every_shared_invalid_cron_expression() {
        for cron in cases()["invalidCron"].as_array().unwrap() {
            let cron = cron.as_str().unwrap();
            assert!(parse_cron(cron).is_err(), "{cron:?} parsed");
        }
    }

    #[test]
    fn refuses_every_shared_invalid_time_zone() {
        for zone in cases()["invalidTimeZone"].as_array().unwrap() {
            let zone = zone.as_str().unwrap();
            assert!(time_zone(zone).is_err(), "{zone:?} accepted");
        }
    }

    #[test]
    fn reads_both_day_fields_restricted_as_either_one() {
        assert!(parse_cron("0 9 1 * 1").unwrap().either_day);
        assert!(!parse_cron("0 9 * * 1").unwrap().either_day);
        assert!(!parse_cron("0 9 */2 * 1").unwrap().either_day);
    }
}
