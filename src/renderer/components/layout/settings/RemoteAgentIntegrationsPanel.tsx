import { Info } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Callout } from '@/components/ui/callout';
import { reportsOwnStatus } from '@/lib/agent-status-reports';
import { offerAgentLaunchDefaults } from '@/stores/agent-launch-defaults-dialog.store';
import { useToastStore } from '@/stores/toast.store';

import {
  ConfiguredAction,
  ConfiguredDot,
  EnableButton,
  IntegrationItem,
  NotificationUpdateAction,
  SectionShell,
} from './AgentIntegrationParts';
import { FormError } from './FormError';
import { HooksHelp, KomlaSkillHelp, McpHelp, mcpServerNote } from './IntegrationHelp';
import { OtherAgentCallout } from './OtherAgentCallout';

import type { SshAgent, SshHost, SshIntegrationStatus, SshIntegrationType } from '@/types';

const AGENT_LABELS: Record<SshAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  antigravity: 'Antigravity CLI',
  opencode: 'OpenCode',
};

const AGENT_DESCRIPTIONS: Record<SshAgent, string> = {
  claude: 'Hooks, MCP server',
  codex: 'Hooks, MCP server',
  antigravity: 'Hooks, MCP server',
  opencode: 'Hooks, MCP server',
};

const INTEGRATION_LABELS: Record<SshIntegrationType, string> = {
  notifications: 'hooks',
  mcp: 'MCP server',
};

const SSH_AGENTS = Object.keys(AGENT_LABELS) as SshAgent[];

type RemoteIntegrationTarget = { kind: 'ssh'; host: SshHost };

/** Whether agents on the host can start other agents through the Komla skill or MCP. */
const launchesAgents = (status: SshIntegrationStatus) =>
  status.komlaSkill || SSH_AGENTS.some((agent) => status[agent]?.mcp);

export function RemoteAgentIntegrationsPanel({
  target,
  agentFilter,
  initialStatus = null,
  onUpdateAgentsChange,
  onLaunchIntegrationChange,
}: {
  target: RemoteIntegrationTarget;
  agentFilter?: SshAgent;
  /** The target's status when the caller already read it, so the list doesn't open on "Checking". */
  initialStatus?: SshIntegrationStatus | null;
  /** Reports the agents whose notification setup needs an update after each check. */
  onUpdateAgentsChange?: (agents: SshAgent[]) => void;
  /**
   * Takes over offering the launch defaults, for a caller that shows them later: true once the
   * skill or an MCP server is turned on, and false once a removal leaves the host with neither.
   */
  onLaunchIntegrationChange?: (on: boolean) => void;
}) {
  const addToast = useToastStore((state) => state.addToast);
  const [status, setStatus] = useState<SshIntegrationStatus | null>(initialStatus);
  const [statusLabel, setStatusLabel] = useState(initialStatus ? '' : 'Checking...');
  const [expandedAgents, setExpandedAgents] = useState<Record<string, boolean>>({});
  const [integrationLoading, setIntegrationLoading] = useState<Record<string, boolean>>({});
  const [integrationError, setIntegrationError] = useState<string | null>(null);
  const [integrationPrompt, setIntegrationPrompt] = useState<string | null>(null);

  // Keeps the last status on screen while it rechecks, so the rows don't blank after each change.
  const loadStatus = async (): Promise<SshIntegrationStatus | null> => {
    try {
      const nextStatus = await window.api.getSshIntegrationStatus(target.host.id);
      setStatus(nextStatus);
      onUpdateAgentsChange?.(SSH_AGENTS.filter((agent) => nextStatus[agent]?.update));
      setStatusLabel('');
      return nextStatus;
    } catch (error) {
      setStatus(null);
      setStatusLabel('Unavailable');
      setIntegrationError((error as Error).message || 'Failed to check agent integrations.');
      return null;
    }
  };

  // Agents there can start other agents once the skill or an MCP server is on.
  const reportLaunchIntegration = (enabled: boolean, nextStatus: SshIntegrationStatus | null) => {
    if (!onLaunchIntegrationChange) {
      if (enabled) offerAgentLaunchDefaults();
    } else if (enabled) {
      onLaunchIntegrationChange(true);
    } else if (nextStatus && !launchesAgents(nextStatus)) {
      onLaunchIntegrationChange(false);
    }
  };

  useEffect(() => {
    if (!initialStatus) void loadStatus();
    void window.api
      .getMcpStatus(undefined, target.host.id)
      .then((mcpStatus) => setIntegrationPrompt(mcpStatus.generic?.integrationPrompt ?? null))
      .catch(() => setIntegrationPrompt(null));
    // This component is keyed by target, so these requests intentionally run once per selected tab.
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  const targetLabel = target.host.name;

  const reportFailure = (message: string) => {
    setIntegrationError(message);
    // Remote errors can be long, so the toast stays until dismissed and offers a copy.
    addToast(message, 'error', {
      action: navigator.clipboard
        ? { label: 'Copy', onClick: () => void navigator.clipboard.writeText(message) }
        : undefined,
      dismissOnTimeout: false,
    });
  };

  const changeKomlaSkill = async (enabled: boolean) => {
    setIntegrationLoading((current) => ({ ...current, skill: true }));
    setIntegrationError(null);
    try {
      await window.api.setSshKomlaSkill(target.host.id, enabled);
      const nextStatus = await loadStatus();
      addToast(`Komla skill ${enabled ? 'added' : 'removed'} on ${targetLabel}`, 'success');
      reportLaunchIntegration(enabled, nextStatus);
    } catch (error) {
      reportFailure(
        `Failed to ${enabled ? 'add' : 'remove'} the Komla skill: ${(error as Error).message}`
      );
    } finally {
      setIntegrationLoading((current) => ({ ...current, skill: false }));
    }
  };

  const changeIntegration = async (agent: SshAgent, type: SshIntegrationType, enabled: boolean) => {
    const key = `${agent}-${type}`;
    setIntegrationLoading((current) => ({ ...current, [key]: true }));
    setIntegrationError(null);
    try {
      if (enabled) {
        await window.api.enableSshIntegration(target.host.id, agent, type);
      } else {
        await window.api.disableSshIntegration(target.host.id, agent, type);
      }
      const nextStatus = await loadStatus();
      const outcome = enabled ? 'enabled' : 'removed';
      addToast(
        `${AGENT_LABELS[agent]} ${INTEGRATION_LABELS[type]} ${outcome} on ${targetLabel}`,
        'success'
      );
      if (type === 'mcp') reportLaunchIntegration(enabled, nextStatus);
    } catch (error) {
      reportFailure(
        `Failed to ${enabled ? 'enable' : 'remove'} ${INTEGRATION_LABELS[type]}: ${(error as Error).message}`
      );
    } finally {
      setIntegrationLoading((current) => ({ ...current, [key]: false }));
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Hooks and the Komla skill for agents running on this SSH host.
      </p>
      {integrationError && <FormError message={integrationError} />}
      {/* Edge to edge in the card, one agent per row. */}
      <div className="-mx-5 -mb-4 divide-y divide-foreground/8 border-t border-foreground/8">
        <div className="px-2 py-0.5">
          <IntegrationItem
            isConfigured={status?.komlaSkill ?? false}
            label="Komla skill"
            help={<KomlaSkillHelp />}
            description="Teaches your agents how to use the Komla CLI"
            action={
              status?.komlaSkill ? (
                <ConfiguredAction
                  loading={integrationLoading.skill ?? false}
                  onRemove={() => void changeKomlaSkill(false)}
                />
              ) : (
                <EnableButton
                  loading={integrationLoading.skill ?? false}
                  disabled={!status || (integrationLoading.skill ?? false)}
                  onClick={() => void changeKomlaSkill(true)}
                />
              )
            }
          />
        </div>
        {(agentFilter ? [agentFilter] : SSH_AGENTS).map((agent) => {
          const agentStatus = status?.[agent];
          const configured = agentStatus?.notifications ?? false;
          const notificationsLoading = integrationLoading[`${agent}-notifications`] ?? false;
          const mcpLoading = integrationLoading[`${agent}-mcp`] ?? false;

          return (
            <SectionShell
              key={agent}
              title={AGENT_LABELS[agent]}
              // Each agent's key is its command.
              command={agent}
              description={AGENT_DESCRIPTIONS[agent]}
              expanded={expandedAgents[agent] ?? false}
              onToggle={() =>
                setExpandedAgents((current) => ({ ...current, [agent]: !current[agent] }))
              }
              statusDot={<ConfiguredDot isConfigured={configured} />}
              needsUpdate={!!agentStatus?.update}
              statusLabel={status ? (configured ? 'Configured' : 'Not configured') : statusLabel}
            >
              <IntegrationItem
                isConfigured={agentStatus?.notifications ?? false}
                outdated={!!agentStatus?.update}
                label="Hooks"
                help={<HooksHelp agent={AGENT_LABELS[agent]} integration={agent} />}
                action={
                  agentStatus?.update ? (
                    <NotificationUpdateAction
                      update={agentStatus.update}
                      preview={agentStatus.update.preview}
                      loading={notificationsLoading}
                      onApply={() => void changeIntegration(agent, 'notifications', true)}
                      onRemove={() => void changeIntegration(agent, 'notifications', false)}
                    />
                  ) : !agentStatus?.notifications ? (
                    <EnableButton
                      loading={notificationsLoading}
                      disabled={!status || notificationsLoading}
                      onClick={() => void changeIntegration(agent, 'notifications', true)}
                    />
                  ) : (
                    <ConfiguredAction
                      loading={notificationsLoading}
                      onRemove={() => void changeIntegration(agent, 'notifications', false)}
                    />
                  )
                }
                warning={
                  agent === 'codex' && (
                    <Callout
                      tone="warning"
                      size="sm"
                      icon={<Info className="size-3.5" />}
                      className="ml-4 gap-2 py-2 text-xs"
                    >
                      <span className="font-medium">
                        Codex won&rsquo;t run the Komla hooks until you approve them.
                      </span>{' '}
                      After enabling, run <code className="font-mono">/hooks</code> inside Codex,
                      then select and approve each Komla hook individually. Until you do,{' '}
                      {reportsOwnStatus('codex') ? (
                        'workspace titles won’t follow the chat.'
                      ) : (
                        <>
                          notifications won&rsquo;t fire at all. Codex{' '}
                          <code className="font-mono">/review</code> may also skip the normal
                          completion hook, which can leave the activity spinner on until the next
                          completion event.
                        </>
                      )}
                    </Callout>
                  )
                }
              />
              <IntegrationItem
                isConfigured={agentStatus?.mcp ?? false}
                label="MCP Server"
                help={<McpHelp agent={AGENT_LABELS[agent]} />}
                {...mcpServerNote}
                action={
                  agentStatus?.mcp ? (
                    <ConfiguredAction
                      loading={mcpLoading}
                      onRemove={() => void changeIntegration(agent, 'mcp', false)}
                    />
                  ) : (
                    <EnableButton
                      loading={mcpLoading}
                      disabled={!status || mcpLoading}
                      onClick={() => void changeIntegration(agent, 'mcp', true)}
                    />
                  )
                }
                warning={
                  // The MCP server reaches Komla through the terminal's reverse tunnel.
                  <p className="ml-4 text-xs leading-relaxed text-muted-foreground">
                    Available while a Komla SSH terminal for this host is open.
                  </p>
                }
              />
            </SectionShell>
          );
        })}
        {!agentFilter && (
          <SectionShell
            title="Other Agent CLIs"
            description="Hooks and MCP for any compatible agent"
            expanded={expandedAgents.other ?? false}
            onToggle={() => setExpandedAgents((current) => ({ ...current, other: !current.other }))}
            statusDot={<ConfiguredDot isConfigured={false} />}
            statusLabel="Manual"
          >
            <div className="p-3">
              <OtherAgentCallout
                integrationPrompt={integrationPrompt}
                launchButtonTone="subtle"
                workspacePrefill={{ sshHostId: target.host.id }}
              />
            </div>
          </SectionShell>
        )}
      </div>
    </div>
  );
}
