import { create } from 'zustand';

import { isSshWorkspace } from '../../shared/types/workspace';
import { resolveAgentBrand } from '../components/terminal/AgentPresetIcon';

import { useAgentPresetsStore } from './agent-presets.store';
import { useConfigStore } from './config.store';

import type {
  AgentIntegrationFilter,
  SectionKey,
} from '../components/layout/settings/AgentIntegrations';
import type { AgentPreset, AppConfig, Workspace } from '../types';

export interface AgentSetupNudge {
  /** The agent the workspace launched with. */
  agent: Pick<AgentPreset, 'id' | 'name' | 'openCommand'>;
  /** Turning on notifications for a one-click agent, or self-setup for any other agent. */
  kind: 'notifications' | 'self-setup';
  /** The Integrations section that sets it up. */
  section: SectionKey;
}

// Whether each one-click agent's notification hooks are on, keyed by its Integrations section.
const NOTIFIES: Record<AgentIntegrationFilter, () => Promise<boolean>> = {
  claude: async () => (await window.api.getNotificationHookDetails()).isConfigured,
  codex: async () => (await window.api.getCodexNotificationHookDetails()).isConfigured,
  antigravity: async () => (await window.api.getAntigravityNotificationHookDetails()).isConfigured,
  opencode: async () => (await window.api.getOpenCodeNotificationHookDetails()).isConfigured,
};

// The agent comes from its command first, so a renamed preset is still recognized.
function oneClickIntegration(
  agent: Pick<AgentPreset, 'name' | 'openCommand'>
): AgentIntegrationFilter | null {
  const brand = resolveAgentBrand(agent);
  return brand !== null && Object.hasOwn(NOTIFIES, brand)
    ? (brand as AgentIntegrationFilter)
    : null;
}

// One-click agents found notifying aren't checked again this session: Claude's check can
// start a login shell.
const notifyingAgents = new Set<AgentIntegrationFilter>();

interface AgentSetupNudgeState {
  open: boolean;
  /** The last nudge shown, kept while it closes. */
  nudge: AgentSetupNudge | null;
  dismiss: () => void;
}

export const useAgentSetupNudgeStore = create<AgentSetupNudgeState>((set) => ({
  open: false,
  nudge: null,
  dismiss: () => set({ open: false }),
}));

let checking = false;

/** Forgets which agents were found notifying; for tests. */
export function _resetNotifyingAgents(): void {
  notifyingAgents.clear();
}

/** Shows the nudge unless its flag was cleared meanwhile, and clears the flag. */
function show(
  nudge: AgentSetupNudge,
  flag: 'notificationsNudgePending' | 'selfSetupNudgePending'
): void {
  const { config, updateConfig } = useConfigStore.getState();
  if (config?.[flag] !== true) return;
  useAgentSetupNudgeStore.setState({ open: true, nudge });
  const updates: Partial<AppConfig> = {};
  updates[flag] = false;
  void updateConfig(updates);
}

type LaunchedWorkspace = Pick<Workspace, 'presetId' | 'backend' | 'provisionError'>;

/**
 * After onboarding, the first local workspace launched with an agent that can't notify
 * Komla yet points at its setup, once for each kind: notifications for a one-click agent,
 * and self-setup for any other agent unless a self-integration skill was launched first.
 * Of several workspaces launched together, the first that needs it is nudged.
 */
export async function nudgeAgentSetup(workspaces: LaunchedWorkspace[]): Promise<void> {
  for (const workspace of workspaces) await nudgeWorkspace(workspace);
}

async function nudgeWorkspace(workspace: LaunchedWorkspace): Promise<void> {
  const config = useConfigStore.getState().config;
  if (checking || useAgentSetupNudgeStore.getState().open || !config) return;
  if (!config.notificationsNudgePending && !config.selfSetupNudgePending) return;
  // Integrations are set up per machine, and SSH workspaces run agents elsewhere.
  if (workspace.provisionError || isSshWorkspace(workspace)) return;
  const agent = useAgentPresetsStore
    .getState()
    .presets.find((preset) => preset.id === workspace.presetId);
  if (!agent?.openCommand.trim()) return;

  const integration = oneClickIntegration(agent);
  if (!integration) {
    if (config.selfSetupNudgePending) {
      show({ agent, kind: 'self-setup', section: 'generic' }, 'selfSetupNudgePending');
    }
    return;
  }
  if (!config.notificationsNudgePending || notifyingAgents.has(integration)) return;
  checking = true;
  try {
    if (await NOTIFIES[integration]()) {
      notifyingAgents.add(integration);
    } else {
      show({ agent, kind: 'notifications', section: integration }, 'notificationsNudgePending');
    }
  } catch (err) {
    console.error(`Failed to check ${agent.name} notifications:`, err);
  } finally {
    checking = false;
  }
}
