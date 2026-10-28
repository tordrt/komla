import { Warning } from '@phosphor-icons/react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';

import type { AppConfig } from '@/types';

interface SpinnerSettingsBlockProps {
  config: AppConfig | null;
  onToggle: (checked: boolean) => void;
}

export function SpinnerSettingsBlock({ config, onToggle }: SpinnerSettingsBlockProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">Activity spinner</div>
          <p className="mt-0.5 text-[13px] leading-normal text-muted-foreground">
            Show a loading spinner on workspace cards, in the Overview, and in the Command Center
            while an agent is working. Works for agents with Komla notifications and for agents that
            report their own status, like Pi and Grok Build.
          </p>
        </div>
        <Switch
          aria-label="Activity spinner"
          checked={config?.showAgentSpinner !== false}
          onCheckedChange={onToggle}
        />
      </div>
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 text-ui text-muted-foreground transition-colors hover:text-foreground"
          >
            <Warning weight="fill" className="size-3 shrink-0 text-warning" />
            <span>May not always be accurate — read more</span>
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 text-xs">
          <div className="space-y-2.5">
            <p className="font-medium">Why the spinner may be inaccurate</p>
            <p className="text-muted-foreground">
              Komla follows each agent’s notifications and, for agents that support it, the status
              the agent reports in its terminal.
            </p>
            <div>
              <p className="mb-1 font-medium text-muted-foreground">The spinner stops when</p>
              <ul className="list-inside list-disc space-y-0.5 text-muted-foreground">
                <li>The agent finishes its turn or asks for input</li>
                <li>You interrupt it with Esc, Ctrl+C or Ctrl+D</li>
                <li>You close the terminal or stop the workspace</li>
              </ul>
            </div>
            <div>
              <p className="mb-1 font-medium text-muted-foreground">It can stay on when</p>
              <ul className="list-inside list-disc space-y-0.5 text-muted-foreground">
                <li>
                  An agent asks for permission without reporting it, such as a sandbox network
                  prompt
                </li>
                <li>Background work the agent started is still running</li>
              </ul>
            </div>
            <p className="text-muted-foreground">
              To clear it, right-click the workspace and choose Stop Spinner.
            </p>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
