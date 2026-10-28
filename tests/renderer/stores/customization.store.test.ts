import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useCustomizationStore } from '../../../src/renderer/stores/customization.store';

function resetStore(): void {
  useCustomizationStore.setState(useCustomizationStore.getInitialState(), true);
}

const mockTheme = { primary: '#000', background: '#fff' };
const mockTerminalConfig = { fontSize: 14, fontFamily: 'monospace' };

function mockApi(overrides: Record<string, any> = {}): Record<string, any> {
  const api = {
    getTheme: vi.fn().mockResolvedValue(mockTheme),
    getTerminalConfig: vi.fn().mockResolvedValue(mockTerminalConfig),
    updateTheme: vi.fn().mockImplementation(async (updates: any) => ({ ...mockTheme, ...updates })),
    updateTerminalConfig: vi
      .fn()
      .mockImplementation(async (updates: any) => ({ ...mockTerminalConfig, ...updates })),
    resetTheme: vi.fn().mockResolvedValue({ primary: '#default' }),
    onThemeChange: vi.fn().mockReturnValue(vi.fn()),
    onTerminalConfigChange: vi.fn().mockReturnValue(vi.fn()),
    ...overrides,
  };
  (globalThis as any).window = { api };
  return api;
}

describe('customization.store', () => {
  beforeEach(() => {
    resetStore();
    mockApi();
  });

  it('loadCustomization fetches theme and terminal config', async () => {
    await useCustomizationStore.getState().loadCustomization();
    const state = useCustomizationStore.getState();
    expect(state.theme).toEqual(mockTheme);
    expect(state.terminalConfig).toEqual(mockTerminalConfig);
    expect(state.isLoading).toBe(false);
  });

  it('loadCustomization handles errors', async () => {
    mockApi({ getTheme: vi.fn().mockRejectedValue(new Error('Failed')) });
    await useCustomizationStore.getState().loadCustomization();
    expect(useCustomizationStore.getState().error).toBe('Failed');
    expect(useCustomizationStore.getState().isLoading).toBe(false);
  });

  it('updateTheme updates theme', async () => {
    await useCustomizationStore.getState().updateTheme({ primary: '#red' });
    expect(useCustomizationStore.getState().theme?.primary).toBe('#red');
  });

  it('updateTheme handles errors', async () => {
    mockApi({ ...mockApi(), updateTheme: vi.fn().mockRejectedValue(new Error('Update failed')) });
    await useCustomizationStore.getState().updateTheme({ primary: '#red' });
    expect(useCustomizationStore.getState().error).toBe('Update failed');
  });

  it('updateTerminalConfig updates terminal config', async () => {
    await useCustomizationStore.getState().updateTerminalConfig({ fontSize: 18 });
    expect(useCustomizationStore.getState().terminalConfig?.fontSize).toBe(18);
  });

  it('resetTheme resets to default', async () => {
    await useCustomizationStore.getState().resetTheme();
    expect(useCustomizationStore.getState().theme).toEqual({ primary: '#default' });
  });

  it('subscribeToChanges sets up theme and terminal config listeners', () => {
    let themeCallback: ((theme: any) => void) | undefined;
    let termCallback: ((config: any) => void) | undefined;
    const unsubTheme = vi.fn();
    const unsubTerm = vi.fn();

    mockApi({
      onThemeChange: vi.fn((cb: any) => {
        themeCallback = cb;
        return unsubTheme;
      }),
      onTerminalConfigChange: vi.fn((cb: any) => {
        termCallback = cb;
        return unsubTerm;
      }),
    });

    const unsub = useCustomizationStore.getState().subscribeToChanges();

    themeCallback!({ primary: '#external' });
    expect(useCustomizationStore.getState().theme).toEqual({ primary: '#external' });

    termCallback!({ fontSize: 20 });
    expect(useCustomizationStore.getState().terminalConfig).toEqual({ fontSize: 20 });

    unsub();
    expect(unsubTheme).toHaveBeenCalled();
    expect(unsubTerm).toHaveBeenCalled();
  });
});
