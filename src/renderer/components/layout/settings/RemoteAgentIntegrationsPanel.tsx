import { BellRinging, Plugs, TerminalWindow } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { KomlaMark } from '@/components/ui/komla-mark';
import { offerAgentLaunchDefaults } from '@/stores/agent-launch-defaults-dialog.store';
import { useToastStore } from '@/stores/toast.store';

import {
  AGENT_NAMES,
  AgentIcon,
  CollapsibleIntegrationGroup,
  ConfiguredAction,
  enabledSummary,
  EnableButton,
  IntegrationGroup,
  IntegrationItem,
  NotificationUpdateAction,
  OtherAgentsRow,
  RecommendedBadge,
} from './AgentIntegrationParts';
import { FormError } from './FormError';
import {
  CodexHookApproval,
  HOOKS_DESCRIPTION,
  HooksHelp,
  KOMLA_CLI_DESCRIPTION,
  KomlaCliHelpNote,
  KomlaSkillHelp,
  MCP_DESCRIPTION,
  McpHelp,
} from './IntegrationHelp';
import { OtherAgentCallout } from './OtherAgentCallout';

import type { SshAgent, SshHost, SshIntegrationStatus, SshIntegrationType } from '@/types';

const INTEGRATION_LABELS: Record<SshIntegrationType, string> = {
  notifications: 'hooks',
  mcp: 'MCP server',
};

const SSH_AGENTS = Object.keys(AGENT_NAMES) as SshAgent[];

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
  showIntro = true,
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
  /** False where the panel sits in a dialog that already says what it's for. */
  showIntro?: boolean;
}) {
  const addToast = useToastStore((state) => state.addToast);
  const [status, setStatus] = useState<SshIntegrationStatus | null>(initialStatus);
  const [statusLabel, setStatusLabel] = useState(initialStatus ? '' : 'Checking...');
  const [otherExpanded, setOtherExpanded] = useState(false);
  const [mcpExpanded, setMcpExpanded] = useState(false);
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
        `${AGENT_NAMES[agent]} ${INTEGRATION_LABELS[type]} ${outcome} on ${targetLabel}`,
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

  const agents = agentFilter ? [agentFilter] : SSH_AGENTS;
  // Each row's action until the host's status is read, or why it couldn't be.
  const pendingAction = <span className="text-ui text-muted-foreground">{statusLabel}</span>;

  return (
    <div className="space-y-4">
      {showIntro && (
        <p className="text-xs text-muted-foreground">
          Hooks and the Komla skill for agents running on this SSH host.
        </p>
      )}
      {integrationError && <FormError message={integrationError} />}
      <div className="space-y-3">
        <IntegrationGroup
          icon={<BellRinging />}
          title="Hooks"
          badge={<RecommendedBadge />}
          description={HOOKS_DESCRIPTION}
        >
          {agents.map((agent) => {
            const agentStatus = status?.[agent];
            const loading = integrationLoading[`${agent}-notifications`] ?? false;
            return (
              <IntegrationItem
                key={agent}
                // Each agent's key is its command.
                icon={<AgentIcon name={AGENT_NAMES[agent]} command={agent} />}
                label={AGENT_NAMES[agent]}
                help={<HooksHelp agent={AGENT_NAMES[agent]} integration={agent} />}
                action={
                  !status ? (
                    pendingAction
                  ) : agentStatus?.update ? (
                    <NotificationUpdateAction
                      update={agentStatus.update}
                      preview={agentStatus.update.preview}
                      loading={loading}
                      onApply={() => void changeIntegration(agent, 'notifications', true)}
                      onRemove={() => void changeIntegration(agent, 'notifications', false)}
                    />
                  ) : !agentStatus?.notifications ? (
                    <EnableButton
                      loading={loading}
                      onClick={() => void changeIntegration(agent, 'notifications', true)}
                    />
                  ) : (
                    <ConfiguredAction
                      loading={loading}
                      onRemove={() => void changeIntegration(agent, 'notifications', false)}
                    />
                  )
                }
                warning={agent === 'codex' && <CodexHookApproval />}
              />
            );
          })}
          {!agentFilter && (
            <OtherAgentsRow
              description="They can set themselves up"
              expanded={otherExpanded}
              onToggle={() => setOtherExpanded((current) => !current)}
            >
              <OtherAgentCallout
                integrationPrompt={integrationPrompt}
                launchButtonTone="subtle"
                workspacePrefill={{ sshHostId: target.host.id }}
              />
            </OtherAgentsRow>
          )}
        </IntegrationGroup>
        <IntegrationGroup
          icon={<TerminalWindow />}
          title="Komla CLI"
          description={KOMLA_CLI_DESCRIPTION}
        >
          <IntegrationItem
            icon={<KomlaMark className="size-4" />}
            label="Komla skill"
            help={<KomlaSkillHelp />}
            note={<KomlaCliHelpNote />}
            action={
              !status ? (
                pendingAction
              ) : status.komlaSkill ? (
                <ConfiguredAction
                  loading={integrationLoading.skill ?? false}
                  onRemove={() => void changeKomlaSkill(false)}
                />
              ) : (
                <EnableButton
                  loading={integrationLoading.skill ?? false}
                  onClick={() => void changeKomlaSkill(true)}
                />
              )
            }
          />
        </IntegrationGroup>
        <CollapsibleIntegrationGroup
          icon={<Plugs />}
          title="MCP server"
          description={
            <>
              {MCP_DESCRIPTION}{' '}
              {/* The MCP server reaches Komla through the terminal's reverse tunnel. */}
              Available while a Komla SSH terminal for this host is open.
            </>
          }
          summary={
            status ? enabledSummary(agents.map((agent) => !!status[agent]?.mcp)) : statusLabel
          }
          expanded={mcpExpanded}
          onToggle={() => setMcpExpanded((current) => !current)}
        >
          {agents.map((agent) => {
            const loading = integrationLoading[`${agent}-mcp`] ?? false;
            return (
              <IntegrationItem
                key={agent}
                icon={<AgentIcon name={AGENT_NAMES[agent]} command={agent} />}
                label={AGENT_NAMES[agent]}
                help={<McpHelp agent={AGENT_NAMES[agent]} />}
                action={
                  !status ? (
                    pendingAction
                  ) : status[agent]?.mcp ? (
                    <ConfiguredAction
                      loading={loading}
                      onRemove={() => void changeIntegration(agent, 'mcp', false)}
                    />
                  ) : (
                    <EnableButton
                      loading={loading}
                      onClick={() => void changeIntegration(agent, 'mcp', true)}
                    />
                  )
                }
              />
            );
          })}
        </CollapsibleIntegrationGroup>
      </div>
    </div>
  );
}
