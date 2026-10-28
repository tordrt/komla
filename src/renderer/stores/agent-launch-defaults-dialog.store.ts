import { create } from 'zustand';

import { useConfigStore } from './config.store';

interface AgentLaunchDefaultsDialogState {
  open: boolean;
  /** Asks before installing the Komla skill, rather than showing the defaults after. */
  installSkill: boolean;
  close: () => void;
}

// Lives outside Integrations and Tips, which both turn on the Komla skill or MCP.
export const useAgentLaunchDefaultsDialogStore = create<AgentLaunchDefaultsDialogState>((set) => ({
  open: false,
  installSkill: false,
  // Leaves `installSkill` alone so the content doesn't change while the dialog animates out.
  close: () => set({ open: false }),
}));

/**
 * Shows the Komla CLI launch defaults the first time the Komla skill or MCP is turned on, since
 * agents can then start other agents. Returns whether it opened.
 */
export function offerAgentLaunchDefaults(): boolean {
  const { config, updateConfig } = useConfigStore.getState();
  if (!config || config.agentLaunchDefaultsShown) return false;
  void updateConfig({ agentLaunchDefaultsShown: true });
  useAgentLaunchDefaultsDialogStore.setState({ open: true, installSkill: false });
  return true;
}

/** Explains the Komla skill, with the launch defaults, and installs it only if the user agrees. */
export function offerKomlaSkillInstall(): void {
  useAgentLaunchDefaultsDialogStore.setState({ open: true, installSkill: true });
}
