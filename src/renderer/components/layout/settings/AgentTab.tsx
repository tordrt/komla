import {
  Bell,
  Plus,
  PencilSimple,
  Trash,
  Warning,
  CaretUp,
  CaretDown,
} from '@phosphor-icons/react';
import { useState, useEffect, useMemo } from 'react';

import { AgentPresetIcon } from '@/components/terminal/AgentPresetIcon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { reportsOwnStatus } from '@/lib/agent-status-reports';
import { getLaunchModeColor, LAUNCH_MODE_DOT_CLASSES } from '@/lib/launch-mode-colors';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { useToastStore } from '@/stores/toast.store';
import { deriveAgentName } from '@/utils/agent-name';

import { POPULAR_OTHER_AGENTS, RECOMMENDED_AGENTS } from '../../../../shared/constants/agents';
import {
  hasDuplicateLevelNames,
  levelPickerOf,
  storedLevelPicker,
} from '../../../../shared/lib/level-picker';

import {
  agentNotificationStatus,
  setAgentNotifications,
  type AgentNotificationStatus,
} from './agent-notifications';
import { AgentIntegrationsPanel, type AgentIntegrationFilter } from './AgentIntegrations';
import { CommandInputs } from './CommandInputs';
import { FormError } from './FormError';
import { HooksHelp } from './IntegrationHelp';
import { OtherAgentCallout } from './OtherAgentCallout';
import { SettingsCard } from './SettingsCard';
import { SettingsSubpageHeader } from './SettingsSubpageHeader';

import type {
  ActivePresetEntry,
  AgentPreset,
  LaunchMode,
  ReasoningLevel,
  LevelPicker,
} from '@/types';

// Compares pickers as they look, so a title typed and cleared again isn't a change.
const pickerJson = (picker: LevelPicker | undefined) =>
  JSON.stringify(levelPickerOf({ levelPicker: picker }));

const TEMPLATE_INFO: Record<string, string> = {
  'Claude Code': 'AI coding assistant by Anthropic',
  Codex: "OpenAI's code generation CLI",
  'Grok Build': "xAI's coding agent",
  OpenCode: 'Open-source AI coding tool',
  'Antigravity CLI': "Google's successor to Gemini CLI",
  Gemini: "Google's previous CLI, replaced by Antigravity",
  'Cursor CLI': "Cursor's agent in the terminal",
  'GitHub Copilot CLI': 'GitHub Copilot in the terminal',
  'Hermes Agent': "Nous Research's open-source agent",
  'Factory Droid': "Factory's coding agent",
  Amp: "Sourcegraph's AI coding agent",
  'Qwen Code': "Alibaba's Qwen coding agent",
  'Mistral Vibe': "Mistral's CLI coding agent",
  Pi: 'Minimal open-source coding agent',
  Goose: "Block's open-source AI agent",
  Auggie: "Augment's agentic coding CLI",
  Devin: 'Local coding agent by Cognition',
  'Kiro CLI': "AWS's successor to Amazon Q Developer CLI",
  'Shell Only': 'Terminals without an agent',
  Custom: 'Configure your own agent',
};

type ResolvedActivePreset = ActivePresetEntry & { preset: AgentPreset };

// Built-in templates with a one-click Komla integration — picking one surfaces
// that agent's integration controls in the editor as an integrate-now nudge.
const TEMPLATE_AGENT_FILTER: Record<string, AgentIntegrationFilter> = {
  'Claude Code': 'claude',
  Codex: 'codex',
  'Antigravity CLI': 'antigravity',
  OpenCode: 'opencode',
};

interface AgentTabProps {
  onClose: () => void;
  onSaveClose?: () => void;
  onDirtyChange?: (isDirty: boolean) => void;
}

export function AgentTab({
  onClose: _onClose,
  onSaveClose: _onSaveClose,
  onDirtyChange,
}: AgentTabProps) {
  const {
    presets,
    templates,
    activePresets,
    loadTemplates,
    createPreset,
    updatePreset,
    deletePreset,
    reorderPreset,
    addActivePreset,
  } = useAgentPresetsStore();
  const addToast = useToastStore((s) => s.addToast);
  const { loadConfig } = useConfigStore();
  const config = useConfigStore((s) => s.config);

  // View state: 'list' shows preset list, 'edit' shows preset detail, 'add' shows template picker
  const [view, setView] = useState<'list' | 'edit' | 'add'>('list');
  const [editingPresetId, setEditingPresetId] = useState<string>('');
  const [pendingTemplate, setPendingTemplate] = useState<Omit<AgentPreset, 'id'> | null>(null);

  // Agent preset state
  const [presetName, setPresetName] = useState('');
  // While false, the name auto-derives from the open command; a manual edit
  // (or loading an existing/named preset) latches it true.
  const [presetNameTouched, setPresetNameTouched] = useState(false);
  // True when the current edit session is for a custom-template agent. Set when
  // the Custom template is picked and preserved through the first save so the
  // self-integration callout can appear on the now-saved preset. Not derivable
  // from a saved preset, which carries no custom marker.
  const [isCustomPreset, setIsCustomPreset] = useState(false);
  // Integration filter for built-in agents (Claude Code, Codex, …). Set when a
  // supported template is picked so the editor can nudge the user to integrate.
  // Null for custom/Shell Only and for re-opened presets (no template marker).
  const [editAgentFilter, setEditAgentFilter] = useState<AgentIntegrationFilter | null>(null);
  // True when the picked template has no one-click integration (Custom, plus
  // CLIs like Cursor, Copilot, Amp, …). Surfaces the self-integration callout
  // in the editor. Reset for re-opened presets, which carry no template marker.
  const [showSelfIntegration, setShowSelfIntegration] = useState(false);
  // Whether a template's collapsed commands are open (see commandsCollapsible).
  const [commandsExpanded, setCommandsExpanded] = useState(false);
  // Whether saving a new one-click agent turns on its notifications. Nothing
  // changes in the agent's settings until Save.
  const [notifyOnSave, setNotifyOnSave] = useState(true);
  // That agent's notification status, checked once per template pick.
  const [notificationCheck, setNotificationCheck] = useState<{
    template: Omit<AgentPreset, 'id'>;
    status: AgentNotificationStatus;
  } | null>(null);
  const [openCommand, setOpenCommand] = useState('');
  const [continueCommand, setContinueCommand] = useState('');
  const [promptCommand, setPromptCommand] = useState('');
  const [launchModes, setLaunchModes] = useState<LaunchMode[]>([]);
  const [reasoningLevels, setReasoningLevels] = useState<ReasoningLevel[]>([]);
  const [levelPicker, setLevelPicker] = useState<LevelPicker>({});
  const [presetError, setPresetError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Self-integration prompt for custom agents — surfaced in the custom edit view.
  const [genericIntegrationPrompt, setGenericIntegrationPrompt] = useState<string | null>(null);

  // Track dirty state
  const [initialState, setInitialState] = useState<{
    presetId: string;
    name: string;
    openCommand: string;
    continueCommand: string;
    promptCommand: string;
    launchModesJson: string;
    reasoningLevelsJson: string;
    levelPickerJson: string;
  } | null>(null);

  // Load templates on mount (intentional one-shot — deps intentionally empty)
  useEffect(() => {
    void loadTemplates();
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // Fetch the generic self-integration prompt so the custom-agent edit view can
  // offer the self-integration skill.
  useEffect(() => {
    void window.api
      .getMcpStatus()
      .then((status) => setGenericIntegrationPrompt(status.generic?.integrationPrompt ?? null))
      .catch(() => setGenericIntegrationPrompt(null));
  }, []);

  // Check dirty state
  useEffect(() => {
    if (!initialState || (!editingPresetId && !pendingTemplate)) {
      onDirtyChange?.(false);
      return;
    }

    const isDirty =
      editingPresetId !== initialState.presetId ||
      presetName !== initialState.name ||
      openCommand !== initialState.openCommand ||
      continueCommand !== initialState.continueCommand ||
      promptCommand !== initialState.promptCommand ||
      JSON.stringify(launchModes) !== initialState.launchModesJson ||
      JSON.stringify(reasoningLevels) !== initialState.reasoningLevelsJson ||
      pickerJson(levelPicker) !== initialState.levelPickerJson;

    onDirtyChange?.(isDirty);
  }, [
    editingPresetId,
    pendingTemplate,
    presetName,
    openCommand,
    continueCommand,
    promptCommand,
    launchModes,
    reasoningLevels,
    levelPicker,
    initialState,
    onDirtyChange,
  ]);

  // Navigate to edit view for a preset (accepts optional preset data for newly created presets
  // that may not be in the store yet)
  const navigateToEdit = (presetId: string, presetData?: AgentPreset) => {
    setEditingPresetId(presetId);
    const preset = presetData ?? presets.find((p) => p.id === presetId);
    if (preset) {
      setPresetName(preset.name);
      setPresetNameTouched(true);
      setOpenCommand(preset.openCommand);
      setContinueCommand(preset.continueCommand);
      setPromptCommand(preset.promptCommand);
      setLaunchModes(preset.launchModes);
      setReasoningLevels(preset.reasoningLevels ?? []);
      setLevelPicker(preset.levelPicker ?? {});
      setInitialState({
        presetId: preset.id,
        name: preset.name,
        openCommand: preset.openCommand,
        continueCommand: preset.continueCommand,
        promptCommand: preset.promptCommand,
        launchModesJson: JSON.stringify(preset.launchModes),
        reasoningLevelsJson: JSON.stringify(preset.reasoningLevels ?? []),
        levelPickerJson: pickerJson(preset.levelPicker),
      });
    }
    setIsCustomPreset(false);
    setEditAgentFilter(null);
    setShowSelfIntegration(false);
    setPresetError(null);
    setView('edit');
  };

  const navigateToList = () => {
    setView('list');
    setEditingPresetId('');
    setPendingTemplate(null);
    setInitialState(null);
    setIsCustomPreset(false);
    setEditAgentFilter(null);
    setShowSelfIntegration(false);
  };

  const editingPreset = presets.find((p) => p.id === editingPresetId);
  const isShellOnly = editingPreset?.name === 'Shell Only';
  // Adding a non-featured built-in template: its commands are best-effort
  // defaults the user should verify against their installed CLI.
  const isBestEffortTemplate = pendingTemplate != null && !isCustomPreset && showSelfIntegration;
  // A built-in template (until the user leaves its edit view) shows a summary of
  // its commands, with the fields collapsed behind it. Custom has nothing to sum up.
  const commandsCollapsible = !isCustomPreset && (editAgentFilter != null || showSelfIntegration);
  // A one-click agent being added. Its integration panel waits for the saved
  // preset, and a notifications switch in the form stands in for it.
  const newIntegrationAgent = pendingTemplate ? editAgentFilter : null;
  useEffect(() => {
    if (!pendingTemplate || !newIntegrationAgent) return;
    let cancelled = false;
    void agentNotificationStatus(newIntegrationAgent)
      .catch((err): AgentNotificationStatus => {
        console.error(`Failed to check the ${newIntegrationAgent} notifications:`, err);
        // Unknown counts as off, so Save can still try to turn them on.
        return { isConfigured: false, path: '', canEnable: true };
      })
      .then((status) => {
        if (!cancelled) setNotificationCheck({ template: pendingTemplate, status });
      });
    return () => {
      cancelled = true;
    };
  }, [pendingTemplate, newIntegrationAgent]);
  // Null until checked: the switch waits, so Save can't redo notifications that are already on.
  const newAgentNotifications =
    notificationCheck?.template === pendingTemplate ? notificationCheck.status : null;
  const notificationsAlreadyOn = newAgentNotifications?.isConfigured ?? false;
  const notificationsSwitchShown =
    !notificationsAlreadyOn && newAgentNotifications?.canEnable !== false;
  const codexHooksHint =
    newIntegrationAgent === 'codex' && notificationsSwitchShown && notifyOnSave;

  const resolvedActivePresets = useMemo(() => {
    const activePresetEntries = new Map(activePresets.map((entry) => [entry.presetId, entry]));
    const resolved: ResolvedActivePreset[] = [];
    for (const preset of presets) {
      const entry = activePresetEntries.get(preset.id);
      if (entry) {
        resolved.push({ ...entry, preset });
      }
    }
    return resolved;
  }, [activePresets, presets]);

  // Featured = the agents with one-click notification + MCP setup; the rest
  // self-integrate. Custom is pulled out so it stays last, after the sorted agents.
  const featuredTemplates = templates.filter((t) => TEMPLATE_AGENT_FILTER[t.name] != null);
  const unsortedOtherTemplates = templates.filter(
    (t) => TEMPLATE_AGENT_FILTER[t.name] == null && t.name !== 'Custom'
  );
  // Match the setup wizard's ordering: best-known agents first, rest after.
  const otherTemplates = [
    ...unsortedOtherTemplates.filter((t) => POPULAR_OTHER_AGENTS.includes(t.name)),
    ...unsortedOtherTemplates.filter((t) => !POPULAR_OTHER_AGENTS.includes(t.name)),
  ];
  const customTemplate = templates.find((t) => t.name === 'Custom');

  const handleSave = async () => {
    setPresetError(null);

    if (!editingPresetId && !pendingTemplate) {
      return;
    }

    // Every check is on a command field, so a collapsed one opens to show it.
    const rejectCommands = (message: string) => {
      setPresetError(message);
      if (commandsCollapsible) setCommandsExpanded(true);
    };

    // Validate open command (not required for Shell Only)
    if (!isShellOnly && !openCommand.trim()) {
      rejectCommands('Open command is required');
      return;
    }

    // Validate launch modes: every configured mode must have a name
    const incompleteModes = launchModes.filter((m) => (m.arguments ?? '').trim() && !m.name.trim());
    if (incompleteModes.length > 0) {
      rejectCommands('Every launch mode must have a name');
      return;
    }

    // A level without arguments would launch the same as Default.
    if (reasoningLevels.some((level) => !level.name.trim() !== !level.arguments.trim())) {
      rejectCommands('Every effort level needs a name and arguments');
      return;
    }
    if (hasDuplicateLevelNames(reasoningLevels)) {
      rejectCommands('Every effort level needs its own name');
      return;
    }

    setIsSaving(true);
    try {
      const trimmedOpenCommand = openCommand.trim();
      const trimmedContinueCommand = continueCommand.trim();
      const trimmedPromptCommand = promptCommand.trim();
      const trimmedLaunchModes = launchModes.flatMap((mode) => {
        const name = mode.name.trim();
        if (!name && !(mode.arguments ?? '').trim()) return [];
        return [
          {
            ...mode,
            name,
            ...(mode.arguments !== undefined ? { arguments: mode.arguments.trim() } : {}),
          },
        ];
      });
      const trimmedReasoningLevels = reasoningLevels.flatMap((level) => {
        const name = level.name.trim();
        const args = level.arguments.trim();
        return name || args ? [{ ...level, name, arguments: args }] : [];
      });
      const trimmedReasoningLevelsJson = JSON.stringify(trimmedReasoningLevels);
      // Only write levels the user changed, so a preset that never had any
      // stays unset and can still pick up levels added to its template later.
      const reasoningLevelsUpdate =
        trimmedReasoningLevelsJson !== initialState?.reasoningLevelsJson
          ? { reasoningLevels: trimmedReasoningLevels }
          : {};
      const trimmedLevelPicker = storedLevelPicker(levelPickerOf({ levelPicker }));
      const trimmedLevelPickerJson = pickerJson(trimmedLevelPicker);
      const levelPickerUpdate =
        trimmedLevelPickerJson !== initialState?.levelPickerJson
          ? { levelPicker: trimmedLevelPicker }
          : {};

      // Custom presets fall back to the open command's binary (mirroring the
      // setup wizard) rather than a generic "Untitled".
      const trimmedName =
        presetName.trim() ||
        (isCustomPreset ? deriveAgentName(trimmedOpenCommand) : '') ||
        'Untitled';

      // Captured before pendingTemplate is cleared. Creating a preset from a
      // template that has integration controls below it (the self-integration
      // callout for custom/other agents, or a built-in agent's integration
      // section) keeps the user in the edit view after Save, so a stray click
      // doesn't exit past them. navigateToEdit resets the flags, so they're
      // restored afterwards.
      const creatingFromTemplate = pendingTemplate != null;
      const creatingCustom = isCustomPreset;
      const creatingAgentFilter = editAgentFilter;
      const creatingSelfIntegration = showSelfIntegration;
      const keepInEditView =
        creatingFromTemplate && (creatingSelfIntegration || creatingAgentFilter != null);
      const enablingNotificationsFor =
        newIntegrationAgent &&
        notifyOnSave &&
        newAgentNotifications &&
        !newAgentNotifications.isConfigured &&
        newAgentNotifications.canEnable
          ? newIntegrationAgent
          : null;
      let notificationsError = '';
      let savedPreset: AgentPreset | null = null;
      let savedPresetId = editingPresetId;

      if (pendingTemplate) {
        // Creating a new preset from a template — persist now
        const newPreset = await createPreset({
          ...pendingTemplate,
          name: trimmedName,
          openCommand: trimmedOpenCommand,
          continueCommand: trimmedContinueCommand,
          promptCommand: trimmedPromptCommand,
          launchModes: trimmedLaunchModes,
          ...reasoningLevelsUpdate,
          ...levelPickerUpdate,
        });
        await addActivePreset(newPreset.id);
        if (enablingNotificationsFor) {
          // The preset is saved either way; the integration panel can retry.
          notificationsError = await setAgentNotifications(enablingNotificationsFor, true);
        }
        savedPreset = newPreset;
        savedPresetId = newPreset.id;
        setPendingTemplate(null);
      } else {
        // Updating an existing preset
        await updatePreset(editingPresetId, {
          name: trimmedName,
          openCommand: trimmedOpenCommand,
          continueCommand: trimmedContinueCommand,
          promptCommand: trimmedPromptCommand,
          launchModes: trimmedLaunchModes,
          ...reasoningLevelsUpdate,
          ...levelPickerUpdate,
        });
      }

      // Update initial state to reflect saved values
      setInitialState({
        presetId: savedPresetId,
        name: trimmedName,
        openCommand: trimmedOpenCommand,
        continueCommand: trimmedContinueCommand,
        promptCommand: trimmedPromptCommand,
        launchModesJson: JSON.stringify(trimmedLaunchModes),
        reasoningLevelsJson: trimmedReasoningLevelsJson,
        levelPickerJson: trimmedLevelPickerJson,
      });
      setPresetName(trimmedName);
      setOpenCommand(trimmedOpenCommand);
      setContinueCommand(trimmedContinueCommand);
      setPromptCommand(trimmedPromptCommand);
      setLaunchModes(trimmedLaunchModes);
      setReasoningLevels(trimmedReasoningLevels);
      setLevelPicker(trimmedLevelPicker);

      if (notificationsError) addToast(`Agent preset saved. ${notificationsError}`, 'error');
      else addToast('Agent preset saved', 'success');

      if (keepInEditView && savedPreset) {
        navigateToEdit(savedPreset.id, savedPreset);
        setIsCustomPreset(creatingCustom);
        setEditAgentFilter(creatingAgentFilter);
        setShowSelfIntegration(creatingSelfIntegration);
      } else {
        navigateToList();
      }
    } catch (err) {
      setPresetError((err as Error).message);
    } finally {
      setIsSaving(false);
    }
  };

  const moveActivePreset = (presetId: string, activeIndex: number, direction: -1 | 1) => {
    const target = resolvedActivePresets[activeIndex + direction];
    if (!target?.preset) return;
    const targetOrder = presets.findIndex((preset) => preset.id === target.preset.id);
    if (targetOrder === -1) return;
    void reorderPreset(presetId, targetOrder);
  };

  const handleTemplatePick = async (template: Omit<AgentPreset, 'id'>) => {
    // Shell Only has nothing to configure — add directly
    if (template.name === 'Shell Only') {
      try {
        const newPreset = await createPreset({
          name: template.name,
          openCommand: '',
          continueCommand: '',
          promptCommand: '',
          launchModes: [],
          isBuiltin: false,
        });
        await addActivePreset(newPreset.id);
        addToast('Shell Only preset added', 'success');
        navigateToList();
      } catch (err) {
        addToast((err as Error).message, 'error');
      }
      return;
    }

    const templateData = {
      name: template.name,
      openCommand: template.openCommand,
      continueCommand: template.continueCommand,
      promptCommand: template.promptCommand,
      launchModes: template.launchModes,
      reasoningLevels: template.reasoningLevels,
      levelPicker: template.levelPicker,
      isBuiltin: false,
    };
    // Custom agents have no meaningful template name — leave the display name
    // blank so it auto-derives from the open command the user is about to enter.
    const isCustomTemplate = template.name === 'Custom';
    const initialName = isCustomTemplate ? '' : templateData.name;
    setPendingTemplate(templateData);
    setEditingPresetId('');
    setPresetName(initialName);
    setPresetNameTouched(!isCustomTemplate);
    setIsCustomPreset(isCustomTemplate);
    setEditAgentFilter(TEMPLATE_AGENT_FILTER[template.name] ?? null);
    // Any template without a one-click integration (Custom and the other CLI
    // presets) gets the self-integration callout below the editor.
    setShowSelfIntegration(TEMPLATE_AGENT_FILTER[template.name] == null);
    setCommandsExpanded(false);
    setNotifyOnSave(true);
    setOpenCommand(templateData.openCommand);
    setContinueCommand(templateData.continueCommand);
    setPromptCommand(templateData.promptCommand);
    setLaunchModes(templateData.launchModes);
    setReasoningLevels(templateData.reasoningLevels ?? []);
    setLevelPicker(templateData.levelPicker ?? {});
    setInitialState({
      presetId: '',
      name: initialName,
      openCommand: templateData.openCommand,
      continueCommand: templateData.continueCommand,
      promptCommand: templateData.promptCommand,
      launchModesJson: JSON.stringify(templateData.launchModes),
      reasoningLevelsJson: JSON.stringify(templateData.reasoningLevels ?? []),
      levelPickerJson: pickerJson(templateData.levelPicker),
    });
    setPresetError(null);
    setView('edit');
  };

  const renderTemplateCard = (template: Omit<AgentPreset, 'id'>) => (
    <button
      key={template.name}
      type="button"
      className="relative flex items-start gap-2.5 rounded-lg border border-border/60 bg-card/70 p-3 text-left transition-colors hover:border-border hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      onClick={() => void handleTemplatePick(template)}
    >
      <AgentPresetIcon preset={template} className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm leading-tight font-medium">{template.name}</span>
        <p className="text-xs text-muted-foreground">
          {TEMPLATE_INFO[template.name] || 'AI coding agent'}
        </p>
      </div>
      {RECOMMENDED_AGENTS.includes(template.name) && (
        <Badge tone="primary" variant="solid" className="absolute -top-2 right-2 px-2">
          Recommended
        </Badge>
      )}
    </button>
  );

  const renderTemplateGroup = (
    title: string,
    description: string,
    groupTemplates: Omit<AgentPreset, 'id'>[]
  ) => (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="grid grid-cols-2 gap-3">{groupTemplates.map(renderTemplateCard)}</div>
    </section>
  );

  return (
    <div className="space-y-6">
      {view === 'list' && (
        <SettingsCard
          title="Presets"
          description="Listed in launch-menu order. Workspaces and agent tabs start with one of these."
          action={
            <Button variant="outline" size="sm" onClick={() => setView('add')}>
              <Plus className="mr-1.5 size-3.5" />
              Add preset
            </Button>
          }
        >
          {resolvedActivePresets.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No presets yet.</p>
          ) : (
            resolvedActivePresets.map((item, index) => {
              const preset = item.preset;
              return (
                <div
                  key={item.presetId}
                  className="flex items-center justify-between gap-4 !py-3 transition-colors hover:bg-accent/50"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <AgentPresetIcon preset={preset} className="size-4 shrink-0" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{preset.name}</div>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {preset.openCommand || 'Empty terminals, no agent'}
                      </div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <IconButton
                      label="Move preset up"
                      onClick={() => moveActivePreset(item.presetId, index, -1)}
                      disabled={index === 0}
                    >
                      <CaretUp className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label="Move preset down"
                      onClick={() => moveActivePreset(item.presetId, index, 1)}
                      disabled={index === resolvedActivePresets.length - 1}
                    >
                      <CaretDown className="size-3.5" />
                    </IconButton>
                    <IconButton label="Edit preset" onClick={() => navigateToEdit(item.presetId)}>
                      <PencilSimple className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label={
                        resolvedActivePresets.length <= 1
                          ? 'At least one active preset is required'
                          : 'Delete preset'
                      }
                      className="hover:text-destructive"
                      onClick={async () => {
                        const confirmed = await window.api.showMessageBox({
                          type: 'warning',
                          title: 'Delete Preset',
                          message: `Delete "${preset.name}"?`,
                          detail:
                            'This will permanently delete the preset. Existing workspaces will use an available preset the next time they launch. This cannot be undone.',
                          buttons: ['Cancel', 'Delete'],
                          cancelId: 0,
                          defaultId: 0,
                        });
                        if (confirmed === 1) {
                          try {
                            await deletePreset(item.presetId);
                            await loadConfig();
                            addToast('Agent preset deleted', 'success');
                          } catch (error) {
                            addToast((error as Error).message, 'error');
                          }
                        }
                      }}
                      disabled={resolvedActivePresets.length <= 1}
                    >
                      <Trash className="size-3.5" />
                    </IconButton>
                  </div>
                </div>
              );
            })
          )}
        </SettingsCard>
      )}

      {view === 'add' && (
        <>
          <SettingsSubpageHeader
            backLabel="Agents"
            onBack={navigateToList}
            title="Add agent preset"
            description="Pick a template to start from. The agent CLI must be installed on your machine."
          />
          {renderTemplateGroup(
            'One-click setup',
            'Notifications and MCP wired up with one click.',
            featuredTemplates
          )}
          {renderTemplateGroup(
            'Other agents',
            'No one-click integration. These self-integrate, and their commands are best-effort defaults worth a look.',
            customTemplate ? [...otherTemplates, customTemplate] : otherTemplates
          )}
        </>
      )}

      {view === 'edit' && (editingPreset || pendingTemplate) && (
        <>
          <SettingsSubpageHeader
            backLabel="Agents"
            onBack={navigateToList}
            title={
              presetName ||
              editingPreset?.name ||
              pendingTemplate?.name ||
              (isCustomPreset ? 'Custom agent' : 'New preset')
            }
          />

          <SettingsCard>
            <div className="grid gap-1.5">
              <label htmlFor="agent-preset-name" className="text-[13px] font-medium">
                Display name
              </label>
              <Input
                id="agent-preset-name"
                value={presetName}
                onChange={(e) => {
                  setPresetName(e.target.value);
                  setPresetNameTouched(true);
                }}
                placeholder="Display name"
              />
            </div>

            {newIntegrationAgent && pendingTemplate && (
              <div className="flex items-start gap-3">
                <Bell className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-1.5">
                    {notificationsSwitchShown ? (
                      <label
                        htmlFor="agent-preset-notifications"
                        className="text-[13px] font-medium"
                      >
                        Hooks
                      </label>
                    ) : (
                      <span className="text-[13px] font-medium">Hooks</span>
                    )}
                    <HooksHelp agent={pendingTemplate.name} integration={newIntegrationAgent} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {reportsOwnStatus(newIntegrationAgent)
                      ? 'Up-to-date workspace titles, and a done you can trust.'
                      : `Know when ${pendingTemplate.name} finishes or needs you.`}
                    {newAgentNotifications?.canEnable === false && (
                      <>
                        {' '}
                        Komla can’t add the hooks on its own here. Set them up below after saving.
                      </>
                    )}
                    {codexHooksHint && (
                      <>
                        {' '}
                        Codex asks you to approve Komla’s hooks: run{' '}
                        <code className="font-mono">/hooks</code> in Codex.
                      </>
                    )}
                  </p>
                </div>
                {notificationsAlreadyOn && (
                  <span className="shrink-0 text-xs text-muted-foreground">Already on</span>
                )}
                {notificationsSwitchShown && (
                  <Switch
                    id="agent-preset-notifications"
                    className="shrink-0"
                    checked={notifyOnSave}
                    disabled={!newAgentNotifications}
                    onCheckedChange={setNotifyOnSave}
                  />
                )}
              </div>
            )}

            <div className="space-y-3">
              {isShellOnly ? (
                <p className="text-xs text-muted-foreground">
                  Workspaces will open with empty terminals — no agent command will be launched.
                </p>
              ) : (
                <CollapsibleCommands
                  collapsible={commandsCollapsible}
                  expanded={commandsExpanded}
                  onExpandedChange={setCommandsExpanded}
                  openCommand={openCommand}
                  launchModes={launchModes}
                  reasoningLevels={reasoningLevels}
                  levelPicker={levelPicker}
                  bestEffort={isBestEffortTemplate}
                >
                  {isBestEffortTemplate && (
                    <Callout
                      tone="warning"
                      size="sm"
                      icon={<Warning className="size-3.5" weight="bold" />}
                      className="px-3 py-2 leading-relaxed"
                    >
                      <p>
                        Komla runs these to start, resume, and prompt{' '}
                        {pendingTemplate?.name ?? 'the agent'}.{' '}
                        <span className="font-semibold">
                          These are best-effort defaults — give them a look and confirm they match
                          the version you have installed.
                        </span>
                      </p>
                    </Callout>
                  )}
                  <CommandInputs
                    openCommand={openCommand}
                    continueCommand={continueCommand}
                    promptCommand={promptCommand}
                    launchModes={launchModes}
                    reasoningLevels={reasoningLevels}
                    onOpenCommandChange={(value) => {
                      setOpenCommand(value);
                      if (!presetNameTouched) setPresetName(deriveAgentName(value));
                    }}
                    onContinueCommandChange={setContinueCommand}
                    onPromptCommandChange={setPromptCommand}
                    onLaunchModesChange={setLaunchModes}
                    onReasoningLevelsChange={setReasoningLevels}
                    levelPicker={levelPicker}
                    onLevelPickerChange={setLevelPicker}
                    alwaysExpanded
                    showExamplePlaceholders={isCustomPreset}
                    pinnedLaunchModeId={
                      config?.agentLaunchDefaultPresetId === editingPresetId
                        ? (config.agentLaunchDefaultLaunchModeId ?? undefined)
                        : undefined
                    }
                  />
                </CollapsibleCommands>
              )}
            </div>

            <div className="space-y-3">
              <FormError message={presetError} />
              <div className="flex justify-end gap-2">
                <Button variant="outline" size="sm" onClick={navigateToList}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving ? (
                    <>
                      <Spinner size="sm" className="mr-1.5" />
                      Saving...
                    </>
                  ) : (
                    'Save'
                  )}
                </Button>
              </div>
            </div>
          </SettingsCard>

          {showSelfIntegration && !pendingTemplate && (
            <OtherAgentCallout
              integrationPrompt={genericIntegrationPrompt}
              agentName={presetName.trim() || undefined}
              setsUpThisComputer
            />
          )}

          {editAgentFilter && !pendingTemplate && (
            <AgentIntegrationsPanel agentFilter={editAgentFilter} />
          )}
        </>
      )}
    </div>
  );
}

// "claude {{launchMode}}" reads as "claude": the placeholders are Komla's business.
const withoutPlaceholders = (command: string) => command.replace(/\s*\{\{\w+\}\}/g, '').trim();

function CollapsibleCommands({
  collapsible,
  expanded,
  onExpandedChange,
  openCommand,
  launchModes,
  reasoningLevels,
  levelPicker,
  bestEffort,
  children,
}: {
  collapsible: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  openCommand: string;
  launchModes: LaunchMode[];
  reasoningLevels: ReasoningLevel[];
  levelPicker: LevelPicker;
  bestEffort: boolean;
  children: React.ReactNode;
}) {
  if (!collapsible) return <>{children}</>;
  const picker = levelPickerOf({ levelPicker });
  const levels = picker.hidden ? [] : reasoningLevels.filter((level) => level.name.trim());
  // Colored by place in the full list, as the editor and launch menus do.
  const modes = launchModes
    .map((mode, index) => ({ mode, color: getLaunchModeColor(mode.color, index) }))
    .filter(({ mode }) => mode.name.trim());
  return (
    <div>
      {/* One toggle button in both states, so keyboard focus stays on it. */}
      <div className="flex items-start justify-between gap-4">
        {expanded ? (
          <span className="text-sm font-medium">Commands</span>
        ) : (
          <div className="min-w-0 space-y-3">
            <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-2.5 text-[13px]">
              <dt className="text-muted-foreground">Runs</dt>
              <dd className="truncate font-mono text-xs">{withoutPlaceholders(openCommand)}</dd>
              {modes.length > 0 && (
                <>
                  <dt className="text-muted-foreground">Launch modes</dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {modes.map(({ mode, color }) => (
                      <span
                        key={mode.id}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border/70 px-2 py-0.5 text-xs"
                      >
                        <span
                          className={`size-1.5 rounded-full ${LAUNCH_MODE_DOT_CLASSES[color]}`}
                        />
                        {mode.name}
                      </span>
                    ))}
                  </dd>
                </>
              )}
              {levels.length > 0 && (
                <>
                  <dt className="text-muted-foreground">{picker.title}</dt>
                  <dd className="text-xs">{levels.map((level) => level.name).join(' · ')}</dd>
                </>
              )}
            </dl>
            {bestEffort && (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Warning className="size-3.5 shrink-0 text-warning" weight="bold" />
                Best-effort defaults. Check they match the version you have installed.
              </p>
            )}
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          Customize
          {expanded ? (
            <CaretUp className="ml-1 size-3.5" />
          ) : (
            <CaretDown className="ml-1 size-3.5" />
          )}
        </Button>
      </div>
      <div className="wizard-collapsible" data-open={expanded} inert={!expanded}>
        <div>
          <div className="space-y-3 pt-3">{children}</div>
        </div>
      </div>
    </div>
  );
}
