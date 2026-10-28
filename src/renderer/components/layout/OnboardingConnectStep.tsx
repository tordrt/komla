import { Lightbulb } from '@phosphor-icons/react';
import { useEffect, useId, useState, type ReactNode } from 'react';

import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Callout } from '@/components/ui/callout';
import { Switch } from '@/components/ui/switch';
import { reportsOwnStatus } from '@/lib/agent-status-reports';
import { listAgentNames } from '@/utils/agent-name';

import { agentNotificationStatus, setAgentNotifications } from './settings/agent-notifications';
import { HooksHelp } from './settings/IntegrationHelp';

import type { AgentIntegrationFilter } from './settings/AgentIntegrations';
import type { AgentPreset } from '@/types';

// An agent on the Launch step: its template name, the name shown for it, and its icon.
export interface LaunchAgent {
  name: string;
  label: string;
  preset: Pick<AgentPreset, 'name' | 'openCommand'>;
}

/** What Komla has set up for an agent with one-click integration. */
export interface AgentConnection {
  agent: AgentIntegrationFilter;
  notifications: boolean;
  /** What turning on its notifications changes, for "What changes?". */
  changes: { label: string; value: string }[];
}

async function loadConnection(agent: AgentIntegrationFilter): Promise<AgentConnection> {
  const notifications = await agentNotificationStatus(agent);
  return {
    agent,
    notifications: notifications.isConfigured,
    changes: notifications.isConfigured ? [] : [{ label: 'Hooks in', value: notifications.path }],
  };
}

async function loadConnections(agents: AgentIntegrationFilter[]): Promise<AgentConnection[]> {
  return Promise.all(
    agents.map(async (agent) => {
      try {
        return await loadConnection(agent);
      } catch (err) {
        console.error(`Failed to check the ${agent} integration:`, err);
        // Unknown counts as off, so the switch can still turn it on.
        return { agent, notifications: false, changes: [] };
      }
    })
  );
}

/**
 * Checks what Komla has set up for these agents while `enabled`, and turns one agent's
 * notifications on or off at a time. `errors` holds what failed in each agent's last change.
 */
export function useAgentConnections(agents: readonly AgentIntegrationFilter[], enabled: boolean) {
  const key = agents.join(',');
  const [loaded, setLoaded] = useState<{ key: string; connections: AgentConnection[] } | null>(
    null
  );
  const [pending, setPending] = useState<AgentIntegrationFilter | null>(null);
  const [errors, setErrors] = useState<Partial<Record<AgentIntegrationFilter, string>>>({});

  useEffect(() => {
    if (!enabled || !key) return;
    let cancelled = false;
    void loadConnections(key.split(',') as AgentIntegrationFilter[]).then((connections) => {
      if (!cancelled) setLoaded({ key, connections });
    });
    return () => {
      cancelled = true;
    };
  }, [key, enabled]);

  const connections = loaded?.key === key ? loaded.connections : null;

  const toggle = async (agent: AgentIntegrationFilter, on: boolean) => {
    if (!connections || pending) return;
    setPending(agent);
    const error = await setAgentNotifications(agent, on);
    const [updated] = await loadConnections([agent]);
    setLoaded(
      (current) =>
        current && {
          ...current,
          connections: current.connections.map((c) => (c.agent === agent ? updated : c)),
        }
    );
    setErrors((current) => ({ ...current, [agent]: error || undefined }));
    setPending(null);
  };

  return { connections, pending, errors, toggle };
}

function IntegrationSwitch({
  label,
  agentLabel,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  agentLabel: string;
  /** What turning it on does, behind an info icon beside the label. */
  help: ReactNode;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <label htmlFor={id}>{label}</label>
      {help}
      <Switch
        id={id}
        aria-label={`${agentLabel} ${label}`}
        className="ml-0.5"
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
      />
    </div>
  );
}

// What hooks add for these agents. Notifications work without them only when every agent here
// reports its own status.
function connectSummary(
  agents: OnboardingConnectStepProps['agents'],
  others: LaunchAgent[]
): string {
  if (others.length > 0 || !agents.every((agent) => reportsOwnStatus(agent.filter))) {
    return 'Leave agents running and come back when one needs you, with every workspace named after what you’re working on. We highly recommend hooks for the best experience.';
  }
  const status =
    agents.length > 1
      ? 'They already tell Komla when they finish or need you.'
      : 'It already tells Komla when it finishes or needs you.';
  return `${status} For the best experience, we highly recommend hooks: they keep every workspace named after what you’re working on, and show done only once a turn has really finished.`;
}

interface OnboardingConnectStepProps {
  /** Agents with one-click integration, each with the integration it uses. */
  agents: (LaunchAgent & { filter: AgentIntegrationFilter })[];
  /** Agents that set up their own integration, later from Tips. */
  others: LaunchAgent[];
  connections: AgentConnection[] | null;
  /** The agent whose notifications are being turned on or off. */
  pending: AgentIntegrationFilter | null;
  /** What failed in each agent's last change. */
  errors: Partial<Record<AgentIntegrationFilter, string>>;
  onToggle: (agent: AgentIntegrationFilter, on: boolean) => void;
}

export function OnboardingConnectStep({
  agents,
  others,
  connections,
  pending,
  errors,
  onToggle,
}: OnboardingConnectStepProps) {
  const [showChanges, setShowChanges] = useState(false);
  const total = agents.length + others.length;
  const othersNames = listAgentNames(others.map((agent) => agent.label));
  const othersTitle = `${othersNames} can set ${others.length > 1 ? 'themselves' : 'itself'} up`;
  const pendingChanges = (connections ?? [])
    .map((connection) => ({
      key: connection.agent,
      title: agents.find((agent) => agent.filter === connection.agent)?.label,
      changes: connection.changes,
    }))
    .filter((entry) => entry.changes.length > 0);

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Connect your {total > 1 ? 'agents' : 'agent'}</h2>
        <p className="text-sm text-muted-foreground">{connectSummary(agents, others)}</p>
      </div>

      {agents.length > 0 && (
        <div className="space-y-2">
          <ul
            aria-label="Agents with one-click setup"
            className="divide-y divide-border rounded-lg border border-border"
          >
            {agents.map((agent) => {
              const connection = connections?.find((c) => c.agent === agent.filter);
              const error = errors[agent.filter];
              const switchDisabled = !connection || pending !== null;
              return (
                <li key={agent.name} className="flex items-center gap-3 px-4 py-3">
                  <AgentPresetIcon preset={agent.preset} className="size-4 shrink-0" />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="text-sm font-medium">{agent.label}</p>
                    {agent.filter === 'codex' && (
                      <p className="text-xs text-muted-foreground">
                        Codex asks you to approve Komla’s hooks: run{' '}
                        <code className="font-mono">/hooks</code> in Codex.
                      </p>
                    )}
                    {error && <p className="text-xs text-error">{error}.</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-4">
                    <IntegrationSwitch
                      label="Hooks"
                      agentLabel={agent.label}
                      help={<HooksHelp agent={agent.label} integration={agent.filter} />}
                      checked={connection?.notifications ?? false}
                      disabled={switchDisabled}
                      onChange={(on) => onToggle(agent.filter, on)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
          {pendingChanges.length > 0 && (
            <button
              type="button"
              aria-expanded={showChanges}
              className="text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
              onClick={() => setShowChanges(!showChanges)}
            >
              What changes?
            </button>
          )}
          {showChanges && pendingChanges.length > 0 && (
            <ul className="space-y-2 rounded-md bg-muted/50 px-3 py-2.5 text-xs">
              {pendingChanges.map((entry) => (
                <li key={entry.key}>
                  <p className="font-medium">{entry.title}</p>
                  {entry.changes.map((change) => (
                    <p key={change.label} className="text-muted-foreground">
                      {change.label} <code className="font-mono break-all">{change.value}</code>
                    </p>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {others.length > 0 && (
        <Callout
          role="note"
          aria-label={othersTitle}
          title={othersTitle}
          icon={<Lightbulb className="size-4" weight="fill" />}
        >
          Komla can’t connect {others.length > 1 ? 'them' : 'it'} for you. After setup, open Tips
          and run “Integrate {othersNames} with Komla”. Komla starts{' '}
          {others.length > 1 ? 'each agent' : 'the agent'} with a setup prompt, and it adds Komla’s
          hooks itself, asking before it changes a file.
        </Callout>
      )}

      <p className="text-xs text-muted-foreground">
        Every Komla terminal has the <code className="font-mono text-foreground">komla</code>{' '}
        command for starting agents, opening previews and more. To teach your agents about it,
        install the Komla skill from Tips later.{' '}
        <a
          href={`${window.api.websiteUrl}/komla-cli`}
          className="underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
          target="_blank"
          rel="noopener noreferrer"
        >
          CLI docs ↗
        </a>
      </p>
    </div>
  );
}
