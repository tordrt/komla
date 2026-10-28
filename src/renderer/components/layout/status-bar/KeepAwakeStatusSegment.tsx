import { Coffee } from '@phosphor-icons/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { agentsWorkingHere, commandsWorkingHere, type AppConfig } from '@/types';

import { StatusBarButton } from './StatusBarButton';

type KeepAwakeMode = NonNullable<AppConfig['keepAwakeMode']>;

export const KEEP_AWAKE_MODES: { value: KeepAwakeMode; label: string; description: string }[] = [
  { value: 'off', label: 'Off', description: 'Let it sleep as usual' },
  {
    value: 'agents',
    label: 'While agents work',
    description: 'Stay awake while an agent works here',
  },
  { value: 'always', label: 'Always', description: 'Stay awake until you turn this off' },
];

/** `working` counts agents and commands run with `komla notify --`, `commands` only the latter. */
function describe(mode: KeepAwakeMode, working: number, commands: number): string {
  if (mode === 'always') return 'Keeping this computer awake';
  if (mode === 'off') return 'Keep awake is off';
  if (working === 0) return 'Keeps this computer awake while agents work on it';
  const agents = working - commands;
  const agentsWork = `${agents} ${agents === 1 ? 'agent' : 'agents'}`;
  const commandsRun = `${commands} ${commands === 1 ? 'command' : 'commands'}`;
  if (commands === 0)
    return `Keeping this computer awake while ${agentsWork} ${agents === 1 ? 'works' : 'work'} on it`;
  if (agents === 0)
    return `Keeping this computer awake while ${commandsRun} ${commands === 1 ? 'runs' : 'run'} on it`;
  return `Keeping this computer awake while ${agentsWork} and ${commandsRun} work on it`;
}

export function KeepAwakeStatusSegment() {
  const mode = useConfigStore((s) => s.config?.keepAwakeMode ?? 'off');
  const updateConfig = useConfigStore((s) => s.updateConfig);
  // Every window's agents count, as the main process keeps the computer awake for all of them.
  const agentsWorking = useWorkspacesStore((s) =>
    s.workspaces.reduce(
      (count, workspace) =>
        workspace.status === 'active' ? count + agentsWorkingHere(workspace) : count,
      0
    )
  );
  const commandsWorking = useWorkspacesStore((s) =>
    s.workspaces.reduce(
      (count, workspace) =>
        workspace.status === 'active' ? count + commandsWorkingHere(workspace) : count,
      0
    )
  );
  const awake = mode === 'always' || (mode === 'agents' && agentsWorking > 0);
  const description = describe(mode, agentsWorking, commandsWorking);

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <StatusBarButton
          aria-label={description}
          tooltip={description}
          className={cn(awake && 'text-foreground', mode === 'off' && 'text-muted-foreground/60')}
        >
          <Coffee aria-hidden="true" weight={awake ? 'fill' : 'regular'} className="size-3.5" />
          {awake && <span className="@max-3xl:hidden">Awake</span>}
        </StatusBarButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" className="w-72 min-w-0">
        <DropdownMenuLabel className="flex items-center justify-between gap-3">
          Keep this computer awake
          <span className={cn('flex items-center gap-1.5 font-normal', awake && 'text-foreground')}>
            <span
              aria-hidden="true"
              className={cn('size-1.5 rounded-full', awake ? 'bg-success' : 'bg-foreground/25')}
            />
            {awake ? 'Awake' : mode === 'off' ? 'Off' : 'No agents working'}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={mode}
          onValueChange={(value) => void updateConfig({ keepAwakeMode: value as KeepAwakeMode })}
        >
          {KEEP_AWAKE_MODES.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              aria-label={option.label}
              aria-describedby={`keep-awake-${option.value}`}
              className="items-start py-1.5"
            >
              <span className="flex flex-col">
                {option.label}
                <span id={`keep-awake-${option.value}`} className="text-ui text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-ui text-muted-foreground">
          The display can still turn off. Agents on SSH hosts keep working in tmux while this
          computer sleeps.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
