import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  offerAgentLaunchDefaults,
  offerKomlaSkillInstall,
  useAgentLaunchDefaultsDialogStore,
} from '../../../src/renderer/stores/agent-launch-defaults-dialog.store';
import { useConfigStore } from '../../../src/renderer/stores/config.store';

import type { AppConfig } from '../../../src/renderer/types';

describe('agent-launch-defaults-dialog.store', () => {
  const updateConfig = vi.fn(async () => ({ ok: true, error: null }));

  beforeEach(() => {
    updateConfig.mockClear();
    useAgentLaunchDefaultsDialogStore.setState({ open: false, installSkill: false });
    useConfigStore.setState({ config: {} as AppConfig, updateConfig });
  });

  it('opens once, the first time the Komla skill or MCP is turned on', () => {
    expect(offerAgentLaunchDefaults()).toBe(true);
    expect(useAgentLaunchDefaultsDialogStore.getState()).toMatchObject({
      open: true,
      installSkill: false,
    });
    expect(updateConfig).toHaveBeenCalledWith({ agentLaunchDefaultsShown: true });
  });

  it('stays closed once it has shown', () => {
    useConfigStore.setState({ config: { agentLaunchDefaultsShown: true } as AppConfig });

    expect(offerAgentLaunchDefaults()).toBe(false);
    expect(useAgentLaunchDefaultsDialogStore.getState().open).toBe(false);
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('waits for the config, so it never shows to someone who already saw it', () => {
    useConfigStore.setState({ config: null });

    expect(offerAgentLaunchDefaults()).toBe(false);
    expect(useAgentLaunchDefaultsDialogStore.getState().open).toBe(false);
  });

  it('closes', () => {
    offerAgentLaunchDefaults();
    useAgentLaunchDefaultsDialogStore.getState().close();

    expect(useAgentLaunchDefaultsDialogStore.getState().open).toBe(false);
  });

  it('asks before installing the Komla skill, however often it has shown', () => {
    useConfigStore.setState({ config: { agentLaunchDefaultsShown: true } as AppConfig });
    offerKomlaSkillInstall();

    expect(useAgentLaunchDefaultsDialogStore.getState()).toMatchObject({
      open: true,
      installSkill: true,
    });
    expect(updateConfig).not.toHaveBeenCalled();
  });
});
