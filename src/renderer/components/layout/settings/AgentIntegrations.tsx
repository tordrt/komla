import {
  BellRinging,
  Check,
  Cloud,
  Copy,
  Desktop,
  Plugs,
  TerminalWindow,
  Warning,
} from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { IconButton } from '@/components/ui/icon-button';
import { KomlaMark } from '@/components/ui/komla-mark';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { lastUsedIntegrationTarget, type IntegrationTarget } from '@/lib/integration-target';
import { cn } from '@/lib/utils';
import { offerAgentLaunchDefaults } from '@/stores/agent-launch-defaults-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { KomlaCliIntegration } from '../KomlaCliIntegration';

import {
  AGENT_NAMES,
  AgentIcon,
  CollapsibleIntegrationGroup,
  ConfiguredAction,
  ConfiguredBadge,
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
import { RemoteAgentIntegrationsPanel } from './RemoteAgentIntegrationsPanel';
import { SETTINGS_CARD_CLASS, SettingsCard } from './SettingsCard';

import type { NotificationIntegrationUpdate } from '../../../../shared/types/notification-integration';
import type { KomlaSkillStatus, McpStatus, SshAgent } from '@/types';
import type { ReactNode } from 'react';

interface NotificationInfo {
  update?: NotificationIntegrationUpdate;
  command: string;
  configJson: string;
  settingsPath: string;
  port: number;
  isConfigured: boolean;
}

interface CodexNotificationInfo {
  update?: NotificationIntegrationUpdate;
  command: string;
  configJson: string;
  settingsPath: string;
  port: number;
  isConfigured: boolean;
  hasConflict: boolean;
  canAutoConfigure: boolean;
  conflictMessage: string | null;
}

// Electron wraps main-process errors as "Error invoking remote method '<channel>': Error: <message>".
function getIpcErrorMessage(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error)) return fallback;
  return (
    cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') || fallback
  );
}

interface OpenCodeNotificationInfo {
  update?: NotificationIntegrationUpdate;
  pluginContent: string;
  pluginPath: string;
  port: number;
  isConfigured: boolean;
}

/** What a link into the menu is for: an agent's integrations, or other agents' setup. */
export type SectionKey = AgentIntegrationFilter | 'generic';

interface CopyApi {
  copiedField: string | null;
  copyToClipboard: (text: string, field: string) => void;
}

// Built-in agents with a one-click Komla integration.
export type AgentIntegrationFilter = 'claude' | 'codex' | 'antigravity' | 'opencode';

// Card title used when the panel is scoped to a single agent (e.g. surfaced
// inside the agent-preset editor as an integrate-now nudge).
const AGENT_FILTER_LABELS: Record<AgentIntegrationFilter, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity CLI',
  opencode: 'OpenCode',
};

/** The one-click integration for an agent template, if it has one. */
export function integrationFilterForAgent(agentName: string): AgentIntegrationFilter | undefined {
  return (Object.keys(AGENT_FILTER_LABELS) as AgentIntegrationFilter[]).find(
    (filter) => AGENT_FILTER_LABELS[filter] === agentName
  );
}

export function AgentIntegrationsPanel({
  agentFilter,
  openSection,
  selfSetupPresetId,
  target: controlledTarget,
  onTargetChange,
}: {
  // When set, render only this agent's section — no generic section.
  agentFilter?: AgentIntegrationFilter;
  /** What a link came for; other agents' setup starts expanded for it. */
  openSection?: SectionKey;
  /** The agent the self-integration skill launches with, instead of New Workspace's default. */
  selfSetupPresetId?: string;
  /** The selected environment tab when the caller owns it. Otherwise the panel
   * opens on where the last workspace was created. */
  target?: IntegrationTarget;
  onTargetChange?: (target: IntegrationTarget) => void;
} = {}) {
  const sshHosts = useSshHostsStore((state) => state.hosts);
  const addToast = useToastStore((s) => s.addToast);
  // Open on where the user last launched a workspace; it falls back to this
  // computer until that SSH host is known.
  const [ownTarget, setOwnTarget] = useState<IntegrationTarget>(
    () => controlledTarget ?? lastUsedIntegrationTarget(useWorkspacesStore.getState().workspaces)
  );
  const integrationTarget = controlledTarget ?? ownTarget;
  // SSH hosts are only contacted once opened.
  const [openedIntegrationTargets, setOpenedIntegrationTargets] = useState<Set<IntegrationTarget>>(
    () => new Set(['local', integrationTarget])
  );
  // A caller can move the tab, e.g. off a deleted host, so the shown target counts as opened.
  const isTargetOpened = (target: IntegrationTarget) =>
    openedIntegrationTargets.has(target) || target === integrationTarget;
  // Agents needing a notification update per remote target, from its last check.
  const [remoteUpdateAgents, setRemoteUpdateAgents] = useState<
    Partial<Record<IntegrationTarget, SshAgent[]>>
  >({});

  const [notificationInfo, setNotificationInfo] = useState<NotificationInfo | null>(null);
  const [notificationLoading, setNotificationLoading] = useState(false);
  const [antigravityNotificationInfo, setAntigravityNotificationInfo] =
    useState<NotificationInfo | null>(null);
  const [antigravityNotificationLoading, setAntigravityNotificationLoading] = useState(false);
  const [codexNotificationInfo, setCodexNotificationInfo] = useState<CodexNotificationInfo | null>(
    null
  );
  const [codexNotificationLoading, setCodexNotificationLoading] = useState(false);
  const [codexNotificationError, setCodexNotificationError] = useState<string | null>(null);
  const [opencodeNotificationInfo, setOpencodeNotificationInfo] =
    useState<OpenCodeNotificationInfo | null>(null);
  const [opencodeNotificationLoading, setOpencodeNotificationLoading] = useState(false);

  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [mcpChecking, setMcpChecking] = useState(true);
  // Why the MCP status couldn't be read, for the whole MCP tier.
  const [mcpLoadError, setMcpLoadError] = useState<string | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [codexMcpLoading, setCodexMcpLoading] = useState(false);
  const [codexMcpError, setCodexMcpError] = useState<string | null>(null);
  const [antigravityMcpLoading, setAntigravityMcpLoading] = useState(false);
  const [antigravityMcpError, setAntigravityMcpError] = useState<string | null>(null);

  const [skillStatus, setSkillStatus] = useState<KomlaSkillStatus | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  // Why the skill's status couldn't be read, apart from why a change to it failed.
  const [skillLoadError, setSkillLoadError] = useState<string | null>(null);

  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  // Every agent's hooks are always in view, so only other agents' setup opens for a link.
  const [otherExpanded, setOtherExpanded] = useState(
    () => !agentFilter && openSection === 'generic'
  );
  const [mcpExpanded, setMcpExpanded] = useState(false);
  // Why each agent's hook details couldn't be read, so its row says so instead of spinning.
  const [hookLoadErrors, setHookLoadErrors] = useState<
    Partial<Record<AgentIntegrationFilter, string>>
  >({});
  const setHookLoadError = (agent: AgentIntegrationFilter, err: unknown) =>
    setHookLoadErrors((current) => {
      const message =
        err === null ? undefined : getIpcErrorMessage(err, 'Couldn’t check its hooks');
      return current[agent] === message ? current : { ...current, [agent]: message };
    });
  const [komlaBasePath, setKomlaBasePath] = useState<string | null>(null);
  const activeIntegrationTarget =
    integrationTarget.startsWith('ssh:') &&
    sshHosts.some((host) => `ssh:${host.id}` === integrationTarget)
      ? integrationTarget
      : 'local';

  const loadNotificationInfo = async () => {
    try {
      const info = await window.api.getNotificationHookDetails();
      setNotificationInfo(info);
      setHookLoadError('claude', null);
    } catch (err) {
      console.error('Failed to load notification info:', err);
      setHookLoadError('claude', err);
    }
  };

  const loadAntigravityNotificationInfo = async () => {
    try {
      const info = await window.api.getAntigravityNotificationHookDetails();
      setAntigravityNotificationInfo(info);
      setHookLoadError('antigravity', null);
    } catch (err) {
      console.error('Failed to load Antigravity notification info:', err);
      setHookLoadError('antigravity', err);
    }
  };

  const loadMcpStatus = async () => {
    try {
      const status = await window.api.getMcpStatus();
      setMcpStatus(status);
      setMcpError(null);
      setMcpLoadError(null);
    } catch (err) {
      console.error('Failed to load MCP status:', err);
      setMcpLoadError(getIpcErrorMessage(err, 'Couldn’t check the MCP server'));
    } finally {
      setMcpChecking(false);
    }
  };

  const loadSkillStatus = async () => {
    try {
      setSkillStatus(await window.api.getKomlaSkillStatus());
      setSkillLoadError(null);
    } catch (err) {
      console.error('Failed to load the Komla skill status:', err);
      setSkillLoadError(getIpcErrorMessage(err, 'Couldn’t check the Komla skill'));
    }
  };

  const handleToggleSkill = async (on: boolean) => {
    setSkillLoading(true);
    setSkillError(null);
    try {
      await (on ? window.api.enableKomlaSkill() : window.api.disableKomlaSkill());
      addToast(on ? 'Komla skill added' : 'Komla skill removed', 'success');
      if (on) offerAgentLaunchDefaults();
    } catch (err) {
      setSkillError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      await loadSkillStatus();
      setSkillLoading(false);
    }
  };

  const loadCodexNotificationInfo = async () => {
    try {
      const info = await window.api.getCodexNotificationHookDetails();
      setCodexNotificationInfo(info);
      setCodexNotificationError(null);
    } catch (err) {
      setCodexNotificationError(getIpcErrorMessage(err, 'Couldn’t check its hooks'));
    }
  };

  const loadOpencodeNotificationInfo = async () => {
    try {
      const info = await window.api.getOpenCodeNotificationHookDetails();
      setOpencodeNotificationInfo(info);
      setHookLoadError('opencode', null);
    } catch (err) {
      console.error('Failed to load OpenCode notification info:', err);
      setHookLoadError('opencode', err);
    }
  };

  // Load data on mount (intentional one-shot — deps intentionally empty).
  // When rendered filtered to a single agent, only that agent's config is
  // loaded; MCP status is shared so it always loads.
  useEffect(() => {
    void loadMcpStatus();
    void loadSkillStatus();
    if (!agentFilter || agentFilter === 'claude') void loadNotificationInfo();
    if (!agentFilter || agentFilter === 'codex') void loadCodexNotificationInfo();
    if (!agentFilter || agentFilter === 'antigravity') void loadAntigravityNotificationInfo();
    if (!agentFilter || agentFilter === 'opencode') void loadOpencodeNotificationInfo();
    // The Integrations page shows the CLI under MCP and CLI access; an agent's editor shows it here.
    if (agentFilter) void window.api.getBasePath().then((path) => setKomlaBasePath(path));
    void window.api
      .getCachedSshIntegrationUpdates()
      .then((updates) =>
        // A tab checked since mounting is fresher than the cached result.
        setRemoteUpdateAgents((current) => ({
          ...Object.fromEntries(
            Object.entries(updates).map(([hostId, agents]) => [
              `ssh:${hostId}`,
              Object.keys(agents) as SshAgent[],
            ])
          ),
          ...current,
        }))
      )
      .catch((err) => console.error('Failed to load cached SSH integration updates:', err));
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  const handleAddNotifications = async () => {
    setNotificationLoading(true);
    try {
      await window.api.enableNotifications();
      await loadNotificationInfo();
      addToast('Claude Code hooks added', 'success');
    } catch (err) {
      console.error('Failed to add notifications:', err);
      addToast(getIpcErrorMessage(err, 'Hooks update failed'), 'error');
    } finally {
      setNotificationLoading(false);
    }
  };

  const handleRemoveNotifications = async () => {
    setNotificationLoading(true);
    try {
      await window.api.disableNotifications();
      await loadNotificationInfo();
      addToast('Claude Code hooks removed', 'success');
    } catch (err) {
      console.error('Failed to remove notifications:', err);
      addToast(getIpcErrorMessage(err, 'Hooks update failed'), 'error');
    } finally {
      setNotificationLoading(false);
    }
  };

  const handleAddAntigravityNotifications = async () => {
    setAntigravityNotificationLoading(true);
    try {
      await window.api.enableAntigravityNotifications();
      await loadAntigravityNotificationInfo();
      addToast('Antigravity hooks added', 'success');
    } catch (err) {
      console.error('Failed to add Antigravity notifications:', err);
      addToast(getIpcErrorMessage(err, 'Hooks update failed'), 'error');
    } finally {
      setAntigravityNotificationLoading(false);
    }
  };

  const handleRemoveAntigravityNotifications = async () => {
    setAntigravityNotificationLoading(true);
    try {
      await window.api.disableAntigravityNotifications();
      await loadAntigravityNotificationInfo();
      addToast('Antigravity hooks removed', 'success');
    } catch (err) {
      console.error('Failed to remove Antigravity notifications:', err);
      addToast(getIpcErrorMessage(err, 'Hooks update failed'), 'error');
    } finally {
      setAntigravityNotificationLoading(false);
    }
  };

  const handleAddCodexNotifications = async () => {
    setCodexNotificationLoading(true);
    setCodexNotificationError(null);
    try {
      await window.api.enableCodexNotifications();
      await loadCodexNotificationInfo();
      addToast('Codex hooks added', 'success');
    } catch (err) {
      setCodexNotificationError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      setCodexNotificationLoading(false);
    }
  };

  const handleRemoveCodexNotifications = async () => {
    setCodexNotificationLoading(true);
    setCodexNotificationError(null);
    try {
      await window.api.disableCodexNotifications();
      await loadCodexNotificationInfo();
      addToast('Codex hooks removed', 'success');
    } catch (err) {
      setCodexNotificationError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      setCodexNotificationLoading(false);
    }
  };

  const handleForceEnableCodexNotifications = async () => {
    const confirmed = await window.api.showMessageBox({
      type: 'warning',
      title: 'Existing Codex Notify Config',
      message: 'Replace existing notify configuration?',
      detail:
        'Komla will:\n' +
        '• Create a backup at ~/.codex/config.toml.komla-backup-<timestamp>\n' +
        '• Remove your current notify config\n' +
        '• Install Komla hooks\n\n' +
        'You can restore the original config manually if needed.',
      buttons: ['Cancel', 'Replace and Enable'],
      cancelId: 0,
      defaultId: 0,
    });

    if (confirmed !== 1) {
      return;
    }

    setCodexNotificationLoading(true);
    setCodexNotificationError(null);
    try {
      const result = await window.api.enableCodexNotificationsForce();
      if (result.success) {
        addToast(
          result.backupPath
            ? `Codex hooks enabled! Backup: ${result.backupPath}`
            : 'Codex hooks enabled!',
          'success'
        );
        await loadCodexNotificationInfo();
      } else {
        setCodexNotificationError(result.error || 'Failed to enable hooks');
      }
    } catch (err) {
      setCodexNotificationError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      setCodexNotificationLoading(false);
    }
  };

  const handleAddOpencodeNotifications = async () => {
    setOpencodeNotificationLoading(true);
    try {
      await window.api.enableOpenCodeNotifications();
      await loadOpencodeNotificationInfo();
      addToast('OpenCode hooks added', 'success');
    } catch (err) {
      console.error('Failed to add OpenCode notifications:', err);
      addToast(getIpcErrorMessage(err, 'Hooks update failed'), 'error');
    } finally {
      setOpencodeNotificationLoading(false);
    }
  };

  const handleRemoveOpencodeNotifications = async () => {
    setOpencodeNotificationLoading(true);
    try {
      await window.api.disableOpenCodeNotifications();
      await loadOpencodeNotificationInfo();
      addToast('OpenCode hooks removed', 'success');
    } catch (err) {
      console.error('Failed to remove OpenCode notifications:', err);
    } finally {
      setOpencodeNotificationLoading(false);
    }
  };

  const handleRunMcpCli = async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const result = await window.api.runMcpCli();
      if (result.success) {
        await loadMcpStatus();
        addToast('MCP server added', 'success');
        offerAgentLaunchDefaults();
      } else {
        setMcpError(result.error || 'Command failed');
      }
    } catch (err) {
      setMcpError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      setMcpLoading(false);
    }
  };

  const handleRemoveMcp = async () => {
    setMcpLoading(true);
    setMcpError(null);
    try {
      const result = await window.api.runMcpRemoveCli();
      if (result.success) {
        await loadMcpStatus();
        addToast('MCP server removed', 'success');
      } else {
        setMcpError(result.error || 'Failed to remove MCP');
      }
    } catch (err) {
      setMcpError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      setMcpLoading(false);
    }
  };

  const handleRunCodexMcpCli = async () => {
    setCodexMcpLoading(true);
    setCodexMcpError(null);
    try {
      const result = await window.api.runCodexMcpCli();
      if (result.success) {
        await loadMcpStatus();
        addToast('Codex MCP server added', 'success');
        offerAgentLaunchDefaults();
      } else {
        setCodexMcpError(result.error || 'Command failed');
      }
    } catch (err) {
      setCodexMcpError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      setCodexMcpLoading(false);
    }
  };

  const handleRemoveCodexMcp = async () => {
    setCodexMcpLoading(true);
    setCodexMcpError(null);
    try {
      const result = await window.api.runCodexMcpRemoveCli();
      if (result.success) {
        await loadMcpStatus();
        addToast('Codex MCP server removed', 'success');
      } else {
        setCodexMcpError(result.error || 'Failed to remove MCP');
      }
    } catch (err) {
      setCodexMcpError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      setCodexMcpLoading(false);
    }
  };

  const handleRunAntigravityMcpCli = async () => {
    setAntigravityMcpLoading(true);
    setAntigravityMcpError(null);
    try {
      const result = await window.api.runAntigravityMcpCli();
      if (result.success) {
        await loadMcpStatus();
        addToast('Antigravity MCP server added', 'success');
        offerAgentLaunchDefaults();
      } else {
        setAntigravityMcpError(result.error || 'Command failed');
      }
    } catch (err) {
      setAntigravityMcpError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      setAntigravityMcpLoading(false);
    }
  };

  const handleRemoveAntigravityMcp = async () => {
    setAntigravityMcpLoading(true);
    setAntigravityMcpError(null);
    try {
      const result = await window.api.runAntigravityMcpRemoveCli();
      if (result.success) {
        await loadMcpStatus();
        addToast('Antigravity MCP server removed', 'success');
      } else {
        setAntigravityMcpError(result.error || 'Failed to remove MCP');
      }
    } catch (err) {
      setAntigravityMcpError(getIpcErrorMessage(err, 'Update failed'));
    } finally {
      setAntigravityMcpLoading(false);
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    window.api.copyToClipboard(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const localNeedsUpdate = [
    notificationInfo,
    codexNotificationInfo,
    antigravityNotificationInfo,
    opencodeNotificationInfo,
  ].some((info) => info?.update);
  const remoteNeedsUpdate = (target: IntegrationTarget) =>
    (remoteUpdateAgents[target] ?? []).some((agent) => !agentFilter || agent === agentFilter);
  const setTargetUpdateAgents = (target: IntegrationTarget) => (agents: SshAgent[]) =>
    setRemoteUpdateAgents((current) => ({ ...current, [target]: agents }));

  const copyApi: CopyApi = { copiedField, copyToClipboard };
  const shows = (agent: AgentIntegrationFilter) => !agentFilter || agentFilter === agent;

  return (
    <>
      <SettingsCard
        plain
        title={
          agentFilter ? `${AGENT_FILTER_LABELS[agentFilter]} integration` : 'Agent integrations'
        }
        description={
          agentFilter
            ? `Enable hooks and the Komla skill so ${AGENT_FILTER_LABELS[agentFilter]} works fully with Komla.`
            : undefined
        }
      >
        {sshHosts.length > 0 && (
          <Tabs
            value={activeIntegrationTarget}
            onValueChange={(value) => {
              const target = value as IntegrationTarget;
              setOwnTarget(target);
              setOpenedIntegrationTargets((current) => new Set(current).add(target));
              onTargetChange?.(target);
            }}
          >
            <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 rounded-lg border bg-muted/40 p-1">
              <IntegrationTargetTab
                value="local"
                icon={<Desktop className="size-3.5" />}
                label="Local Machine"
                needsUpdate={localNeedsUpdate}
              />
              {sshHosts.map((host) => (
                <IntegrationTargetTab
                  key={host.id}
                  value={`ssh:${host.id}`}
                  icon={<Cloud className="size-3.5" />}
                  label={host.name}
                  needsUpdate={remoteNeedsUpdate(`ssh:${host.id}`)}
                />
              ))}
            </TabsList>
          </Tabs>
        )}
        <div hidden={activeIntegrationTarget !== 'local'}>
          <div className="space-y-3">
            <IntegrationGroup
              icon={<BellRinging />}
              title="Hooks"
              badge={<RecommendedBadge />}
              description={HOOKS_DESCRIPTION}
            >
              {shows('claude') &&
                (notificationInfo ? (
                  <ClaudeNotificationItem
                    info={notificationInfo}
                    loading={notificationLoading}
                    expandedDetail={expandedDetail}
                    setExpandedDetail={setExpandedDetail}
                    copy={copyApi}
                    onAdd={handleAddNotifications}
                    onRemove={handleRemoveNotifications}
                  />
                ) : (
                  <CheckingItem agent="claude" error={hookLoadErrors.claude} />
                ))}
              {shows('codex') &&
                (codexNotificationInfo ? (
                  <CodexNotificationItem
                    info={codexNotificationInfo}
                    loading={codexNotificationLoading}
                    error={codexNotificationError}
                    expandedDetail={expandedDetail}
                    setExpandedDetail={setExpandedDetail}
                    copy={copyApi}
                    onAdd={handleAddCodexNotifications}
                    onRemove={handleRemoveCodexNotifications}
                    onForceEnable={handleForceEnableCodexNotifications}
                  />
                ) : (
                  <CheckingItem agent="codex" error={codexNotificationError} />
                ))}
              {shows('antigravity') &&
                (antigravityNotificationInfo ? (
                  <AntigravityNotificationItem
                    info={antigravityNotificationInfo}
                    loading={antigravityNotificationLoading}
                    expandedDetail={expandedDetail}
                    setExpandedDetail={setExpandedDetail}
                    copy={copyApi}
                    onAdd={handleAddAntigravityNotifications}
                    onRemove={handleRemoveAntigravityNotifications}
                  />
                ) : (
                  <CheckingItem agent="antigravity" error={hookLoadErrors.antigravity} />
                ))}
              {shows('opencode') &&
                (opencodeNotificationInfo ? (
                  <OpenCodeNotificationItem
                    info={opencodeNotificationInfo}
                    loading={opencodeNotificationLoading}
                    expandedDetail={expandedDetail}
                    setExpandedDetail={setExpandedDetail}
                    copy={copyApi}
                    onAdd={handleAddOpencodeNotifications}
                    onRemove={handleRemoveOpencodeNotifications}
                  />
                ) : (
                  <CheckingItem agent="opencode" error={hookLoadErrors.opencode} />
                ))}
              {!agentFilter && (
                <OtherAgentsRow
                  description="They can set themselves up"
                  expanded={otherExpanded}
                  onToggle={() => setOtherExpanded((current) => !current)}
                >
                  {mcpChecking ? (
                    <Spinner size="xs" className="text-muted-foreground" />
                  ) : (
                    <>
                      <OtherAgentCallout
                        integrationPrompt={mcpStatus?.generic?.integrationPrompt}
                        setsUpThisComputer
                        workspacePrefill={
                          selfSetupPresetId ? { presetIds: [selfSetupPresetId] } : undefined
                        }
                      />
                      {!mcpStatus?.generic && <FormError message={mcpLoadError} />}
                      {mcpStatus?.generic && (
                        <ManualHookCommands
                          generic={mcpStatus.generic}
                          expandedDetail={expandedDetail}
                          setExpandedDetail={setExpandedDetail}
                          copy={copyApi}
                        />
                      )}
                    </>
                  )}
                </OtherAgentsRow>
              )}
            </IntegrationGroup>
            <IntegrationGroup
              icon={<TerminalWindow />}
              title="Komla CLI"
              description={KOMLA_CLI_DESCRIPTION}
            >
              <KomlaSkillItem
                status={skillStatus}
                loading={skillLoading}
                // Why a change failed matters more than why the recheck after it did.
                error={skillError ?? skillLoadError}
                expandedDetail={expandedDetail}
                setExpandedDetail={setExpandedDetail}
                copy={copyApi}
                onToggle={(on) => void handleToggleSkill(on)}
              />
            </IntegrationGroup>
            <CollapsibleIntegrationGroup
              icon={<Plugs />}
              title="MCP server"
              description={MCP_DESCRIPTION}
              summary={mcpSummary(mcpChecking, mcpStatus, shows)}
              expanded={mcpExpanded}
              onToggle={() => setMcpExpanded((current) => !current)}
            >
              {/* Why the status couldn't be read: in place of the rows on the first check, or above
                  the last status after a recheck. */}
              {mcpLoadError && (
                <div className="px-3 py-2.5">
                  <FormError message={mcpLoadError} />
                </div>
              )}
              {(mcpChecking || mcpStatus) && (
                <>
                  {shows('claude') && (
                    <ClaudeMcpItem
                      mcpStatus={mcpStatus}
                      mcpChecking={mcpChecking}
                      loading={mcpLoading}
                      error={mcpError}
                      expandedDetail={expandedDetail}
                      setExpandedDetail={setExpandedDetail}
                      copy={copyApi}
                      onAdd={handleRunMcpCli}
                      onRemove={handleRemoveMcp}
                    />
                  )}
                  {shows('codex') && mcpStatus?.codex && (
                    <CodexMcpItem
                      mcp={mcpStatus.codex}
                      loading={codexMcpLoading}
                      error={codexMcpError}
                      expandedDetail={expandedDetail}
                      setExpandedDetail={setExpandedDetail}
                      copy={copyApi}
                      onAdd={handleRunCodexMcpCli}
                      onRemove={handleRemoveCodexMcp}
                    />
                  )}
                  {shows('antigravity') && mcpStatus?.antigravity && (
                    <AntigravityMcpItem
                      mcp={mcpStatus.antigravity}
                      loading={antigravityMcpLoading}
                      error={antigravityMcpError}
                      expandedDetail={expandedDetail}
                      setExpandedDetail={setExpandedDetail}
                      copy={copyApi}
                      onAdd={handleRunAntigravityMcpCli}
                      onRemove={handleRemoveAntigravityMcp}
                    />
                  )}
                  {shows('opencode') && mcpStatus?.opencode && (
                    <OpenCodeMcpItem
                      mcp={mcpStatus.opencode}
                      expandedDetail={expandedDetail}
                      setExpandedDetail={setExpandedDetail}
                      copy={copyApi}
                    />
                  )}
                  {!agentFilter && mcpStatus?.generic && (
                    <GenericMcpItem
                      generic={mcpStatus.generic}
                      expandedDetail={expandedDetail}
                      setExpandedDetail={setExpandedDetail}
                      copy={copyApi}
                    />
                  )}
                </>
              )}
            </CollapsibleIntegrationGroup>
          </div>
        </div>
        {sshHosts.map((host) => {
          const target = `ssh:${host.id}` as const;
          return isTargetOpened(target) ? (
            <div key={target} hidden={activeIntegrationTarget !== target}>
              <RemoteAgentIntegrationsPanel
                target={{ kind: 'ssh', host }}
                agentFilter={agentFilter}
                onUpdateAgentsChange={setTargetUpdateAgents(target)}
              />
            </div>
          ) : null;
        })}
        {agentFilter && (
          <div className={cn(SETTINGS_CARD_CLASS, 'px-5 py-4')}>
            <KomlaCliIntegration komlaBasePath={komlaBasePath} />
          </div>
        )}
      </SettingsCard>
    </>
  );
}

// ---------------- Helper components ----------------

/** How many shown agents have the MCP server, or why that isn't known yet. */
function mcpSummary(
  checking: boolean,
  status: McpStatus | null,
  shows: (agent: AgentIntegrationFilter) => boolean
): string {
  if (checking) return 'Checking...';
  if (!status) return 'Unavailable';
  return enabledSummary([
    shows('claude') && status.isConfigured,
    shows('codex') && !!status.codex?.isConfigured,
    shows('antigravity') && !!status.antigravity?.isConfigured,
    shows('opencode') && !!status.opencode?.isConfigured,
  ]);
}

function CopyIconButton({ text, field, copy }: { text: string; field: string; copy: CopyApi }) {
  return (
    <IconButton
      label={copy.copiedField === field ? 'Copied' : 'Copy to clipboard'}
      size="xs"
      onClick={() => copy.copyToClipboard(text, field)}
    >
      {copy.copiedField === field ? (
        <Check className="size-3 text-success" />
      ) : (
        <Copy className="size-3" />
      )}
    </IconButton>
  );
}

/** Shows or hides a row's details, under its label unless `className` places it elsewhere. */
function DetailToggle({
  active,
  onClick,
  showLabel = 'Show what this changes',
  hideLabel = 'Hide details',
  className,
}: {
  active: boolean;
  onClick: () => void;
  showLabel?: string;
  hideLabel?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={cn(
        'mt-1 ml-6 text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground',
        className
      )}
      aria-expanded={active}
      onClick={onClick}
    >
      {active ? hideLabel : showLabel}
    </button>
  );
}

function FilePathDetail({
  path,
  copyText,
  copyField,
  copy,
  pre,
}: {
  path: string;
  copyText: string;
  copyField: string;
  copy: CopyApi;
  pre?: string;
}) {
  return (
    <div className="ml-6 space-y-1">
      <div className="flex items-center justify-between">
        <span className="font-mono text-ui text-muted-foreground">{path}</span>
        <CopyIconButton text={copyText} field={copyField} copy={copy} />
      </div>
      {pre !== undefined && (
        <pre className="max-h-24 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-ui">
          {pre}
        </pre>
      )}
    </div>
  );
}

/** An agent's row while Komla reads its setup, or why it couldn't. */
function CheckingItem({ agent, error }: { agent: AgentIntegrationFilter; error?: string | null }) {
  return (
    <IntegrationItem
      icon={<AgentIcon name={AGENT_NAMES[agent]} command={agent} />}
      label={AGENT_NAMES[agent]}
      action={error ? null : <Spinner size="xs" className="text-muted-foreground" />}
      errorMessage={error}
    />
  );
}

// ---------------- Per-agent rows ----------------

function KomlaSkillItem({
  status,
  loading,
  error,
  expandedDetail,
  setExpandedDetail,
  copy,
  onToggle,
}: {
  status: KomlaSkillStatus | null;
  loading: boolean;
  error: string | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onToggle: (on: boolean) => void;
}) {
  const detailKey = 'komla-skill';
  const isOpen = expandedDetail === detailKey;
  return (
    <IntegrationItem
      icon={<KomlaMark className="size-4" />}
      label="Komla skill"
      help={<KomlaSkillHelp />}
      note={<KomlaCliHelpNote />}
      detailToggle={
        status && (
          <DetailToggle
            active={isOpen}
            onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
          />
        )
      }
      action={
        !status ? (
          !error && <Spinner size="xs" className="text-muted-foreground" />
        ) : status.isConfigured ? (
          <ConfiguredAction loading={loading} onRemove={() => onToggle(false)} />
        ) : (
          <EnableButton loading={loading} onClick={() => onToggle(true)} />
        )
      }
      errorMessage={error}
      detailContent={
        status &&
        isOpen && (
          <div className="space-y-1">
            {status.paths.map((path) => (
              <FilePathDetail
                key={path}
                path={path}
                copyText={path}
                copyField={`${detailKey}:${path}`}
                copy={copy}
              />
            ))}
          </div>
        )
      }
    />
  );
}

function IntegrationTargetTab({
  value,
  icon,
  label,
  needsUpdate = false,
}: {
  value: IntegrationTarget;
  icon: ReactNode;
  label: string;
  /** Flags the tab so an update stays visible while another target is selected. */
  needsUpdate?: boolean;
}) {
  return (
    <TabsTrigger value={value} className="shrink-0 gap-1.5 rounded-md px-3 py-1.5 text-xs">
      {icon}
      <span className="max-w-40 truncate">{label}</span>
      {needsUpdate && (
        <span
          role="img"
          aria-label="Update available"
          title="Update available"
          className="size-2 shrink-0 rounded-full bg-warning"
        />
      )}
    </TabsTrigger>
  );
}

function ClaudeNotificationItem({
  info,
  loading,
  expandedDetail,
  setExpandedDetail,
  copy,
  onAdd,
  onRemove,
}: {
  info: NotificationInfo;
  loading: boolean;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const detailKey = 'claude-notification';
  const isOpen = expandedDetail === detailKey;
  return (
    <IntegrationItem
      icon={<AgentIcon name={AGENT_NAMES.claude} command="claude" />}
      label={AGENT_NAMES.claude}
      help={<HooksHelp agent="Claude Code" integration="claude" />}
      detailToggle={
        <DetailToggle
          active={isOpen}
          onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
        />
      }
      action={
        info.update ? (
          <NotificationUpdateAction
            update={info.update}
            preview={info.configJson}
            loading={loading}
            onApply={onAdd}
            onRemove={onRemove}
          />
        ) : info.isConfigured ? (
          <ConfiguredAction loading={loading} onRemove={onRemove} />
        ) : (
          <EnableButton loading={loading} onClick={onAdd} />
        )
      }
      detailContent={
        isOpen && (
          <FilePathDetail
            path={info.settingsPath}
            copyText={info.configJson}
            copyField="notification"
            copy={copy}
            pre={info.configJson}
          />
        )
      }
    />
  );
}

function ClaudeMcpItem({
  mcpStatus,
  mcpChecking,
  loading,
  error,
  expandedDetail,
  setExpandedDetail,
  copy,
  onAdd,
  onRemove,
}: {
  mcpStatus: McpStatus | null;
  mcpChecking: boolean;
  loading: boolean;
  error: string | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const detailKey = 'claude-mcp';
  const isOpen = expandedDetail === detailKey;
  const action = renderClaudeMcpAction({
    mcpChecking,
    isConfigured: mcpStatus?.isConfigured ?? false,
    loading,
    onAdd,
    onRemove,
  });
  return (
    <IntegrationItem
      icon={<AgentIcon name={AGENT_NAMES.claude} command="claude" />}
      label={AGENT_NAMES.claude}
      help={<McpHelp agent="Claude Code" />}
      detailToggle={
        mcpStatus && (
          <DetailToggle
            active={isOpen}
            onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
          />
        )
      }
      action={action}
      errorMessage={error}
      detailContent={
        mcpStatus &&
        isOpen && (
          <FilePathDetail
            path={mcpStatus.cliCommand}
            copyText={mcpStatus.configJson}
            copyField="mcp-json"
            copy={copy}
            pre={mcpStatus.configJson}
          />
        )
      }
    />
  );
}

function renderClaudeMcpAction({
  mcpChecking,
  isConfigured,
  loading,
  onAdd,
  onRemove,
}: {
  mcpChecking: boolean;
  isConfigured: boolean;
  loading: boolean;
  onAdd: () => void;
  onRemove: () => void;
}): ReactNode {
  if (mcpChecking) {
    return <Spinner size="xs" className="text-muted-foreground" />;
  }
  if (isConfigured) {
    return <ConfiguredAction loading={loading} onRemove={onRemove} />;
  }
  return <EnableButton loading={loading} onClick={onAdd} />;
}

function AntigravityNotificationItem({
  info,
  loading,
  expandedDetail,
  setExpandedDetail,
  copy,
  onAdd,
  onRemove,
}: {
  info: NotificationInfo;
  loading: boolean;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const detailKey = 'antigravity-notification';
  const isOpen = expandedDetail === detailKey;
  return (
    <IntegrationItem
      icon={<AgentIcon name={AGENT_NAMES.antigravity} command="antigravity" />}
      label={AGENT_NAMES.antigravity}
      help={<HooksHelp agent="Antigravity CLI" integration="antigravity" />}
      detailToggle={
        <DetailToggle
          active={isOpen}
          onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
        />
      }
      action={
        info.update ? (
          <NotificationUpdateAction
            update={info.update}
            preview={info.configJson}
            loading={loading}
            onApply={onAdd}
            onRemove={onRemove}
          />
        ) : info.isConfigured ? (
          <ConfiguredAction loading={loading} onRemove={onRemove} />
        ) : (
          <EnableButton loading={loading} onClick={onAdd} />
        )
      }
      detailContent={
        isOpen && (
          <FilePathDetail
            path={info.settingsPath}
            copyText={info.configJson}
            copyField="antigravity-notification"
            copy={copy}
            pre={info.configJson}
          />
        )
      }
    />
  );
}

function AntigravityMcpItem({
  mcp,
  loading,
  error,
  expandedDetail,
  setExpandedDetail,
  copy,
  onAdd,
  onRemove,
}: {
  mcp: NonNullable<McpStatus['antigravity']>;
  loading: boolean;
  error: string | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const detailKey = 'antigravity-mcp';
  const isOpen = expandedDetail === detailKey;
  return (
    <IntegrationItem
      icon={<AgentIcon name={AGENT_NAMES.antigravity} command="antigravity" />}
      label={AGENT_NAMES.antigravity}
      help={<McpHelp agent="Antigravity CLI" />}
      detailToggle={
        <DetailToggle
          active={isOpen}
          onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
        />
      }
      action={
        mcp.isConfigured ? (
          <ConfiguredAction loading={loading} onRemove={onRemove} />
        ) : (
          <EnableButton loading={loading} onClick={onAdd} />
        )
      }
      errorMessage={error}
      detailContent={
        isOpen && (
          <div className="ml-6 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-mono text-ui text-muted-foreground">{mcp.cliCommand}</span>
              <CopyIconButton text={mcp.cliCommand} field="antigravity-mcp-cli" copy={copy} />
            </div>
          </div>
        )
      }
    />
  );
}

function CodexNotificationItem({
  info,
  loading,
  error,
  expandedDetail,
  setExpandedDetail,
  copy,
  onAdd,
  onRemove,
  onForceEnable,
}: {
  info: CodexNotificationInfo;
  loading: boolean;
  error: string | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAdd: () => void;
  onRemove: () => void;
  onForceEnable: () => void;
}) {
  const detailKey = 'codex-notification';
  const isOpen = expandedDetail === detailKey;
  return (
    <IntegrationItem
      icon={<AgentIcon name={AGENT_NAMES.codex} command="codex" />}
      label={AGENT_NAMES.codex}
      help={<HooksHelp agent="Codex" integration="codex" />}
      detailToggle={
        <DetailToggle
          active={isOpen}
          onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
        />
      }
      action={
        info.update ? (
          <NotificationUpdateAction
            update={info.update}
            preview={info.configJson}
            loading={loading}
            onApply={onAdd}
            onRemove={onRemove}
          />
        ) : (
          renderCodexNotificationAction({ info, loading, onAdd, onRemove, onForceEnable })
        )
      }
      warning={
        <>
          <CodexHookApproval />
          {info.hasConflict && (
            <Callout
              tone="warning"
              size="sm"
              icon={<Warning className="size-3.5" />}
              className="ml-6 px-2"
            >
              {info.conflictMessage}
            </Callout>
          )}
        </>
      }
      errorMessage={error}
      detailContent={
        isOpen && (
          <FilePathDetail
            path={info.settingsPath}
            copyText={info.configJson}
            copyField="codex-notification"
            copy={copy}
            pre={info.configJson}
          />
        )
      }
    />
  );
}

function renderCodexNotificationAction({
  info,
  loading,
  onAdd,
  onRemove,
  onForceEnable,
}: {
  info: CodexNotificationInfo;
  loading: boolean;
  onAdd: () => void;
  onRemove: () => void;
  onForceEnable: () => void;
}): ReactNode {
  if (info.isConfigured) {
    return <ConfiguredAction loading={loading} onRemove={onRemove} />;
  }
  if (info.hasConflict && !info.canAutoConfigure) {
    return (
      <Button
        size="sm"
        onClick={onForceEnable}
        disabled={loading}
        variant="outline"
        className="border-warning/30 text-warning"
      >
        {loading ? <Spinner size="xs" className="mr-1" /> : 'Force Enable'}
      </Button>
    );
  }
  return (
    <EnableButton loading={loading} onClick={onAdd} disabled={loading || !info.canAutoConfigure} />
  );
}

function CodexMcpItem({
  mcp,
  loading,
  error,
  expandedDetail,
  setExpandedDetail,
  copy,
  onAdd,
  onRemove,
}: {
  mcp: NonNullable<McpStatus['codex']>;
  loading: boolean;
  error: string | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const detailKey = 'codex-mcp';
  const isOpen = expandedDetail === detailKey;
  return (
    <IntegrationItem
      icon={<AgentIcon name={AGENT_NAMES.codex} command="codex" />}
      label={AGENT_NAMES.codex}
      help={<McpHelp agent="Codex" />}
      detailToggle={
        <DetailToggle
          active={isOpen}
          onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
        />
      }
      action={
        mcp.isConfigured ? (
          <ConfiguredAction loading={loading} onRemove={onRemove} />
        ) : (
          <EnableButton loading={loading} onClick={onAdd} />
        )
      }
      errorMessage={error}
      detailContent={
        isOpen && (
          <FilePathDetail
            path={mcp.settingsPath}
            copyText={mcp.configToml}
            copyField="codex-mcp-toml"
            copy={copy}
            pre={mcp.configToml}
          />
        )
      }
    />
  );
}

function OpenCodeNotificationItem({
  info,
  loading,
  expandedDetail,
  setExpandedDetail,
  copy,
  onAdd,
  onRemove,
}: {
  info: OpenCodeNotificationInfo;
  loading: boolean;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const detailKey = 'opencode-notification';
  const isOpen = expandedDetail === detailKey;
  return (
    <IntegrationItem
      icon={<AgentIcon name={AGENT_NAMES.opencode} command="opencode" />}
      label={AGENT_NAMES.opencode}
      help={<HooksHelp agent="OpenCode" integration="opencode" />}
      detailToggle={
        <DetailToggle
          active={isOpen}
          onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
        />
      }
      action={
        info.update ? (
          <NotificationUpdateAction
            update={info.update}
            preview={info.pluginContent}
            loading={loading}
            onApply={onAdd}
            onRemove={onRemove}
          />
        ) : info.isConfigured ? (
          <ConfiguredAction loading={loading} onRemove={onRemove} />
        ) : (
          <EnableButton loading={loading} onClick={onAdd} />
        )
      }
      detailContent={
        isOpen && (
          <FilePathDetail
            path={info.pluginPath}
            copyText={info.pluginContent}
            copyField="opencode-notification"
            copy={copy}
            pre={info.pluginContent}
          />
        )
      }
    />
  );
}

function OpenCodeMcpItem({
  mcp,
  expandedDetail,
  setExpandedDetail,
  copy,
}: {
  mcp: NonNullable<McpStatus['opencode']>;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
}) {
  const detailKey = 'opencode-mcp';
  const isOpen = expandedDetail === detailKey;
  // Original behavior: details panel renders when expanded OR when not configured.
  const showDetail = isOpen || !mcp.isConfigured;
  const cliField = 'opencode-mcp-cli';
  const cliCopyText = mcp.cliCommand ?? mcp.configJson;

  return (
    <IntegrationItem
      icon={<AgentIcon name={AGENT_NAMES.opencode} command="opencode" />}
      label={AGENT_NAMES.opencode}
      help={<McpHelp agent="OpenCode" />}
      // Until it's configured, the command always shows, so there's nothing to toggle.
      detailToggle={
        mcp.isConfigured && (
          <DetailToggle
            active={isOpen}
            onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
            showLabel="Show command"
          />
        )
      }
      action={
        mcp.isConfigured ? (
          <ConfiguredBadge />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => copy.copyToClipboard(cliCopyText, cliField)}
          >
            {copy.copiedField === cliField ? (
              <>
                <Check className="mr-1 size-3 text-success" />
                Copied
              </>
            ) : (
              <>
                <Copy className="mr-1 size-3" />
                Copy command
              </>
            )}
          </Button>
        )
      }
      detailContent={
        showDetail && (
          <div className="ml-6 space-y-2">
            {mcp.cliCommand && (
              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-ui text-muted-foreground">Run in your terminal:</span>
                  <CopyIconButton text={mcp.cliCommand} field={cliField} copy={copy} />
                </div>
                <code className="block rounded bg-muted/50 p-2 font-mono text-ui break-all">
                  {mcp.cliCommand}
                </code>
              </div>
            )}
          </div>
        )
      }
    />
  );
}

const NOTIFY_EVENTS: { event: string; fires: string }[] = [
  { event: 'Stop', fires: 'the agent finishes its turn' },
  { event: 'UserPromptSubmit', fires: 'the user sends a new message' },
  { event: 'PermissionRequest', fires: 'the agent waits for your approval' },
  { event: 'Notification', fires: 'the agent has gone idle' },
];

/** How to wire another agent's lifecycle hooks to Komla by hand, behind a link. */
function ManualHookCommands({
  generic,
  expandedDetail,
  setExpandedDetail,
  copy,
}: {
  generic: NonNullable<McpStatus['generic']>;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
}) {
  const detailKey = 'generic-notification';
  const isOpen = expandedDetail === detailKey;
  return (
    <div className="space-y-2">
      <DetailToggle
        active={isOpen}
        onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
        showLabel="Or wire up its hooks yourself"
        hideLabel="Hide hook commands"
        className="mt-0 ml-0"
      />
      {isOpen && (
        <div className="space-y-2">
          <p className="text-ui text-muted-foreground">
            Komla injects its CLI into managed terminals. Hooks can call it to match the{' '}
            <code className="font-mono">cwd</code> to a workspace and update the dock badge or tab
            indicator. Remote notifications are queued durably by the Remote Companion.
          </p>
          <p className="text-ui text-muted-foreground">
            Wire each lifecycle hook to its command — replace{' '}
            <code className="font-mono">my-agent</code> with your agent's name:
          </p>
          <div className="space-y-2">
            {NOTIFY_EVENTS.map(({ event, fires }) => {
              const command = generic.notifyCommand.replace(/--event \S+$/, `--event ${event}`);
              return (
                <div key={event} className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-ui text-muted-foreground">
                      <code className="font-mono text-foreground">{event}</code> — {fires}
                    </span>
                    <CopyIconButton text={command} field={`generic-notify-${event}`} copy={copy} />
                  </div>
                  <pre className="overflow-x-auto rounded bg-muted/50 p-2 font-mono text-ui whitespace-pre-wrap">
                    {command}
                  </pre>
                </div>
              );
            })}
          </div>
          <p className="text-ui text-muted-foreground">
            Each command also accepts the agent's hook payload JSON on stdin.
          </p>
        </div>
      )}
    </div>
  );
}

function GenericMcpItem({
  generic,
  expandedDetail,
  setExpandedDetail,
  copy,
}: {
  generic: NonNullable<McpStatus['generic']>;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
}) {
  const detailKey = 'generic-mcp';
  const isOpen = expandedDetail === detailKey;
  const cliField = 'generic-mcp-cli';
  return (
    <IntegrationItem
      icon={<AgentIcon name="Other agents" />}
      label="Other agents"
      description="Stdio through the Komla CLI"
      action={
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => copy.copyToClipboard(generic.cliCommand, cliField)}
        >
          {copy.copiedField === cliField ? (
            <>
              <Check className="mr-1 size-3 text-success" />
              Copied
            </>
          ) : (
            <>
              <Copy className="mr-1 size-3" />
              Copy command
            </>
          )}
        </Button>
      }
      detailContent={
        <div className="ml-6 space-y-2">
          <code className="block rounded bg-muted/50 p-2 font-mono text-ui break-all">
            {generic.cliCommand}
          </code>
          <DetailToggle
            active={isOpen}
            onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
            showLabel="Show JSON config"
            hideLabel="Hide JSON config"
            className="mt-0 ml-0"
          />
          {isOpen && (
            <pre className="max-h-24 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-ui">
              {generic.configJson}
            </pre>
          )}
        </div>
      }
    />
  );
}
