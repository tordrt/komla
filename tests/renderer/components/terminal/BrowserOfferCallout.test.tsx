/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import React, { useRef } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openTerminalUrl = vi.hoisted(() => vi.fn());

vi.mock('../../../../src/renderer/lib/open-terminal-url', () => ({ openTerminalUrl }));

import { BrowserOfferCallout } from '../../../../src/renderer/components/terminal/BrowserOfferCallout';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import {
  useDevPreviewOffersStore,
  useRememberedOfferTargetsStore,
} from '../../../../src/renderer/stores/dev-preview-offers.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../../src/shared/types';

function Callout({ workspaceId }: { workspaceId: string }) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <TooltipProvider>
      <button ref={anchorRef} type="button">
        globe
      </button>
      <BrowserOfferCallout workspaceId={workspaceId} anchorRef={anchorRef} hidden={false} />
    </TooltipProvider>
  );
}

function offerPage(workspaceId: string, url: string): void {
  act(() =>
    useDevPreviewOffersStore
      .getState()
      .offer(workspaceId, { kind: 'page', page: { url, executionLocation: 'workspace' } })
  );
}

function rememberBox(): HTMLInputElement {
  return screen.getByRole('checkbox', { name: /Remember for this project/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 900,
    y: 0,
    top: 0,
    left: 900,
    right: 924,
    bottom: 28,
    width: 24,
    height: 28,
    toJSON: () => ({}),
  });
  useDevPreviewOffersStore.setState({ offers: {}, pending: {}, held: {} });
  useRememberedOfferTargetsStore.setState({ byScope: {} });
  useWorkspacesStore.setState({
    selectedWorkspaceId: 'ws-1',
    showDashboard: false,
    workspaces: [
      { id: 'ws-1', name: 'pricing', projectId: 'project-1', terminals: [] },
      { id: 'ws-2', name: 'billing', projectId: 'project-2', terminals: [] },
    ] as unknown as Workspace[],
  });
});

describe('BrowserOfferCallout', () => {
  it('asks where to open the offered page', () => {
    render(<Callout workspaceId="ws-1" />);
    offerPage('ws-1', 'http://localhost:5173/');

    expect(screen.getByRole('dialog', { name: 'Preview ready' })).toHaveTextContent(
      'localhost:5173'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));

    expect(openTerminalUrl).toHaveBeenCalledWith('http://localhost:5173/', 'external', {
      workspaceId: 'ws-1',
      executionLocation: 'workspace',
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("doesn't carry a ticked Remember to a later offer, or to another workspace's", () => {
    const { rerender } = render(<Callout workspaceId="ws-1" />);
    offerPage('ws-1', 'http://localhost:5173/');
    fireEvent.click(rememberBox());
    expect(rememberBox()).toBeChecked();

    offerPage('ws-1', 'http://localhost:5174/');
    expect(rememberBox()).not.toBeChecked();

    // An agent restarting its server offers the same page again.
    fireEvent.click(rememberBox());
    offerPage('ws-1', 'http://localhost:5174/');
    expect(rememberBox()).not.toBeChecked();

    fireEvent.click(rememberBox());
    offerPage('ws-2', 'http://localhost:3000/');
    rerender(<Callout workspaceId="ws-2" />);
    expect(rememberBox()).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Open in browser' }));
    expect(useRememberedOfferTargetsStore.getState().byScope).toEqual({});
  });

  it('stops asking once the project remembers a choice, as another window can', () => {
    render(<Callout workspaceId="ws-1" />);
    offerPage('ws-1', 'http://localhost:5173/');
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    act(() =>
      useRememberedOfferTargetsStore.getState().remember('project:project-1', 'page', 'preview')
    );

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('follows the globe when the layout moves it', async () => {
    render(<Callout workspaceId="ws-1" />);
    offerPage('ws-1', 'http://localhost:5173/');
    const dialog = screen.getByRole('dialog');
    expect(dialog.style.top).toBe('34px');

    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({
      x: 900,
      y: 40,
      top: 40,
      left: 900,
      right: 924,
      bottom: 68,
      width: 24,
      height: 28,
      toJSON: () => ({}),
    });

    await vi.waitFor(() => expect(dialog.style.top).toBe('74px'));
  });
});
