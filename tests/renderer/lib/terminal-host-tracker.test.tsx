/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostInfo } from '../../../src/shared/types/terminal';

describe('terminal-host-tracker', () => {
  let emitHostChange: (terminalId: string, hostname: string, isLocal: boolean) => void;

  beforeEach(() => {
    vi.resetModules();
    Object.assign(window as any, {
      api: {
        onTerminalHostChanged: vi.fn((callback) => {
          emitHostChange = callback;
          return () => {};
        }),
      },
    });
  });

  it('follows host changes for its own terminal', async () => {
    const { clearTerminalHost, useTerminalHost } =
      await import('../../../src/renderer/lib/terminal-host-tracker');
    const { result } = renderHook(() => useTerminalHost('current-terminal'));

    expect(result.current).toBeNull();

    act(() => emitHostChange('other-terminal', 'devbox', false));
    expect(result.current).toBeNull();

    act(() => emitHostChange('current-terminal', 'devbox', false));
    expect(result.current).toEqual({ hostname: 'devbox', isLocal: false });

    act(() => clearTerminalHost('current-terminal'));
    expect(result.current).toBeNull();
  });

  it('restores the host a terminal reported before its view attached', async () => {
    const { hydrateTerminalHost, useTerminalHost } =
      await import('../../../src/renderer/lib/terminal-host-tracker');
    const hostInfo: TerminalHostInfo = {
      hostname: 'devbox',
      isLocal: false,
    };

    act(() => hydrateTerminalHost('current-terminal', hostInfo));
    const { result } = renderHook(() => useTerminalHost('current-terminal'));

    expect(result.current).toEqual(hostInfo);
  });
});
