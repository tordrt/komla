import { beforeEach, describe, expect, it } from 'vitest';

import { useSettingsDialogStore } from '../../../src/renderer/stores/settings-dialog.store';

describe('settings-dialog.store', () => {
  beforeEach(() => {
    useSettingsDialogStore.setState({ open: false, target: {} });
  });

  it('opens on the requested target', () => {
    useSettingsDialogStore.getState().openSettings({ tab: 'projects', editProjectId: 'p1' });

    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: true,
      target: { tab: 'projects', editProjectId: 'p1' },
    });
  });

  it('replaces a previous target instead of merging into it', () => {
    const { openSettings } = useSettingsDialogStore.getState();
    openSettings({ tab: 'projects', editProjectId: 'p1' });
    openSettings({ tab: 'general', generalSection: 'terminal' });

    expect(useSettingsDialogStore.getState().target).toEqual({
      tab: 'general',
      generalSection: 'terminal',
    });
  });

  it('keeps where the visit started when a link inside Settings retargets it', () => {
    const { openSettings } = useSettingsDialogStore.getState();
    openSettings({ tab: 'ssh', sshSetupSource: 'tips' });
    openSettings({ tab: 'actions' });

    expect(useSettingsDialogStore.getState().target).toEqual({
      tab: 'actions',
      sshSetupSource: 'tips',
    });
  });

  it("starts the next visit without the previous one's source", () => {
    const { openSettings, closeSettings } = useSettingsDialogStore.getState();
    openSettings({ tab: 'ssh', sshSetupSource: 'tips' });
    closeSettings();
    openSettings({ tab: 'ssh' });

    expect(useSettingsDialogStore.getState().target).toEqual({ tab: 'ssh' });
  });

  it('opens on the default page without a target', () => {
    useSettingsDialogStore.getState().openSettings();

    expect(useSettingsDialogStore.getState()).toMatchObject({ open: true, target: {} });
  });

  it('leaves an open Settings on its page when the menu asks for Settings again', () => {
    const { openSettings, showSettings } = useSettingsDialogStore.getState();
    openSettings({ tab: 'appearance' });
    const { requestId } = useSettingsDialogStore.getState();

    showSettings({ tab: 'general' });

    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: true,
      target: { tab: 'appearance' },
      requestId,
    });
  });

  it('opens a closed Settings on the page the menu asks for', () => {
    useSettingsDialogStore.getState().showSettings({ tab: 'general' });

    expect(useSettingsDialogStore.getState()).toMatchObject({
      open: true,
      target: { tab: 'general' },
    });
  });

  it('clears the target when closed', () => {
    const { openSettings, closeSettings } = useSettingsDialogStore.getState();
    openSettings({ tab: 'workspace-setup', setupProjectId: 'p2' });
    closeSettings();

    expect(useSettingsDialogStore.getState()).toMatchObject({ open: false, target: {} });
  });
});
