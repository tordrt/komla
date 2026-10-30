import { Warning, CaretDown, CaretUp } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { AI_UTILITIES_CARD } from '@/components/layout/settings/settings-search';
import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsHistoryCard } from '@/components/layout/settings/SettingsHistoryCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { TELEMETRY_LEVEL_OPTIONS } from '@/components/layout/settings/telemetry-level-options';
import { UtilityPromptEditor } from '@/components/layout/settings/UtilityPromptEditor';
import { WorkspaceTagsCard } from '@/components/layout/settings/WorkspaceTagsCard';
import { KEEP_AWAKE_MODES } from '@/components/layout/status-bar/KeepAwakeStatusSegment';
import {
  RESOURCE_USAGE_BAR_CHOICES,
  RESOURCE_USAGE_HOST_CHOICES,
  hostChoice,
  resourceUsageBarChoice,
  resourceUsageBarChoiceUpdate,
  useResourceUsageBarSource,
} from '@/components/layout/status-bar/ResourceUsageSegment';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useConfigStore } from '@/stores/config.store';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  DEFAULT_COMMIT_MESSAGE_PROMPT,
  DEFAULT_WORKSPACE_NAMING_PROMPT,
} from '../../../../shared/constants/utility-prompts';
import { getTelemetryLevel, telemetryLevelUpdates } from '../../../../shared/lib/telemetry-level';

import type { TelemetryLevel } from '../../../../shared/lib/telemetry-level';

interface GeneralTabProps {
  onClose: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

export function GeneralTab({ onClose: _onClose, onDirtyChange: _onDirtyChange }: GeneralTabProps) {
  const defaultOpenRouterModel = 'anthropic/claude-haiku-5.5';
  const defaultOpenRouterBaseUrl = 'https://openrouter.ai/api/v1';
  const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces);
  const selectWorkspace = useWorkspacesStore((s) => s.selectWorkspace);
  const {
    config,
    updateConfig,
    openRouterKeyStatus,
    openRouterKeyStatusLoading,
    openRouterKeyStatusError,
    loadOpenRouterKeyStatus,
    saveOpenRouterApiKey,
    clearOpenRouterApiKey,
  } = useConfigStore();
  const sshHosts = useSshHostsStore((s) => s.hosts);
  const resourceUsageBarSource = useResourceUsageBarSource();
  const addToast = useToastStore((s) => s.addToast);
  const quitShortcut = formatShortcutForDisplay('Cmd+Q');
  const telemetryLevel = getTelemetryLevel(config);
  const telemetryOption =
    TELEMETRY_LEVEL_OPTIONS.find((option) => option.value === telemetryLevel) ??
    TELEMETRY_LEVEL_OPTIONS[1];

  // Surface the active data dir name (.komla, .komla-dev, .komla-staging,
  // …KOMLA_DATA_DIR) in the reset hint so users in dev/staging don't get
  // pointed at the prod directory.
  const [komlaDirName, setKomlaDirName] = useState<string>('.komla');
  useEffect(() => {
    void window.api.getBasePath().then((path) => {
      const segment = path.split(/[\\/]/).filter(Boolean).pop();
      if (segment) setKomlaDirName(segment);
    });
  }, []);

  const [deleteAllDialogOpen, setDeleteAllDialogOpen] = useState(false);
  const [isDeletingAll, setIsDeletingAll] = useState(false);
  const [clearLogsDialogOpen, setClearLogsDialogOpen] = useState(false);
  const [isClearingLogs, setIsClearingLogs] = useState(false);
  const [dangerZoneOpen, setDangerZoneOpen] = useState(false);
  const [openRouterApiKeyInput, setOpenRouterApiKeyInput] = useState('');
  const [openRouterModelInput, setOpenRouterModelInput] = useState(defaultOpenRouterModel);
  const [openRouterBaseUrlInput, setOpenRouterBaseUrlInput] = useState(defaultOpenRouterBaseUrl);
  const [isSavingOpenRouterModel, setIsSavingOpenRouterModel] = useState(false);
  const [isSavingOpenRouterBaseUrl, setIsSavingOpenRouterBaseUrl] = useState(false);
  const [isSavingOpenRouterKey, setIsSavingOpenRouterKey] = useState(false);
  const [isClearingOpenRouterKey, setIsClearingOpenRouterKey] = useState(false);
  const [isTestingEndpoint, setIsTestingEndpoint] = useState(false);

  useEffect(() => {
    if (openRouterKeyStatus || openRouterKeyStatusLoading) {
      return;
    }
    void loadOpenRouterKeyStatus();
  }, [loadOpenRouterKeyStatus, openRouterKeyStatus, openRouterKeyStatusLoading]);

  useEffect(() => {
    setOpenRouterModelInput(config?.openRouterModel ?? defaultOpenRouterModel);
  }, [config?.openRouterModel]);

  useEffect(() => {
    setOpenRouterBaseUrlInput(config?.openRouterBaseUrl ?? defaultOpenRouterBaseUrl);
  }, [config?.openRouterBaseUrl]);

  const handleDeleteAllWorkspaces = async () => {
    setIsDeletingAll(true);
    try {
      await window.api.deleteAllWorkspaces();
      await loadWorkspaces();
      void selectWorkspace(null);
      addToast('All workspaces deleted', 'success');
    } catch {
      addToast('Failed to delete workspaces', 'error');
    } finally {
      setIsDeletingAll(false);
      setDeleteAllDialogOpen(false);
    }
  };

  const handleClearLogs = async () => {
    setIsClearingLogs(true);
    try {
      await window.api.clearLogs();
      addToast('Logs cleared', 'success');
    } catch {
      addToast('Failed to clear logs', 'error');
    } finally {
      setIsClearingLogs(false);
      setClearLogsDialogOpen(false);
    }
  };

  const handleSaveOpenRouterApiKey = async () => {
    const apiKey = openRouterApiKeyInput.trim();
    if (!apiKey) {
      addToast('Enter an API key', 'error');
      return;
    }

    setIsSavingOpenRouterKey(true);
    try {
      const success = await saveOpenRouterApiKey(apiKey);
      if (success) {
        setOpenRouterApiKeyInput('');
        addToast('API key saved', 'success');
      } else {
        addToast('Failed to save API key', 'error');
      }
    } finally {
      setIsSavingOpenRouterKey(false);
    }
  };

  const handleClearOpenRouterApiKey = async () => {
    setIsClearingOpenRouterKey(true);
    try {
      const success = await clearOpenRouterApiKey();
      if (success) {
        setOpenRouterApiKeyInput('');
        addToast('API key cleared', 'success');
      } else {
        addToast('Failed to clear API key', 'error');
      }
    } finally {
      setIsClearingOpenRouterKey(false);
    }
  };

  const handleSaveOpenRouterModel = async () => {
    const normalizedModel = openRouterModelInput.trim() || defaultOpenRouterModel;
    const persistedModel = config?.openRouterModel ?? defaultOpenRouterModel;

    if (normalizedModel === persistedModel) {
      setOpenRouterModelInput(normalizedModel);
      return;
    }

    setIsSavingOpenRouterModel(true);
    try {
      const { ok } = await updateConfig({ openRouterModel: normalizedModel });
      if (ok) {
        setOpenRouterModelInput(normalizedModel);
      } else {
        setOpenRouterModelInput(persistedModel);
        addToast('Failed to save model', 'error');
      }
    } catch {
      setOpenRouterModelInput(persistedModel);
      addToast('Failed to save model', 'error');
    } finally {
      setIsSavingOpenRouterModel(false);
    }
  };

  const handleSaveOpenRouterBaseUrl = async () => {
    const normalizedUrl = openRouterBaseUrlInput.trim() || defaultOpenRouterBaseUrl;
    const persistedUrl = config?.openRouterBaseUrl ?? defaultOpenRouterBaseUrl;

    if (normalizedUrl === persistedUrl) {
      setOpenRouterBaseUrlInput(normalizedUrl);
      return;
    }

    setIsSavingOpenRouterBaseUrl(true);
    try {
      const { ok } = await updateConfig({ openRouterBaseUrl: normalizedUrl });
      if (ok) {
        setOpenRouterBaseUrlInput(normalizedUrl);
      } else {
        setOpenRouterBaseUrlInput(persistedUrl);
        addToast('Failed to save base URL', 'error');
      }
    } catch {
      setOpenRouterBaseUrlInput(persistedUrl);
      addToast('Failed to save base URL', 'error');
    } finally {
      setIsSavingOpenRouterBaseUrl(false);
    }
  };

  const utilityProvider = config?.utilityProvider ?? 'komla-managed';
  const isCustomProvider = utilityProvider === 'custom';
  const managedUnavailable = window.api.managedAiHelpers === false;
  const apiKeyStatusText = getApiKeyStatusText({
    loading: openRouterKeyStatusLoading,
    error: openRouterKeyStatusError,
    status: openRouterKeyStatus,
  });

  const handleTestEndpoint = async () => {
    setIsTestingEndpoint(true);
    try {
      // Save any unsaved draft values so the test uses what the user sees
      const normalizedUrl = openRouterBaseUrlInput.trim() || defaultOpenRouterBaseUrl;
      const normalizedModel = openRouterModelInput.trim() || defaultOpenRouterModel;
      const persistedUrl = config?.openRouterBaseUrl ?? defaultOpenRouterBaseUrl;
      const persistedModel = config?.openRouterModel ?? defaultOpenRouterModel;

      if (normalizedUrl !== persistedUrl) {
        const { ok } = await updateConfig({ openRouterBaseUrl: normalizedUrl });
        if (!ok) {
          addToast('Failed to save base URL before testing', 'error');
          return;
        }
        setOpenRouterBaseUrlInput(normalizedUrl);
      }
      if (normalizedModel !== persistedModel) {
        const { ok } = await updateConfig({ openRouterModel: normalizedModel });
        if (!ok) {
          addToast('Failed to save model before testing', 'error');
          return;
        }
        setOpenRouterModelInput(normalizedModel);
      }
      if (openRouterApiKeyInput.trim()) {
        const saved = await saveOpenRouterApiKey(openRouterApiKeyInput.trim());
        if (!saved) {
          addToast('Failed to save API key before testing', 'error');
          return;
        }
        setOpenRouterApiKeyInput('');
      }

      const result = await window.api.testCustomEndpoint();
      // The test reads the stored key, so a key that no longer decrypts shows up now.
      void loadOpenRouterKeyStatus();
      if (result.ok) {
        addToast('Custom endpoint is working', 'success');
      } else {
        addToast(result.error, 'error');
      }
    } catch {
      addToast('Failed to test endpoint', 'error');
    } finally {
      setIsTestingEndpoint(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* AI Utilities */}
      <SettingsCard
        title={AI_UTILITIES_CARD}
        description="Komla's AI helpers name workspaces and branches and write commit messages from your diff."
      >
        <SettingsRow
          label="Auto-name workspaces"
          description="Generate a workspace name and description from your prompts and refresh them as the work changes"
        >
          <Switch
            checked={(config?.autoNameWorkspaces ?? 'first-prompt') !== 'off'}
            onCheckedChange={(checked) =>
              void updateConfig({ autoNameWorkspaces: checked ? 'first-prompt' : 'off' })
            }
          />
        </SettingsRow>
        <SettingsRow
          label="Auto-name branches"
          description="Generate a branch name from the first prompt"
        >
          <Switch
            checked={config?.autoNameBranches === true}
            onCheckedChange={(checked) => void updateConfig({ autoNameBranches: checked })}
          />
        </SettingsRow>
        <SettingsRow
          label="Provider"
          description={
            isCustomProvider ? (
              'Any OpenAI-compatible endpoint, with your own model and API key.'
            ) : managedUnavailable ? (
              <span className="text-warning">
                Komla managed is only in official builds. Choose Custom endpoint to use AI helpers
                in this build.
              </span>
            ) : (
              "Free, on us. Prompts and diffs are relayed through OpenRouter to providers that don't train on your data, and never stored."
            )
          }
        >
          <Select
            value={utilityProvider}
            onChange={(e) =>
              void updateConfig({
                utilityProvider: e.target.value as 'komla-managed' | 'custom',
              })
            }
            className={managedUnavailable && !isCustomProvider ? 'w-56 border-warning' : 'w-56'}
          >
            <option value="komla-managed" disabled={managedUnavailable}>
              Komla managed
            </option>
            <option value="custom">Custom endpoint</option>
          </Select>
        </SettingsRow>

        {isCustomProvider && (
          <>
            <SettingsRow
              label="Base URL"
              description="OpenAI-compatible endpoint. Change this to use other providers like Ollama, Together, or Groq."
            >
              <Input
                value={openRouterBaseUrlInput}
                onChange={(e) => setOpenRouterBaseUrlInput(e.target.value)}
                onBlur={() => void handleSaveOpenRouterBaseUrl()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleSaveOpenRouterBaseUrl();
                  }
                }}
                placeholder={defaultOpenRouterBaseUrl}
                className="w-72"
                disabled={isSavingOpenRouterBaseUrl}
              />
            </SettingsRow>

            <SettingsRow
              label="Model"
              description="Model ID for utility tasks (workspace naming, branch naming)."
            >
              <Input
                value={openRouterModelInput}
                onChange={(e) => setOpenRouterModelInput(e.target.value)}
                onBlur={() => void handleSaveOpenRouterModel()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    void handleSaveOpenRouterModel();
                  }
                }}
                placeholder={defaultOpenRouterModel}
                className="w-72"
                disabled={isSavingOpenRouterModel}
              />
            </SettingsRow>

            <UtilityPromptEditor
              label="Workspace naming prompt"
              description='The system prompt that names workspaces and branches from your prompts. Replies must stay a JSON object with "title", "description" and "branchName".'
              configKey="workspaceNamingPrompt"
              defaultPrompt={DEFAULT_WORKSPACE_NAMING_PROMPT}
            />

            <UtilityPromptEditor
              label="Commit message prompt"
              description='The system prompt that writes commit messages from your diff. Replies must stay a JSON object with "subject" (at most 72 characters) and "body".'
              configKey="commitMessagePrompt"
              defaultPrompt={DEFAULT_COMMIT_MESSAGE_PROMPT}
            />

            <SettingsRow
              label="API key"
              description={
                <span
                  className={
                    openRouterKeyStatus?.hasOpenRouterKey &&
                    openRouterKeyStatus.isUsingFallbackStorage
                      ? 'text-warning'
                      : undefined
                  }
                >
                  {apiKeyStatusText}
                </span>
              }
            >
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  aria-label="API key"
                  value={openRouterApiKeyInput}
                  onChange={(e) => setOpenRouterApiKeyInput(e.target.value)}
                  placeholder={
                    openRouterKeyStatus?.hasOpenRouterKey
                      ? 'Enter a new key to replace it'
                      : 'sk-or-v1-...'
                  }
                  className="w-56"
                />
                <Button
                  size="sm"
                  onClick={() => void handleSaveOpenRouterApiKey()}
                  disabled={isSavingOpenRouterKey || openRouterApiKeyInput.trim().length === 0}
                >
                  {isSavingOpenRouterKey ? (
                    <>
                      <Spinner size="sm" className="mr-1.5" />
                      Saving...
                    </>
                  ) : (
                    'Save'
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleClearOpenRouterApiKey()}
                  disabled={isClearingOpenRouterKey || !openRouterKeyStatus?.hasOpenRouterKey}
                >
                  {isClearingOpenRouterKey ? (
                    <>
                      <Spinner size="sm" className="mr-1.5" />
                      Clearing...
                    </>
                  ) : (
                    'Clear'
                  )}
                </Button>
              </div>
            </SettingsRow>

            <SettingsRow
              label="Test connection"
              description="Send a test request to verify your endpoint, model, and API key are working."
            >
              <Button
                size="sm"
                variant="outline"
                disabled={
                  isTestingEndpoint ||
                  isSavingOpenRouterBaseUrl ||
                  isSavingOpenRouterModel ||
                  isSavingOpenRouterKey ||
                  isClearingOpenRouterKey
                }
                onClick={() => void handleTestEndpoint()}
              >
                {isTestingEndpoint ? (
                  <>
                    <Spinner size="sm" className="mr-1.5" />
                    Testing...
                  </>
                ) : (
                  'Test'
                )}
              </Button>
            </SettingsRow>
          </>
        )}
      </SettingsCard>

      <WorkspaceTagsCard />

      {/* Power */}
      <SettingsCard title="Power">
        <SettingsRow
          label="Keep computer awake"
          description="Stop the computer from going to sleep on its own. The display can still turn off. Agents on SSH hosts don't count: they keep working in tmux while it sleeps."
        >
          <Select
            value={config?.keepAwakeMode ?? 'off'}
            onChange={(e) =>
              void updateConfig({
                keepAwakeMode: e.target.value as 'off' | 'agents' | 'always',
              })
            }
            className="w-44"
          >
            {KEEP_AWAKE_MODES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </SettingsRow>
      </SettingsCard>

      {/* Privacy */}
      <SettingsCard
        title="Privacy"
        action={
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <button
              type="button"
              onClick={() => window.api.openExternal(`${window.api.websiteUrl}/privacy`)}
              className="transition-colors hover:text-foreground hover:underline"
            >
              Privacy Policy
            </button>
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
            <button
              type="button"
              onClick={() => window.api.openExternal(`${window.api.websiteUrl}/terms`)}
              className="transition-colors hover:text-foreground hover:underline"
            >
              Terms of Service
            </button>
          </div>
        }
      >
        <SettingsRow label="Usage data" description={telemetryOption.description}>
          <Select
            value={telemetryLevel}
            onChange={(e) =>
              void updateConfig(telemetryLevelUpdates(e.target.value as TelemetryLevel))
            }
            className="w-44"
          >
            {TELEMETRY_LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </SettingsRow>
        <SettingsRow label="Crash reports" description="Send crash reports to help fix Komla">
          <Switch
            checked={config?.errorReportingEnabled !== false}
            onCheckedChange={async (checked) => {
              await updateConfig({ errorReportingEnabled: checked });
            }}
          />
        </SettingsRow>
      </SettingsCard>

      {/* Advanced */}
      <SettingsCard title="Advanced">
        {(window.api.platform === 'darwin' || window.api.platform === 'linux') && (
          <SettingsRow
            label={`Hold ${quitShortcut} to quit`}
            description={`Quit only after ${quitShortcut} is held for a second, so a press meant for another app doesn't stop your agents.`}
          >
            <Switch
              checked={config?.holdToQuit === true}
              onCheckedChange={(checked) => void updateConfig({ holdToQuit: checked })}
            />
          </SettingsRow>
        )}
        <SettingsRow
          label="Resource usage"
          description="Show CPU and memory use in the status bar. Click it for what each workspace's terminals use, here and on SSH hosts."
        >
          <Switch
            checked={config?.showSystemMetrics === true}
            onCheckedChange={(checked) => void updateConfig({ showSystemMetrics: checked })}
          />
        </SettingsRow>
        {config?.showSystemMetrics === true && (
          <SettingsRow
            label="Status bar shows"
            description="Whose CPU and memory the status bar counts."
          >
            <Select
              aria-label="Status bar shows"
              value={resourceUsageBarChoice(resourceUsageBarSource)}
              onChange={(e) => void updateConfig(resourceUsageBarChoiceUpdate(e.target.value))}
              className="w-56"
            >
              {RESOURCE_USAGE_BAR_CHOICES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              {sshHosts.map((host) => (
                <optgroup key={host.id} label={host.name}>
                  {RESOURCE_USAGE_HOST_CHOICES.map((option) => (
                    // A closed select shows only the option, so it names the host.
                    <option key={option.value} value={hostChoice(option.value, host)}>
                      {host.name}: {option.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </SettingsRow>
        )}
      </SettingsCard>

      <SettingsHistoryCard />

      <DangerZone
        open={dangerZoneOpen}
        onToggle={() => setDangerZoneOpen(!dangerZoneOpen)}
        onDeleteAll={() => setDeleteAllDialogOpen(true)}
        onClearLogs={() => setClearLogsDialogOpen(true)}
        komlaDirName={komlaDirName}
      />

      {/* Delete All Workspaces Confirmation */}
      <Dialog open={deleteAllDialogOpen} onOpenChange={setDeleteAllDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Warning className="size-5 text-destructive" />
              Delete all workspaces
            </DialogTitle>
            <DialogDescription>
              This will permanently delete all workspaces and their git worktrees. This action
              cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteAllDialogOpen(false)}
              disabled={isDeletingAll}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteAllWorkspaces}
              disabled={isDeletingAll}
            >
              {isDeletingAll ? (
                <>
                  <Spinner size="md" className="mr-2" />
                  Deleting...
                </>
              ) : (
                'Delete all'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Clear Logs Confirmation */}
      <Dialog open={clearLogsDialogOpen} onOpenChange={setClearLogsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear logs</DialogTitle>
            <DialogDescription>
              This will delete all application log files. New logs will be created as needed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setClearLogsDialogOpen(false)}
              disabled={isClearingLogs}
            >
              Cancel
            </Button>
            <Button onClick={handleClearLogs} disabled={isClearingLogs}>
              {isClearingLogs ? (
                <>
                  <Spinner size="md" className="mr-2" />
                  Clearing...
                </>
              ) : (
                'Clear logs'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface OpenRouterKeyStatus {
  hasOpenRouterKey: boolean;
  isUsingFallbackStorage?: boolean;
}

function getApiKeyStatusText(params: {
  loading: boolean;
  error: string | null;
  status: OpenRouterKeyStatus | null | undefined;
}): string {
  if (params.loading) return 'Checking API key status...';
  if (params.error) return 'Unable to load API key status right now.';
  if (!params.status?.hasOpenRouterKey) return 'No API key saved.';
  if (params.status.isUsingFallbackStorage) {
    return 'API key saved on-device in fallback storage because secure storage is unavailable.';
  }
  return 'API key stored securely on this device.';
}

interface DangerZoneProps {
  open: boolean;
  onToggle: () => void;
  onDeleteAll: () => void;
  onClearLogs: () => void;
  komlaDirName: string;
}

function DangerZone({ open, onToggle, onDeleteAll, onClearLogs, komlaDirName }: DangerZoneProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-destructive/20 bg-card/70 shadow-xs">
      <button
        type="button"
        className="flex w-full items-center justify-between px-5 py-4 text-left transition-colors hover:bg-destructive/5"
        aria-expanded={open}
        onClick={onToggle}
      >
        <div className="flex items-center gap-2">
          <Warning className="size-4 text-destructive/70" />
          <h3 className="text-sm font-semibold text-destructive/70">Danger zone</h3>
        </div>
        {open ? (
          <CaretUp className="size-3.5 text-destructive/50" />
        ) : (
          <CaretDown className="size-3.5 text-destructive/50" />
        )}
      </button>

      {open && (
        <div className="border-t border-destructive/20 [&>*]:px-5 [&>*]:py-4 [&>*+*]:border-t [&>*+*]:border-destructive/10">
          <SettingsRow
            label="Delete all workspaces"
            description="Remove all workspaces and their git worktrees"
          >
            <Button variant="destructive" size="sm" onClick={onDeleteAll}>
              Delete all
            </Button>
          </SettingsRow>

          <SettingsRow label="Clear logs" description="Delete application log files">
            <Button variant="outline" size="sm" onClick={onClearLogs}>
              Clear logs
            </Button>
          </SettingsRow>

          <div>
            <p className="text-ui text-muted-foreground">
              To fully reset Komla, close the app and delete the <code>~/{komlaDirName}</code>{' '}
              directory.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
