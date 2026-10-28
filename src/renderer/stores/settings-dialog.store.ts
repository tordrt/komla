import { create } from 'zustand';

import type { SshHostAddedSource } from '../../shared/types/ssh';
import type { SectionKey } from '@/components/layout/settings/AgentIntegrations';

export interface SettingsDialogTarget {
  tab?: string;
  generalSection?: string;
  editProjectId?: string;
  setupProjectId?: string;
  /** Attributes an SSH host added in this visit; defaults to 'settings'. */
  sshSetupSource?: SshHostAddedSource;
  /** The Integrations section to show expanded. */
  integrationSection?: SectionKey;
  /** The agent Integrations' self-integration skill launches with. */
  selfSetupPresetId?: string;
  /** Title of a card on the page to scroll to and flash. */
  card?: string;
}

interface SettingsDialogState {
  open: boolean;
  target: SettingsDialogTarget;
  /** Counts open requests, so asking for the page already requested still shows it. */
  requestId: number;
  openSettings: (target?: SettingsDialogTarget) => void;
  /** Opens Settings at `target`, or leaves an open Settings on the page it shows. */
  showSettings: (target?: SettingsDialogTarget) => void;
  closeSettings: () => void;
}

// Settings open state lives outside App so opening and closing the dialog
// re-renders only the dialog host, not the whole workspace tree.
export const useSettingsDialogStore = create<SettingsDialogState>((set) => ({
  open: false,
  target: {},
  requestId: 0,
  openSettings: (target = {}) =>
    set((state) => ({
      open: true,
      requestId: state.requestId + 1,
      // A link inside Settings keeps where this visit started.
      target:
        state.open && state.target.sshSetupSource && !target.sshSetupSource
          ? { ...target, sshSetupSource: state.target.sshSetupSource }
          : target,
    })),
  showSettings: (target = {}) =>
    set((state) => (state.open ? state : { open: true, requestId: state.requestId + 1, target })),
  closeSettings: () => set({ open: false, target: {} }),
}));
