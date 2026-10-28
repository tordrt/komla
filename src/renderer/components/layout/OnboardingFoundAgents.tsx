import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Checkbox } from '@/components/ui/checkbox';

import type { AgentPreset } from '@/types';

type AgentTemplate = Pick<AgentPreset, 'name' | 'openCommand'>;

interface OnboardingFoundAgentsProps {
  found: AgentTemplate[];
  /** Supported agents Komla didn't find, shown greyed out. */
  notInstalled: AgentTemplate[];
  /** Names of the found agents left unticked. */
  excluded: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onCheckAgain: () => void;
  /** Leaves this list for the agent picker. */
  onPickOther: () => void;
}

/** The agent step when Komla found agents: which of them to add. */
export function OnboardingFoundAgents({
  found,
  notInstalled,
  excluded,
  onToggle,
  onCheckAgain,
  onPickOther,
}: OnboardingFoundAgentsProps) {
  const noneChosen = found.every((template) => excluded.has(template.name));
  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Choose your agents</h2>
        <p className="text-sm text-muted-foreground">
          Komla found {found.length > 1 ? 'these agents' : 'this agent'} on your computer. Untick
          any you don’t use.
        </p>
      </div>

      <div className="space-y-2">
        <ul
          aria-label="Installed agents"
          className="divide-y divide-border rounded-lg border border-border"
        >
          {found.map((template) => (
            <li key={template.name}>
              <label className="flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50">
                <Checkbox
                  checked={!excluded.has(template.name)}
                  onChange={() => onToggle(template.name)}
                />
                <AgentPresetIcon preset={template} className="size-4 shrink-0" />
                <span className="text-sm font-medium">{template.name}</span>
              </label>
            </li>
          ))}
        </ul>
        {noneChosen && (
          <p className="text-xs text-muted-foreground">
            Tick at least one agent to continue, or{' '}
            <button
              type="button"
              className="underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
              onClick={onPickOther}
            >
              pick another agent
            </button>
            .
          </p>
        )}
      </div>

      <div className="space-y-2">
        {notInstalled.length > 0 && (
          <>
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Not installed
            </p>
            <ul aria-label="Not installed" className="flex flex-wrap gap-1.5">
              {notInstalled.map((template) => (
                <li
                  key={template.name}
                  className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground/70"
                >
                  <AgentPresetIcon
                    preset={template}
                    className="size-3 shrink-0 opacity-50 grayscale"
                  />
                  {template.name}
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="text-xs text-muted-foreground">
          Installed one just now?{' '}
          <button
            type="button"
            className="underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
            onClick={onCheckAgain}
          >
            Check again
          </button>
          . Any other CLI can be added as a custom agent later in Settings → Agents.
        </p>
      </div>
    </div>
  );
}
