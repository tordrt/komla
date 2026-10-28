import { memo, useMemo } from 'react';

import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select } from '@/components/ui/select';
import {
  formatRunTime,
  timeZoneOptions,
  WEEKDAY_ORDER,
  WEEKDAY_SHORT_NAMES,
  type ScheduleDraft,
  type ScheduleFrequency,
} from '@/lib/automation-schedule-draft';
import { cn } from '@/lib/utils';

import { nextAutomationOccurrence } from '../../../../shared/lib/automation-schedule';

const FREQUENCIES: { value: ScheduleFrequency; label: string }[] = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'custom', label: 'Custom' },
];

interface AutomationScheduleSectionProps {
  fieldId: string;
  draft: ScheduleDraft;
  /** The draft as a cron expression. */
  cron: string;
  timeZone: string;
  scheduleError: string | undefined;
  onDraftChange: (changes: Partial<ScheduleDraft>) => void;
  onTimeZoneChange: (timeZone: string) => void;
}

/**
 * Repeat, the fields the frequency needs, the time zone, and the next three runs. Memoized, so
 * typing a name or prompt doesn't render every time zone again.
 */
export const AutomationScheduleSection = memo(function AutomationScheduleSection({
  fieldId,
  draft,
  cron,
  timeZone,
  scheduleError,
  onDraftChange,
  onTimeZoneChange,
}: AutomationScheduleSectionProps) {
  const timeZones = useMemo(() => timeZoneOptions(timeZone), [timeZone]);
  const upcoming = useMemo(() => {
    if (scheduleError) return [];
    const times: number[] = [];
    let after = Date.now();
    for (let index = 0; index < 3; index += 1) {
      const next = nextAutomationOccurrence({ cron, timeZone }, after);
      if (next === undefined) break;
      times.push(next);
      after = next;
    }
    return times;
  }, [cron, timeZone, scheduleError]);

  return (
    <div className="space-y-3">
      <div className="grid gap-1.5">
        <span id={`${fieldId}-frequency`} className="text-[13px] font-medium">
          Repeat
        </span>
        <SegmentedControl
          aria-labelledby={`${fieldId}-frequency`}
          size="md"
          fill
          value={draft.frequency}
          onValueChange={(frequency) =>
            onDraftChange(frequency === 'custom' ? { frequency, cron } : { frequency })
          }
          options={FREQUENCIES}
        />
      </div>

      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <ScheduleDraftFields fieldId={fieldId} draft={draft} onChange={onDraftChange} />
        <div className="grid min-w-56 flex-1 gap-1.5">
          <label htmlFor={`${fieldId}-time-zone`} className="text-[13px] font-medium">
            Time zone
          </label>
          <Select
            id={`${fieldId}-time-zone`}
            value={timeZone}
            className="h-9"
            onChange={(event) => onTimeZoneChange(event.target.value)}
          >
            {timeZones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {scheduleError ? (
        <Callout tone="error" size="sm">
          {scheduleError}
        </Callout>
      ) : (
        upcoming.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Next runs: {upcoming.map((instant) => formatRunTime(instant, timeZone)).join(' · ')}
          </p>
        )
      )}
    </div>
  );
});

interface ScheduleDraftFieldsProps {
  fieldId: string;
  draft: ScheduleDraft;
  onChange: (changes: Partial<ScheduleDraft>) => void;
}

/** The fields the chosen frequency needs: a minute, a time, days, or a cron expression. */
function ScheduleDraftFields({ fieldId, draft, onChange: updateDraft }: ScheduleDraftFieldsProps) {
  return (
    <>
      {draft.frequency === 'hourly' && (
        <div className="grid gap-1.5">
          <label htmlFor={`${fieldId}-minute`} className="text-[13px] font-medium">
            Minutes past the hour
          </label>
          <Input
            id={`${fieldId}-minute`}
            type="number"
            min={0}
            max={59}
            value={draft.minute}
            onChange={(event) =>
              updateDraft({
                minute: Math.min(59, Math.max(0, Math.trunc(Number(event.target.value) || 0))),
              })
            }
            className="h-9 w-24"
          />
        </div>
      )}

      {draft.frequency === 'weekly' && (
        <div className="grid basis-full gap-1.5">
          <span id={`${fieldId}-days`} className="text-[13px] font-medium">
            Days
          </span>
          <div role="group" aria-labelledby={`${fieldId}-days`} className="flex flex-wrap gap-1">
            {WEEKDAY_ORDER.map((day) => {
              const selected = draft.days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    updateDraft({
                      days: selected
                        ? draft.days.filter((candidate) => candidate !== day)
                        : [...draft.days, day],
                    })
                  }
                  className={cn(
                    'h-7 min-w-11 rounded-md border px-2 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
                    selected
                      ? 'border-primary/50 bg-primary/15 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-muted/60'
                  )}
                >
                  {WEEKDAY_SHORT_NAMES[day]}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {(draft.frequency === 'daily' ||
        draft.frequency === 'weekdays' ||
        draft.frequency === 'weekly') && (
        <div className="grid gap-1.5">
          <label htmlFor={`${fieldId}-time`} className="text-[13px] font-medium">
            Time
          </label>
          <Input
            id={`${fieldId}-time`}
            type="time"
            step={60}
            value={draft.time}
            onChange={(event) => event.target.value && updateDraft({ time: event.target.value })}
            className="h-9 w-32"
          />
        </div>
      )}

      {draft.frequency === 'custom' && (
        <div className="grid basis-full gap-1.5">
          <label htmlFor={`${fieldId}-cron`} className="text-[13px] font-medium">
            Cron expression
          </label>
          <Input
            id={`${fieldId}-cron`}
            value={draft.cron}
            onChange={(event) => updateDraft({ cron: event.target.value })}
            placeholder="0 9 * * 1-5"
            className="h-9 font-mono"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            Minute, hour, day of month, month, and day of week, e.g. <code>{'30 7 * * 1,3,5'}</code>{' '}
            for 07:30 on Mondays, Wednesdays, and Fridays.
          </p>
        </div>
      )}
    </>
  );
}
