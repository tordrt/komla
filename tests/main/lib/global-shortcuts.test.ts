import { describe, expect, it, vi } from 'vitest';

import { GlobalShortcuts } from '../../../src/main/lib/global-shortcuts';

function fakeApi(register = vi.fn((_accelerator: string, _callback: () => void) => true)) {
  return { register, unregister: vi.fn() };
}

describe('GlobalShortcuts', () => {
  it('registers bound keys and calls back with the action pressed', () => {
    const api = fakeApi();
    const onPress = vi.fn();
    const shortcuts = new GlobalShortcuts(api, 'darwin', onPress);

    shortcuts.apply({ 'workspace.newFromAnywhere': 'Cmd+Shift+ ' });

    expect(api.register).toHaveBeenCalledWith('CommandOrControl+Shift+Space', expect.any(Function));
    api.register.mock.calls[0][1]();
    expect(onPress).toHaveBeenCalledWith('workspace.newFromAnywhere');
    expect(shortcuts.unavailableActions()).toEqual([]);
  });

  it('leaves unchanged keys registered, and swaps changed ones', () => {
    const api = fakeApi();
    const shortcuts = new GlobalShortcuts(api, 'darwin', vi.fn());

    shortcuts.apply({ 'workspace.newFromAnywhere': 'Cmd+Shift+ ' });
    shortcuts.apply({ 'workspace.newFromAnywhere': 'Shift+Cmd+ ' });
    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.unregister).not.toHaveBeenCalled();

    shortcuts.apply({ 'workspace.newFromAnywhere': 'Alt+Cmd+N' });
    expect(api.unregister).toHaveBeenCalledWith('CommandOrControl+Shift+Space');
    expect(api.register).toHaveBeenLastCalledWith('CommandOrControl+Alt+N', expect.any(Function));

    shortcuts.apply({ 'workspace.newFromAnywhere': '' });
    expect(api.unregister).toHaveBeenLastCalledWith('CommandOrControl+Alt+N');
    expect(api.register).toHaveBeenCalledTimes(2);
  });

  it('reports keys the system refuses until they change', () => {
    const api = fakeApi(vi.fn(() => false));
    const shortcuts = new GlobalShortcuts(api, 'linux', vi.fn());

    shortcuts.apply({ 'workspace.newFromAnywhere': 'Cmd+Shift+ ' });
    expect(shortcuts.unavailableActions()).toEqual(['workspace.newFromAnywhere']);
    // As when another action's keys change, or Komla reads back the config it saved.
    shortcuts.apply({ 'workspace.newFromAnywhere': 'Shift+Cmd+ ' });
    expect(api.register).toHaveBeenCalledTimes(1);

    // As when the user saves shortcuts, perhaps after closing the app that held the keys.
    shortcuts.apply({ 'workspace.newFromAnywhere': 'Shift+Cmd+ ' }, { retryRefused: true });
    expect(api.register).toHaveBeenCalledTimes(2);

    shortcuts.apply({ 'workspace.newFromAnywhere': 'Cmd+Alt+N' });
    expect(api.register).toHaveBeenCalledTimes(3);

    shortcuts.apply({ 'workspace.newFromAnywhere': '' });
    expect(shortcuts.unavailableActions()).toEqual([]);
  });

  it('registers nothing once disposed', () => {
    const api = fakeApi();
    const shortcuts = new GlobalShortcuts(api, 'darwin', vi.fn());
    shortcuts.dispose();

    shortcuts.apply({ 'workspace.newFromAnywhere': 'Cmd+Shift+ ' });

    expect(api.register).not.toHaveBeenCalled();
  });

  it('reports keys Electron cannot parse, or that make no accelerator, as unavailable', () => {
    const api = fakeApi(
      vi.fn(() => {
        throw new Error('conversion failure');
      })
    );
    const shortcuts = new GlobalShortcuts(api, 'darwin', vi.fn());

    shortcuts.apply({ 'workspace.newFromAnywhere': 'Cmd+Shift+ ' });
    expect(shortcuts.unavailableActions()).toEqual(['workspace.newFromAnywhere']);

    const neverAsked = fakeApi();
    const doubleTap = new GlobalShortcuts(neverAsked, 'darwin', vi.fn());
    doubleTap.apply({ 'workspace.newFromAnywhere': 'DoubleTap+Shift' });
    expect(neverAsked.register).not.toHaveBeenCalled();
    expect(doubleTap.unavailableActions()).toEqual(['workspace.newFromAnywhere']);
  });

  it('gives back every key it holds on dispose', () => {
    const api = fakeApi();
    const shortcuts = new GlobalShortcuts(api, 'win32', vi.fn());
    shortcuts.apply({ 'workspace.newFromAnywhere': 'Cmd+Alt+N' });

    shortcuts.dispose();

    expect(api.unregister).toHaveBeenCalledWith('CommandOrControl+Alt+N');
  });
});
