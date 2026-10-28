/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: any) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

import { BrowserTabList } from '../../../src/renderer/components/terminal/BrowserTabList';
import { usePaneSurfacesStore } from '../../../src/renderer/stores/pane-surfaces.store';

const BROWSER = 'surface:browser:test';
const tab = (id: string) => `${BROWSER}/${id}`;
const onCloseTab = vi.fn();

function browser() {
  const surface = usePaneSurfacesStore.getState().surfaces[BROWSER];
  if (surface?.kind !== 'browser') throw new Error('no browser');
  return surface;
}

function renderList() {
  return render(<BrowserTabList browserId={BROWSER} onCloseTab={onCloseTab} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  usePaneSurfacesStore.setState({
    surfaces: {
      [BROWSER]: {
        kind: 'browser',
        workspaceId: 'ws-1',
        browserTabs: [
          { id: tab('1'), url: 'http://localhost:5173/', title: 'Vite App' },
          { id: tab('2'), url: 'https://example.com/docs' },
          { id: tab('3'), url: '' },
        ],
        activeBrowserTabId: tab('1'),
      },
    },
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      disconnect(): void {}
    }
  );
});

describe('BrowserTabList', () => {
  it('names tabs by page title, then host, then as a new tab', () => {
    renderList();

    expect(screen.getByRole('button', { name: 'Vite App' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(screen.getByRole('button', { name: 'example.com' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('button', { name: 'New tab' })).toBeTruthy();
  });

  it('shows a tab when clicked', () => {
    renderList();

    fireEvent.click(screen.getByRole('button', { name: 'example.com' }));

    expect(browser().activeBrowserTabId).toBe(tab('2'));
  });

  it('adds an empty tab after the others and shows it', () => {
    renderList();

    fireEvent.click(screen.getByLabelText('New browser tab'));

    const { browserTabs, activeBrowserTabId } = browser();
    expect(browserTabs).toHaveLength(4);
    expect(browserTabs[3]).toEqual({ id: activeBrowserTabId, url: '' });
    expect(activeBrowserTabId?.startsWith(`${BROWSER}/`)).toBe(true);
  });

  it('closes a tab from its close button and on middle-click', () => {
    renderList();

    fireEvent.click(screen.getByLabelText('Close Vite App'));
    fireEvent(
      screen.getByRole('button', { name: 'example.com' }),
      new MouseEvent('auxclick', { bubbles: true, button: 1 })
    );

    expect(onCloseTab.mock.calls).toEqual([[tab('1')], [tab('2')]]);
  });
});
