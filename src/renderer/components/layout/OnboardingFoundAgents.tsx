import { CaretDown } from '@phosphor-icons/react';
import { useState } from 'react';

import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

import { OnboardingStepHeader } from './OnboardingChrome';

import type { AgentPreset } from '@/types';

type AgentTemplate = Pick<AgentPreset, 'name' | 'openCommand'>;

interface OnboardingFoundAgentsProps {
  found: AgentTemplate[];
  /** Supported agents Komla didn't find, listed under a disclosure. */
  notInstalled: AgentTemplate[];
  /** Names of the found agents left unticked. */
  excluded: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onCheckAgain: () => void;
  /** Leaves this list for the agent picker. */
  onPickOther: () => void;
}

const LINK_CLASS =
  'font-medium text-foreground/85 underline decoration-foreground/25 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60';

/** The agent step when Komla found agents: which of them to add. */
export function OnboardingFoundAgents({
  found,
  notInstalled,
  excluded,
  onToggle,
  onCheckAgain,
  onPickOther,
}: OnboardingFoundAgentsProps) {
  const [showNotInstalled, setShowNotInstalled] = useState(false);
  const noneChosen = found.every((template) => excluded.has(template.name));
  return (
    <div className="space-y-5">
      <OnboardingStepHeader
        title="Choose your agents"
        description={
          <>
            Komla found {found.length > 1 ? 'these agents' : 'this agent'} on your computer. Untick
            any you don’t use.
          </>
        }
      />

      <div className="space-y-2">
        <ul
          aria-label="Installed agents"
          className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-background/40"
        >
          {found.map((template) => {
            const checked = !excluded.has(template.name);
            return (
              <li key={template.name}>
                <label className="flex h-12 cursor-pointer items-center gap-3 px-4 transition-colors hover:bg-muted/40">
                  <Checkbox checked={checked} onChange={() => onToggle(template.name)} />
                  <AgentPresetIcon
                    preset={template}
                    className={cn('size-4 shrink-0 transition-opacity', !checked && 'opacity-40')}
                  />
                  <span
                    className={cn(
                      'text-sm font-medium transition-colors',
                      !checked && 'text-muted-foreground'
                    )}
                  >
                    {template.name}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {noneChosen && (
          <p className="text-xs text-muted-foreground">
            Tick at least one agent to continue, or{' '}
            <button type="button" className={LINK_CLASS} onClick={onPickOther}>
              pick another agent
            </button>
            .
          </p>
        )}
      </div>

      <div className="space-y-2.5 text-xs text-muted-foreground">
        <p>
          Installed one just now?{' '}
          <button type="button" className={LINK_CLASS} onClick={onCheckAgain}>
            Check again
          </button>
          {notInstalled.length > 0 && (
            <>
              {' · '}
              <button
                type="button"
                aria-expanded={showNotInstalled}
                className="inline-flex items-center gap-1 font-medium text-foreground/85 transition-colors hover:text-foreground"
                onClick={() => setShowNotInstalled(!showNotInstalled)}
              >
                {notInstalled.length} more supported agents
                <CaretDown
                  className={cn('size-3 transition-transform', showNotInstalled && 'rotate-180')}
                />
              </button>
            </>
          )}
        </p>
        {notInstalled.length > 0 && (
          <div
            className="wizard-collapsible"
            data-open={showNotInstalled}
            inert={!showNotInstalled}
          >
            <div>
              <ul aria-label="Not installed" className="flex flex-wrap gap-x-3 gap-y-1.5 pt-1">
                {notInstalled.map((template) => (
                  <li
                    key={template.name}
                    className="flex items-center gap-1.5 text-muted-foreground-70"
                  >
                    <AgentPresetIcon
                      preset={template}
                      className="size-3 shrink-0 opacity-50 grayscale"
                    />
                    {template.name}
                  </li>
                ))}
              </ul>
              <p className="pt-2.5">
                Any other CLI can be added as a custom agent in Settings → Agents.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
