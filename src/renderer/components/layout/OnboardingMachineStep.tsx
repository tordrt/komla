import { Check, Desktop, HardDrives } from '@phosphor-icons/react';

import { SshGuideLink } from '@/components/ssh-hosts/ssh-guide';
import { sshConfigHostSummary } from '@/components/ssh-hosts/SshConfigHostPicker';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

import {
  ChoiceCheck,
  choiceClass,
  OnboardingSectionLabel,
  OnboardingStepHeader,
} from './OnboardingChrome';

import type { SshConfigHost } from '@/types';
import type { Icon } from '@phosphor-icons/react';

export type AgentMachine = 'local' | 'ssh';

interface OnboardingMachineStepProps {
  machine: AgentMachine;
  onMachineChange: (machine: AgentMachine) => void;
  configHosts: SshConfigHost[];
  /** The alias picked from ~/.ssh/config, if any. */
  pickedAlias: string | null;
  onPickAlias: (alias: string | null) => void;
}

/**
 * Asks whether agents run here or on a machine over SSH. Nothing connects yet: the SSH host
 * is added once setup is done, so a failed check never holds up Start working.
 */
export function OnboardingMachineStep({
  machine,
  onMachineChange,
  configHosts,
  pickedAlias,
  onPickAlias,
}: OnboardingMachineStepProps) {
  return (
    <div className="space-y-5">
      <OnboardingStepHeader
        title="Where should agents run?"
        description="Not a lasting choice: each new workspace picks where it runs."
      />

      <div className="grid gap-3">
        <ChoiceCard
          icon={Desktop}
          title="This computer"
          description="Simplest to start. Agents stop when Komla quits or this computer sleeps."
          selected={machine === 'local'}
          onSelect={() => onMachineChange('local')}
        />
        <ChoiceCard
          icon={HardDrives}
          title="A machine I can SSH into"
          description="A dev box, home server or cloud VM. Agents keep going while your laptop sleeps, and workspaces follow you across computers."
          badge="Runs while you’re away"
          selected={machine === 'ssh'}
          onSelect={() => onMachineChange('ssh')}
        />
      </div>

      {machine === 'ssh' && (
        <div className="space-y-3">
          {configHosts.length > 0 && (
            <div className="space-y-2">
              <OnboardingSectionLabel>From ~/.ssh/config · optional</OnboardingSectionLabel>
              <ul
                aria-label="Hosts in ~/.ssh/config"
                className="flex max-h-32 flex-wrap gap-2 overflow-y-auto"
              >
                {configHosts.map((host) => {
                  const picked = host.alias === pickedAlias;
                  return (
                    <li key={host.alias}>
                      <button
                        type="button"
                        aria-pressed={picked}
                        title={sshConfigHostSummary(host) ?? undefined}
                        onClick={() => onPickAlias(picked ? null : host.alias)}
                        className={cn(
                          'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 font-mono text-xs',
                          choiceClass(picked)
                        )}
                      >
                        {picked && <Check className="size-3 shrink-0 text-komla" weight="bold" />}
                        {host.alias}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            After setup, Komla connects over your ssh, checks for Git and tmux, and installs a few
            helper scripts. <SshGuideLink /> ·{' '}
            <SshGuideLink section="no-machine">No machine yet? ↗</SshGuideLink>
          </p>
        </div>
      )}
    </div>
  );
}

/** One answer to a setup question, as a card: picked cards show a check. */
export function ChoiceCard({
  icon: CardIcon,
  title,
  description,
  badge,
  selected,
  onSelect,
}: {
  icon: Icon;
  title: string;
  description: string;
  badge?: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn('flex items-start gap-3.5 rounded-xl p-4 text-left', choiceClass(selected))}
    >
      <span
        className={cn(
          'flex size-9 shrink-0 items-center justify-center rounded-lg transition-colors',
          selected ? 'bg-komla/15 text-komla' : 'bg-muted text-muted-foreground'
        )}
      >
        <CardIcon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          {title}
          {badge && (
            <Badge tone={selected ? 'info' : 'neutral'} variant="outline">
              {badge}
            </Badge>
          )}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <span className="flex size-5 shrink-0 items-center justify-center">
        {selected ? (
          <ChoiceCheck />
        ) : (
          <span className="size-4 rounded-full ring-1 ring-border ring-inset" />
        )}
      </span>
    </button>
  );
}
