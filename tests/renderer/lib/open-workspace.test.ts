/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { revealTerminal } from '../../../src/renderer/lib/open-workspace';
import { useLayoutStore } from '../../../src/renderer/stores/layout.store';

const flash = vi.hoisted(() => vi.fn());

vi.mock('../../../src/renderer/stores/pane-flash.store', () => ({ flashPanes: flash }));

const initialLayout = useLayoutStore.getState();

/** The workspace's tabs as a window gets them: the agent's pane in the second. */
function tabsArrive(): void {
  useLayoutStore.setState({
    tabsByWorkspace: { ws: ['shell', 'agent'] },
    layoutsByTab: {
      ws: {
        shell: { type: 'leaf', id: 'pane-shell', terminalId: 'term-shell' },
        agent: { type: 'leaf', id: 'pane-agent', terminalId: 'term-agent' },
      },
    },
    activeTabByWorkspace: { ws: 'shell' },
    focusedPaneByTab: {},
  });
}

describe('revealTerminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    flash.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    useLayoutStore.setState(initialLayout, true);
  });

  it("shows the agent's pane once a workspace that just moved here gets its tabs", () => {
    revealTerminal('ws', 'term-agent');
    expect(flash).not.toHaveBeenCalled();

    tabsArrive();

    expect(useLayoutStore.getState().activeTabByWorkspace.ws).toBe('agent');
    expect(useLayoutStore.getState().focusedPaneByTab.ws).toEqual({ agent: 'pane-agent' });
    expect(flash).toHaveBeenCalledExactlyOnceWith(['term-agent']);

    // Tabs set up again a moment later show it again, without another flash.
    tabsArrive();
    expect(useLayoutStore.getState().activeTabByWorkspace.ws).toBe('agent');
    expect(flash).toHaveBeenCalledOnce();

    // After a while, tabs coming in are the user's own.
    vi.advanceTimersByTime(2_000);
    tabsArrive();
    expect(useLayoutStore.getState().activeTabByWorkspace.ws).toBe('shell');
  });

  it('leaves the tabs to the user once the pane showed at once', () => {
    tabsArrive();
    revealTerminal('ws', 'term-agent');
    expect(flash).toHaveBeenCalledOnce();

    tabsArrive();

    expect(useLayoutStore.getState().activeTabByWorkspace.ws).toBe('shell');
  });
});
