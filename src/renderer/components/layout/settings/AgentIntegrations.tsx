import { Check, Cloud, Copy, Desktop, Info, Warning } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { reportsOwnStatus } from '@/lib/agent-status-reports';
import { lastUsedIntegrationTarget, type IntegrationTarget } from '@/lib/integration-target';
import { offerAgentLaunchDefaults } from '@/stores/agent-launch-defaults-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { KomlaCliIntegration } from '../KomlaCliIntegration';

import {
  ConfiguredAction,
  ConfiguredBadge,
  ConfiguredDot,
  EnableButton,
  IntegrationItem,
  NotificationUpdateAction,
  SectionShell,
} from './AgentIntegrationParts';
import { HooksHelp, hooksSummary, KomlaSkillHelp, McpHelp, mcpServerNote } from './IntegrationHelp';
import { OtherAgentCallout } from './OtherAgentCallout';
import { RemoteAgentIntegrationsPanel } from './RemoteAgentIntegrationsPanel';
import { SettingsCard } from './SettingsCard';

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

type ExpandedSections = {
  claude: boolean;
  antigravity: boolean;
  codex: boolean;
  opencode: boolean;
  generic: boolean;
};

export type SectionKey = keyof ExpandedSections;

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
  /** The section that starts expanded, such as the agent a link came for. */
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
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [codexMcpLoading, setCodexMcpLoading] = useState(false);
  const [codexMcpError, setCodexMcpError] = useState<string | null>(null);
  const [antigravityMcpLoading, setAntigravityMcpLoading] = useState(false);
  const [antigravityMcpError, setAntigravityMcpError] = useState<string | null>(null);

  const [skillStatus, setSkillStatus] = useState<KomlaSkillStatus | null>(null);
  const [skillLoading, setSkillLoading] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);

  const [expandedDetail, setExpandedDetail] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<ExpandedSections>(() => {
    const open = agentFilter ?? openSection;
    return {
      claude: open === 'claude',
      antigravity: open === 'antigravity',
      codex: open === 'codex',
      opencode: open === 'opencode',
      generic: open === 'generic',
    };
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
    } catch (err) {
      console.error('Failed to load notification info:', err);
    }
  };

  const loadAntigravityNotificationInfo = async () => {
    try {
      const info = await window.api.getAntigravityNotificationHookDetails();
      setAntigravityNotificationInfo(info);
    } catch (err) {
      console.error('Failed to load Antigravity notification info:', err);
    }
  };

  const loadMcpStatus = async () => {
    try {
      const status = await window.api.getMcpStatus();
      setMcpStatus(status);
      setMcpError(null);
    } catch (err) {
      console.error('Failed to load MCP status:', err);
    } finally {
      setMcpChecking(false);
    }
  };

  const loadSkillStatus = async () => {
    try {
      setSkillStatus(await window.api.getKomlaSkillStatus());
    } catch (err) {
      console.error('Failed to load the Komla skill status:', err);
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
      setCodexNotificationError(getIpcErrorMessage(err, 'Update failed'));
    }
  };

  const loadOpencodeNotificationInfo = async () => {
    try {
      const info = await window.api.getOpenCodeNotificationHookDetails();
      setOpencodeNotificationInfo(info);
    } catch (err) {
      console.error('Failed to load OpenCode notification info:', err);
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

  const toggleSection = (key: SectionKey) => {
    setExpandedSections((prev) => ({ ...prev, [key]: !prev[key] }));
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

  return (
    <>
      <SettingsCard
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
          {/* Edge to edge in the card, one agent per row. */}
          <div className="-mx-5 -my-4 divide-y divide-foreground/8">
            <div className="px-2 py-0.5">
              <KomlaSkillItem
                status={skillStatus}
                loading={skillLoading}
                error={skillError}
                expandedDetail={expandedDetail}
                setExpandedDetail={setExpandedDetail}
                copy={copyApi}
                onToggle={(on) => void handleToggleSkill(on)}
              />
            </div>
            {(!agentFilter || agentFilter === 'claude') && (
              <ClaudeSection
                expanded={expandedSections.claude}
                onToggle={() => toggleSection('claude')}
                configured={notificationInfo?.isConfigured ?? false}
                mcpChecking={mcpChecking}
                notificationInfo={notificationInfo}
                notificationLoading={notificationLoading}
                mcpStatus={mcpStatus}
                mcpLoading={mcpLoading}
                mcpError={mcpError}
                expandedDetail={expandedDetail}
                setExpandedDetail={setExpandedDetail}
                copy={copyApi}
                onAddNotifications={handleAddNotifications}
                onRemoveNotifications={handleRemoveNotifications}
                onRunMcpCli={handleRunMcpCli}
                onRemoveMcp={handleRemoveMcp}
              />
            )}

            {(!agentFilter || agentFilter === 'codex') && (
              <CodexSection
                expanded={expandedSections.codex}
                onToggle={() => toggleSection('codex')}
                configured={codexNotificationInfo?.isConfigured ?? false}
                mcpChecking={mcpChecking}
                notificationInfo={codexNotificationInfo}
                notificationLoading={codexNotificationLoading}
                notificationError={codexNotificationError}
                mcpStatus={mcpStatus}
                mcpLoading={codexMcpLoading}
                mcpError={codexMcpError}
                expandedDetail={expandedDetail}
                setExpandedDetail={setExpandedDetail}
                copy={copyApi}
                onAddNotifications={handleAddCodexNotifications}
                onRemoveNotifications={handleRemoveCodexNotifications}
                onForceEnableNotifications={handleForceEnableCodexNotifications}
                onRunMcpCli={handleRunCodexMcpCli}
                onRemoveMcp={handleRemoveCodexMcp}
              />
            )}

            {(!agentFilter || agentFilter === 'antigravity') && (
              <AntigravitySection
                expanded={expandedSections.antigravity}
                onToggle={() => toggleSection('antigravity')}
                configured={antigravityNotificationInfo?.isConfigured ?? false}
                mcpChecking={mcpChecking}
                notificationInfo={antigravityNotificationInfo}
                notificationLoading={antigravityNotificationLoading}
                mcpStatus={mcpStatus}
                mcpLoading={antigravityMcpLoading}
                mcpError={antigravityMcpError}
                expandedDetail={expandedDetail}
                setExpandedDetail={setExpandedDetail}
                copy={copyApi}
                onAddNotifications={handleAddAntigravityNotifications}
                onRemoveNotifications={handleRemoveAntigravityNotifications}
                onRunMcpCli={handleRunAntigravityMcpCli}
                onRemoveMcp={handleRemoveAntigravityMcp}
              />
            )}

            {(!agentFilter || agentFilter === 'opencode') && (
              <OpenCodeSection
                expanded={expandedSections.opencode}
                onToggle={() => toggleSection('opencode')}
                configured={opencodeNotificationInfo?.isConfigured ?? false}
                mcpChecking={mcpChecking}
                notificationInfo={opencodeNotificationInfo}
                notificationLoading={opencodeNotificationLoading}
                mcpStatus={mcpStatus}
                expandedDetail={expandedDetail}
                setExpandedDetail={setExpandedDetail}
                copy={copyApi}
                onAddNotifications={handleAddOpencodeNotifications}
                onRemoveNotifications={handleRemoveOpencodeNotifications}
              />
            )}

            {!agentFilter && (
              <GenericSection
                expanded={expandedSections.generic}
                onToggle={() => toggleSection('generic')}
                selfSetupPresetId={selfSetupPresetId}
                mcpStatus={mcpStatus}
                expandedDetail={expandedDetail}
                setExpandedDetail={setExpandedDetail}
                copy={copyApi}
              />
            )}
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
        {agentFilter && <KomlaCliIntegration komlaBasePath={komlaBasePath} />}
      </SettingsCard>
    </>
  );
}

// ---------------- Helper components ----------------

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

function DetailToggle({
  active,
  onClick,
  showLabel = 'Show what this changes',
  hideLabel = 'Hide details',
}: {
  active: boolean;
  onClick: () => void;
  showLabel?: string;
  hideLabel?: string;
}) {
  return (
    <button
      type="button"
      className="mt-1 ml-4 text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
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
    <div className="ml-4 space-y-1">
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

// The project-setup skill and both demo tours apply to every agent, so they live
// in their own card rather than reading as part of the per-agent integrations.
// ---------------- Per-agent sections ----------------

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
      isConfigured={status?.isConfigured ?? false}
      label="Komla skill"
      help={<KomlaSkillHelp />}
      description="Teaches your agents how to use the Komla CLI"
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
          <Spinner size="xs" className="text-muted-foreground" />
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

interface ClaudeSectionProps {
  expanded: boolean;
  onToggle: () => void;
  /** Whether its notifications are on. */
  configured: boolean;
  mcpChecking: boolean;
  notificationInfo: NotificationInfo | null;
  notificationLoading: boolean;
  mcpStatus: McpStatus | null;
  mcpLoading: boolean;
  mcpError: string | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAddNotifications: () => void;
  onRemoveNotifications: () => void;
  onRunMcpCli: () => void;
  onRemoveMcp: () => void;
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

function ClaudeSection(props: ClaudeSectionProps) {
  const {
    expanded,
    onToggle,
    configured,
    mcpChecking,
    notificationInfo,
    notificationLoading,
    mcpStatus,
    mcpLoading,
    mcpError,
    expandedDetail,
    setExpandedDetail,
    copy,
    onAddNotifications,
    onRemoveNotifications,
    onRunMcpCli,
    onRemoveMcp,
  } = props;

  return (
    <SectionShell
      title="Claude Code"
      command="claude"
      description="Hooks, MCP server"
      expanded={expanded}
      onToggle={onToggle}
      statusDot={<ConfiguredDot isConfigured={configured} />}
      needsUpdate={!!notificationInfo?.update}
      statusLabel={mcpChecking ? 'Checking...' : configured ? 'Configured' : 'Not configured'}
    >
      {notificationInfo && (
        <ClaudeNotificationItem
          info={notificationInfo}
          loading={notificationLoading}
          expandedDetail={expandedDetail}
          setExpandedDetail={setExpandedDetail}
          copy={copy}
          onAdd={onAddNotifications}
          onRemove={onRemoveNotifications}
        />
      )}
      <ClaudeMcpItem
        mcpStatus={mcpStatus}
        mcpChecking={mcpChecking}
        loading={mcpLoading}
        error={mcpError}
        expandedDetail={expandedDetail}
        setExpandedDetail={setExpandedDetail}
        copy={copy}
        onAdd={onRunMcpCli}
        onRemove={onRemoveMcp}
      />
    </SectionShell>
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
      isConfigured={info.isConfigured}
      outdated={!!info.update}
      label="Hooks"
      help={<HooksHelp agent="Claude Code" integration="claude" />}
      description={hooksSummary('claude')}
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
      isConfigured={mcpStatus?.isConfigured ?? false}
      label="MCP Server"
      help={<McpHelp agent="Claude Code" />}
      {...mcpServerNote}
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

interface AntigravitySectionProps {
  expanded: boolean;
  onToggle: () => void;
  /** Whether its notifications are on. */
  configured: boolean;
  mcpChecking: boolean;
  notificationInfo: NotificationInfo | null;
  notificationLoading: boolean;
  mcpStatus: McpStatus | null;
  mcpLoading: boolean;
  mcpError: string | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAddNotifications: () => void;
  onRemoveNotifications: () => void;
  onRunMcpCli: () => void;
  onRemoveMcp: () => void;
}

function AntigravitySection(props: AntigravitySectionProps) {
  const {
    expanded,
    onToggle,
    configured,
    mcpChecking,
    notificationInfo,
    notificationLoading,
    mcpStatus,
    mcpLoading,
    mcpError,
    expandedDetail,
    setExpandedDetail,
    copy,
    onAddNotifications,
    onRemoveNotifications,
    onRunMcpCli,
    onRemoveMcp,
  } = props;

  // Original logic: section content only renders when notificationInfo exists.
  const showContent = expanded && notificationInfo != null;

  return (
    <SectionShell
      title="Antigravity CLI"
      command="antigravity"
      description="Hooks, MCP server"
      expanded={expanded}
      onToggle={onToggle}
      statusDot={<ConfiguredDot isConfigured={configured} />}
      needsUpdate={!!notificationInfo?.update}
      statusLabel={mcpChecking ? 'Checking...' : configured ? 'Configured' : 'Not configured'}
    >
      {showContent && notificationInfo && (
        <>
          <AntigravityNotificationItem
            info={notificationInfo}
            loading={notificationLoading}
            expandedDetail={expandedDetail}
            setExpandedDetail={setExpandedDetail}
            copy={copy}
            onAdd={onAddNotifications}
            onRemove={onRemoveNotifications}
          />
          {mcpStatus?.antigravity && (
            <AntigravityMcpItem
              mcp={mcpStatus.antigravity}
              loading={mcpLoading}
              error={mcpError}
              expandedDetail={expandedDetail}
              setExpandedDetail={setExpandedDetail}
              copy={copy}
              onAdd={onRunMcpCli}
              onRemove={onRemoveMcp}
            />
          )}
        </>
      )}
    </SectionShell>
  );
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
      isConfigured={info.isConfigured}
      outdated={!!info.update}
      label="Hooks"
      help={<HooksHelp agent="Antigravity CLI" integration="antigravity" />}
      description={hooksSummary('antigravity')}
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
      isConfigured={mcp.isConfigured}
      label="MCP Server"
      help={<McpHelp agent="Antigravity CLI" />}
      {...mcpServerNote}
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
          <div className="ml-4 space-y-1">
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

interface CodexSectionProps {
  expanded: boolean;
  onToggle: () => void;
  /** Whether its notifications are on. */
  configured: boolean;
  mcpChecking: boolean;
  notificationInfo: CodexNotificationInfo | null;
  notificationLoading: boolean;
  notificationError: string | null;
  mcpStatus: McpStatus | null;
  mcpLoading: boolean;
  mcpError: string | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAddNotifications: () => void;
  onRemoveNotifications: () => void;
  onForceEnableNotifications: () => void;
  onRunMcpCli: () => void;
  onRemoveMcp: () => void;
}

function CodexSection(props: CodexSectionProps) {
  const {
    expanded,
    onToggle,
    configured,
    mcpChecking,
    notificationInfo,
    notificationLoading,
    notificationError,
    mcpStatus,
    mcpLoading,
    mcpError,
    expandedDetail,
    setExpandedDetail,
    copy,
    onAddNotifications,
    onRemoveNotifications,
    onForceEnableNotifications,
    onRunMcpCli,
    onRemoveMcp,
  } = props;

  const showContent = expanded && notificationInfo != null;

  return (
    <SectionShell
      title="Codex CLI"
      command="codex"
      description="Hooks, MCP server"
      expanded={expanded}
      onToggle={onToggle}
      statusDot={<ConfiguredDot isConfigured={configured} />}
      needsUpdate={!!notificationInfo?.update}
      statusLabel={mcpChecking ? 'Checking...' : configured ? 'Configured' : 'Not configured'}
    >
      {showContent && notificationInfo && (
        <>
          <CodexNotificationItem
            info={notificationInfo}
            loading={notificationLoading}
            error={notificationError}
            expandedDetail={expandedDetail}
            setExpandedDetail={setExpandedDetail}
            copy={copy}
            onAdd={onAddNotifications}
            onRemove={onRemoveNotifications}
            onForceEnable={onForceEnableNotifications}
          />
          {mcpStatus?.codex && (
            <CodexMcpItem
              mcp={mcpStatus.codex}
              loading={mcpLoading}
              error={mcpError}
              expandedDetail={expandedDetail}
              setExpandedDetail={setExpandedDetail}
              copy={copy}
              onAdd={onRunMcpCli}
              onRemove={onRemoveMcp}
            />
          )}
        </>
      )}
    </SectionShell>
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
      isConfigured={info.isConfigured}
      outdated={!!info.update}
      label="Hooks"
      help={<HooksHelp agent="Codex" integration="codex" />}
      description={hooksSummary('codex')}
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
          <Callout
            tone="warning"
            size="sm"
            icon={<Info className="size-3.5" />}
            className="ml-4 gap-2 py-2"
          >
            <span className="font-medium">
              Codex won&rsquo;t run the Komla hooks until you approve them.
            </span>{' '}
            After enabling, run <code className="font-mono">/hooks</code> inside Codex, then select
            and approve each Komla hook individually. Until you do,{' '}
            {reportsOwnStatus('codex') ? (
              'workspace titles won’t follow the chat.'
            ) : (
              <>
                notifications won&rsquo;t fire at all. Codex{' '}
                <code className="font-mono">/review</code> may also skip the normal completion hook,
                which can leave the activity spinner on until the next completion event.
              </>
            )}
          </Callout>
          {info.hasConflict && (
            <Callout
              tone="warning"
              size="sm"
              icon={<Warning className="size-3.5" />}
              className="ml-4 px-2"
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
      isConfigured={mcp.isConfigured}
      label="MCP Server"
      help={<McpHelp agent="Codex" />}
      {...mcpServerNote}
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

interface OpenCodeSectionProps {
  expanded: boolean;
  onToggle: () => void;
  /** Whether its notifications are on. */
  configured: boolean;
  mcpChecking: boolean;
  notificationInfo: OpenCodeNotificationInfo | null;
  notificationLoading: boolean;
  mcpStatus: McpStatus | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
  onAddNotifications: () => void;
  onRemoveNotifications: () => void;
}

function OpenCodeSection(props: OpenCodeSectionProps) {
  const {
    expanded,
    onToggle,
    configured,
    mcpChecking,
    notificationInfo,
    notificationLoading,
    mcpStatus,
    expandedDetail,
    setExpandedDetail,
    copy,
    onAddNotifications,
    onRemoveNotifications,
  } = props;

  const showContent = expanded && notificationInfo != null;

  return (
    <SectionShell
      title="OpenCode"
      command="opencode"
      description="Hooks, MCP server"
      expanded={expanded}
      onToggle={onToggle}
      statusDot={<ConfiguredDot isConfigured={configured} />}
      needsUpdate={!!notificationInfo?.update}
      statusLabel={mcpChecking ? 'Checking...' : configured ? 'Configured' : 'Not configured'}
    >
      {showContent && notificationInfo && (
        <>
          <OpenCodeNotificationItem
            info={notificationInfo}
            loading={notificationLoading}
            expandedDetail={expandedDetail}
            setExpandedDetail={setExpandedDetail}
            copy={copy}
            onAdd={onAddNotifications}
            onRemove={onRemoveNotifications}
          />
          {mcpStatus?.opencode && (
            <OpenCodeMcpItem
              mcp={mcpStatus.opencode}
              expandedDetail={expandedDetail}
              setExpandedDetail={setExpandedDetail}
              copy={copy}
            />
          )}
        </>
      )}
    </SectionShell>
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
      isConfigured={info.isConfigured}
      outdated={!!info.update}
      label="Hooks"
      help={<HooksHelp agent="OpenCode" integration="opencode" />}
      description={hooksSummary('opencode')}
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
      isConfigured={mcp.isConfigured}
      label="MCP Server"
      help={<McpHelp agent="OpenCode" />}
      {...mcpServerNote}
      detailToggle={
        <DetailToggle
          active={isOpen}
          onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
          showLabel="Show command"
        />
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
          <div className="ml-4 space-y-2">
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

interface GenericSectionProps {
  expanded: boolean;
  onToggle: () => void;
  selfSetupPresetId?: string;
  mcpStatus: McpStatus | null;
  expandedDetail: string | null;
  setExpandedDetail: (key: string | null) => void;
  copy: CopyApi;
}

function GenericSection(props: GenericSectionProps) {
  const {
    expanded,
    onToggle,
    selfSetupPresetId,
    mcpStatus,
    expandedDetail,
    setExpandedDetail,
    copy,
  } = props;
  const generic = mcpStatus?.generic;
  const showContent = expanded && generic != null;

  return (
    <SectionShell
      title="Other Agent CLIs"
      description="Hooks and MCP for any compatible agent"
      expanded={expanded}
      onToggle={onToggle}
      statusDot={<span className="size-2 rounded-full bg-muted-foreground" />}
      statusLabel="Manual"
    >
      {showContent && generic && (
        <>
          <div className="px-3 py-2.5">
            <OtherAgentCallout
              integrationPrompt={generic.integrationPrompt}
              setsUpThisComputer
              workspacePrefill={selfSetupPresetId ? { presetIds: [selfSetupPresetId] } : undefined}
            />
          </div>
          <GenericNotificationItem
            generic={generic}
            expandedDetail={expandedDetail}
            setExpandedDetail={setExpandedDetail}
            copy={copy}
          />
          <GenericMcpItem
            generic={generic}
            expandedDetail={expandedDetail}
            setExpandedDetail={setExpandedDetail}
            copy={copy}
          />
        </>
      )}
    </SectionShell>
  );
}

const NOTIFY_EVENTS: { event: string; fires: string }[] = [
  { event: 'Stop', fires: 'the agent finishes its turn' },
  { event: 'UserPromptSubmit', fires: 'the user sends a new message' },
  { event: 'PermissionRequest', fires: 'the agent waits for your approval' },
  { event: 'Notification', fires: 'the agent has gone idle' },
];

function GenericNotificationItem({
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
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-muted-foreground/60" />
            <span className="text-[13px] font-medium">Hooks</span>
            <span className="hidden text-ui text-muted-foreground sm:inline">
              Invoke the Komla CLI from a hook
            </span>
          </div>
          <DetailToggle
            active={isOpen}
            onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
            showLabel="Show details"
          />
        </div>
      </div>
      {isOpen && (
        <div className="ml-4 space-y-2">
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
    <div className="space-y-2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="size-2 shrink-0 rounded-full bg-muted-foreground/60" />
            <span className="text-[13px] font-medium">MCP Server</span>
            <span className="hidden text-ui text-muted-foreground sm:inline">
              Stdio through the Komla CLI
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
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
        </div>
      </div>
      <div className="ml-4 space-y-2">
        <code className="block rounded bg-muted/50 p-2 font-mono text-ui break-all">
          {generic.cliCommand}
        </code>
        <button
          type="button"
          className="text-xs text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground"
          onClick={() => setExpandedDetail(isOpen ? null : detailKey)}
        >
          {isOpen ? 'Hide JSON config' : 'Show JSON config'}
        </button>
        {isOpen && (
          <pre className="max-h-24 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-ui">
            {generic.configJson}
          </pre>
        )}
      </div>
    </div>
  );
}
