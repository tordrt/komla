import { Check, Desktop, HardDrives } from '@phosphor-icons/react';

import { SshGuideLink } from '@/components/ssh-hosts/ssh-guide';
import { sshConfigHostSummary } from '@/components/ssh-hosts/SshConfigHostPicker';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

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
      <div>
        <h2 className="text-lg font-semibold">Where should agents run?</h2>
        <p className="text-sm text-muted-foreground">
          Not a lasting choice: each new workspace picks where it runs, and you can add an SSH host
          anytime.
        </p>
      </div>

      <div className="grid gap-3">
        <ChoiceCard
          icon={Desktop}
          title="This computer"
          description="Start here and add an SSH host later. Agents stop when Komla quits or this computer sleeps."
          selected={machine === 'local'}
          onSelect={() => onMachineChange('local')}
        />
        <ChoiceCard
          icon={HardDrives}
          title="A machine I can SSH into"
          description="A dev box, home server or cloud VM. Agents keep running while your laptop sleeps, workspaces sync across your computers, and automations run on schedule."
          badge="Runs while you’re away"
          selected={machine === 'ssh'}
          onSelect={() => onMachineChange('ssh')}
        />
      </div>

      {machine === 'ssh' && (
        <div className="space-y-3">
          {configHosts.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                From ~/.ssh/config
              </p>
              <p className="text-xs text-muted-foreground">
                Optional: pick one to start from. You can enter any host when you add it after
                setup.
              </p>
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
                          'flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 font-mono text-xs transition-all',
                          picked
                            ? 'border-primary/50 bg-primary/5 ring-2 ring-primary/50'
                            : 'border-border hover:bg-muted/50'
                        )}
                      >
                        {picked && <Check className="size-3 shrink-0 text-primary" />}
                        {host.alias}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            Once setup is done, Komla connects with your ssh, checks the machine for Git and tmux,
            and installs a few helper scripts there. You connect the agents on it then, as you just
            did here. <SshGuideLink /> ·{' '}
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
      className={cn(
        'flex items-start gap-3 rounded-lg border p-3 text-left transition-all',
        selected
          ? 'border-primary/50 bg-primary/5 ring-2 ring-primary/50'
          : 'border-border hover:bg-muted/50'
      )}
    >
      <CardIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          {title}
          {badge && <Badge tone="primary">{badge}</Badge>}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {selected && (
        <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary">
          <Check className="size-3 text-primary-foreground" />
        </div>
      )}
    </button>
  );
}
