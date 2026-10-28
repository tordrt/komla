import { beforeEach, describe, expect, it } from 'vitest';

import { useCommandCenterStore } from '../../../src/renderer/stores/command-center.store';

describe('command-center.store', () => {
  beforeEach(() => {
    useCommandCenterStore.setState({
      open: false,
      mode: 'workspaces',
      fileMode: 'files',
      session: 0,
    });
  });

  it('opens each search with its own shortcut and closes it with the same one', () => {
    const { toggle } = useCommandCenterStore.getState();

    toggle('files');
    expect(useCommandCenterStore.getState()).toMatchObject({ open: true, mode: 'files' });

    toggle('files');
    expect(useCommandCenterStore.getState().open).toBe(false);

    toggle('workspaces');
    expect(useCommandCenterStore.getState()).toMatchObject({ open: true, mode: 'workspaces' });

    toggle('workspaces');
    expect(useCommandCenterStore.getState().open).toBe(false);
  });

  it('switches to the other search instead of closing', () => {
    const { toggle } = useCommandCenterStore.getState();

    toggle('workspaces');
    toggle('files');
    expect(useCommandCenterStore.getState()).toMatchObject({ open: true, mode: 'files' });

    toggle('workspaces');
    expect(useCommandCenterStore.getState()).toMatchObject({ open: true, mode: 'workspaces' });
  });

  it('closes content search with the file search shortcut', () => {
    const { toggle, setMode } = useCommandCenterStore.getState();
    toggle('files');
    setMode('content');

    toggle('files');

    expect(useCommandCenterStore.getState().open).toBe(false);
  });

  it('reopens file search in the file mode last shown', () => {
    const { toggle, setMode, close } = useCommandCenterStore.getState();
    toggle('files');
    setMode('content');
    setMode('workspaces');
    close();

    toggle('files');

    expect(useCommandCenterStore.getState()).toMatchObject({ open: true, mode: 'content' });
  });

  it('starts a new session each time a shortcut opens or switches a search', () => {
    const { toggle, setMode } = useCommandCenterStore.getState();

    toggle('workspaces');
    const opened = useCommandCenterStore.getState().session;
    toggle('files');
    const switched = useCommandCenterStore.getState().session;
    setMode('content');

    expect(switched).not.toBe(opened);
    expect(useCommandCenterStore.getState().session).toBe(switched);
  });
});
