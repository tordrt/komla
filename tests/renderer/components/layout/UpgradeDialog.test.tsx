/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpgradeDialog } from '../../../../src/renderer/components/layout/UpgradeDialog';

const mockGetPlanPrices = vi.fn();
const mockOpenExternal = vi.fn();
const mockStopWorkspace = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockState = vi.hoisted(() => ({
  workspaces: [] as Array<{
    id: string;
    name: string;
    workingDirectory: string;
    provisioning?: boolean;
    backend?: { kind: 'ssh' };
    terminals: Array<{
      id: string;
      status: string;
      remoteSessionActive?: boolean;
      executionLocation?: 'local-mirror';
    }>;
  }>,
}));

vi.mock('../../../../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({
    children,
    'aria-describedby': describedBy,
  }: React.PropsWithChildren<{ 'aria-describedby'?: string }>) => (
    <div role="dialog" aria-describedby={describedBy}>
      {children}
    </div>
  ),
  DialogDescription: ({ children, id }: React.PropsWithChildren<{ id?: string }>) => (
    <div id={id}>{children}</div>
  ),
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

const licenseState = vi.hoisted(() => ({
  activateLicense: vi.fn(),
  isLoading: false,
  error: null as string | null,
  quota: null as unknown,
}));

vi.mock('../../../../src/renderer/stores/license.store', () => ({
  useLicenseStore: Object.assign(
    (selector?: (value: typeof licenseState) => unknown) =>
      selector ? selector(licenseState) : licenseState,
    { getState: () => licenseState }
  ),
}));

vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: unknown) => unknown) =>
    selector({
      workspaces: mockState.workspaces,
      stopWorkspace: mockStopWorkspace,
    }),
}));

// The free limit counts running SSH workspaces only.
function runningWorkspace(id: string) {
  return {
    id,
    name: `Workspace ${id}`,
    workingDirectory: `ssh://host-1/work/${id}`,
    backend: { kind: 'ssh' as const },
    terminals: [{ id: `terminal-${id}`, status: 'running' }],
  };
}

// The price line's lead is its own element, so match the whole paragraph.
function priceLine(text: string) {
  return (_: string, element: Element | null) =>
    element?.tagName === 'P' && element.textContent === text;
}

describe('UpgradeDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetPlanPrices.mockResolvedValue(null);
    Object.defineProperty(window, 'api', {
      value: {
        getPlanPrices: mockGetPlanPrices,
        openExternal: mockOpenExternal,
        getTelemetryDistinctId: vi.fn().mockResolvedValue(null),
        trackMonetizationEvent: vi.fn(),
        websiteUrl: 'https://komla.dev',
      },
      configurable: true,
      writable: true,
    });
    licenseState.quota = null;
    mockState.workspaces = [
      runningWorkspace('one'),
      runningWorkspace('two'),
      runningWorkspace('three'),
      runningWorkspace('four'),
    ];
  });

  it('keeps stopping workspaces until a parallel launch has enough slots', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onRetry = Object.assign(vi.fn(), { requestedWorkspaceCount: 2 });
    const { rerender } = render(
      <UpgradeDialog open={true} onOpenChange={onOpenChange} workspaceLimit={4} onRetry={onRetry} />
    );

    expect(screen.getByText('Or free up 2 slots')).toBeInTheDocument();
    expect(screen.getByText('Stop 2 running SSH workspaces to start 2 more.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /workspace one/i }));
    expect(mockStopWorkspace).toHaveBeenCalledWith('one');
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();

    mockState.workspaces = mockState.workspaces.slice(1);
    rerender(
      <UpgradeDialog open={true} onOpenChange={onOpenChange} workspaceLimit={4} onRetry={onRetry} />
    );

    expect(screen.getByText('Or free up a slot')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /workspace two/i }));
    expect(mockStopWorkspace).toHaveBeenCalledWith('two');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('counts a detached SSH session as running, as the limit does', async () => {
    const user = userEvent.setup();
    mockState.workspaces = [
      runningWorkspace('one'),
      runningWorkspace('two'),
      runningWorkspace('three'),
      {
        id: 'detached',
        name: 'Workspace detached',
        workingDirectory: 'ssh://host-1/work/detached',
        backend: { kind: 'ssh' },
        terminals: [{ id: 'terminal-detached', status: 'stopped', remoteSessionActive: true }],
      },
    ];
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} workspaceLimit={4} />);

    expect(screen.getByText('Or free up a slot')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop Workspace detached' }));
    expect(mockStopWorkspace).toHaveBeenCalledWith('detached');
  });

  it('neither counts nor offers to stop local workspaces, which are unlimited', () => {
    mockState.workspaces = [
      ...mockState.workspaces.slice(0, 3),
      {
        id: 'local',
        name: 'Workspace local',
        workingDirectory: '/tmp/local',
        terminals: [{ id: 'terminal-local', status: 'running' }],
      },
      // A Local copy runs on this computer too.
      {
        id: 'copy',
        name: 'Workspace copy',
        workingDirectory: 'ssh://host-1/work/copy',
        backend: { kind: 'ssh' },
        terminals: [{ id: 'terminal-copy', status: 'running', executionLocation: 'local-mirror' }],
      },
    ];
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} workspaceLimit={4} />);

    expect(screen.queryByRole('button', { name: 'Stop Workspace local' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop Workspace copy' })).not.toBeInTheDocument();
    expect(screen.getByText('3/4')).toBeInTheDocument();
    expect(screen.getByText(/unlimited local workspaces\./)).toBeInTheDocument();
  });

  it('labels each running workspace card with a Stop action', async () => {
    const user = userEvent.setup();
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} workspaceLimit={4} />);

    const card = screen.getByRole('button', { name: 'Stop Workspace one' });
    expect(card).toHaveTextContent('Stop');

    await user.click(card);
    expect(mockStopWorkspace).toHaveBeenCalledWith('one');
  });

  it('shows the KOMLA- prefix in the license key placeholder', async () => {
    const user = userEvent.setup();
    render(
      <UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" workspaceLimit={4} />
    );

    await user.click(screen.getByRole('button', { name: 'I have a license key' }));

    expect(screen.getByRole('textbox', { name: 'License key' })).toHaveAttribute(
      'placeholder',
      'KOMLA-XXXX-XXXX-XXXX-XXXX'
    );
  });

  it('does not fade "Maybe later" to half opacity', () => {
    render(
      <UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" workspaceLimit={4} />
    );

    expect(screen.getByRole('button', { name: 'Maybe later' }).className).not.toMatch(
      /text-muted-foreground\/50/
    );
  });

  it('shows the full running count in a warning color, not an error color', () => {
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} workspaceLimit={4} />);

    const count = screen.getByText('4/4 running');
    expect(count).toHaveClass('text-warning');
    expect(count).not.toHaveClass('text-destructive');
    expect(count).not.toHaveClass('text-error');
  });

  it('leads with the yearly price per month and keeps lifetime while it lasts', async () => {
    mockGetPlanPrices.mockResolvedValue({
      currency: 'usd',
      monthly: 1900,
      yearly: 7900,
      lifetime: 9900,
    });
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" />);

    expect(
      await screen.findByText(priceLine('Under $7/month billed yearly · $19 monthly · $99 once'))
    ).toBeInTheDocument();
    expect(screen.getByText('Under $7/month')).toHaveClass('text-foreground');
  });

  it('leaves the lifetime price out once it has ended', async () => {
    mockGetPlanPrices.mockResolvedValue({
      currency: 'eur',
      monthly: 1700,
      yearly: 6500,
      lifetime: null,
    });
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" />);

    expect(
      await screen.findByText(priceLine('Under €6/month billed yearly · €17 monthly'))
    ).toBeInTheDocument();
  });

  it('shows an exact monthly price when the yearly price divides evenly', async () => {
    mockGetPlanPrices.mockResolvedValue({
      currency: 'usd',
      monthly: 1900,
      yearly: 8400,
      lifetime: null,
    });
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" />);

    expect(await screen.findByText('$7/month')).toBeInTheDocument();
  });

  it('opens the buy page in the currency the dialog priced in', async () => {
    const user = userEvent.setup();
    mockGetPlanPrices.mockResolvedValue({
      currency: 'eur',
      monthly: 1700,
      yearly: 6500,
      lifetime: 8500,
    });
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" />);
    await screen.findByText('Under €6/month');

    await user.click(screen.getByRole('button', { name: 'Go unlimited' }));

    await waitFor(() => expect(mockOpenExternal).toHaveBeenCalled());
    const url = new URL(mockOpenExternal.mock.calls[0][0]);
    expect(url.searchParams.get('currency')).toBe('eur');
  });

  it('drops the previous prices while the dialog is closed', async () => {
    mockGetPlanPrices.mockResolvedValue({
      currency: 'usd',
      monthly: 1900,
      yearly: 7900,
      lifetime: 9900,
    });
    const { rerender } = render(
      <UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" />
    );
    await screen.findByText('Under $7/month');

    rerender(<UpgradeDialog open={false} onOpenChange={vi.fn()} trigger="settings" />);
    // The lifetime offer ends while the dialog is closed, and the next fetch hangs.
    mockGetPlanPrices.mockReturnValue(new Promise(() => {}));
    rerender(<UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" />);

    expect(screen.queryByText(/\$99/)).not.toBeInTheDocument();
  });

  it('shows no prices when they are unavailable', async () => {
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" />);

    await waitFor(() => expect(mockGetPlanPrices).toHaveBeenCalled());
    expect(screen.queryByText(/billed yearly/)).not.toBeInTheDocument();
  });

  it('leads with the upgrade at the limit and offers stopping a workspace after it', () => {
    render(<UpgradeDialog open={true} onOpenChange={vi.fn()} workspaceLimit={4} />);

    expect(screen.getByText('Run all 5 SSH workspaces at once')).toBeInTheDocument();
    const upgrade = screen.getByRole('button', { name: 'Go unlimited' });
    const firstStop = screen.getByRole('button', { name: 'Stop Workspace one' });
    expect(
      upgrade.compareDocumentPosition(firstStop) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('compares Free with Unlimited when opened from the sidebar meter', () => {
    mockState.workspaces = mockState.workspaces.slice(0, 2);
    const { rerender } = render(
      <UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" workspaceLimit={4} />
    );

    expect(screen.getByText("Support Komla's development")).toBeInTheDocument();
    expect(screen.getByText(/^Free runs up to 4 SSH workspaces at once\./)).toBeInTheDocument();
    expect(screen.queryByText('Agents')).not.toBeInTheDocument();
    expect(screen.getByText('2/4')).not.toHaveClass('text-warning');
    expect(screen.getByText('No cap')).toBeInTheDocument();

    mockState.workspaces = [
      runningWorkspace('one'),
      runningWorkspace('two'),
      runningWorkspace('three'),
      runningWorkspace('four'),
    ];
    rerender(
      <UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" workspaceLimit={4} />
    );

    expect(screen.getByText("You're at the free limit")).toBeInTheDocument();
    expect(screen.getByText('4/4')).toHaveClass('text-warning');
  });

  it('says what the free plan covers in every state, as part of the description', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <UpgradeDialog open={true} onOpenChange={vi.fn()} workspaceLimit={4} />
    );
    expect(screen.getByText('Run all 5 SSH workspaces at once')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      /^Free runs up to 4 SSH workspaces at once\..*Komla is free with every feature and unlimited local workspaces\./
    );

    await user.click(screen.getByRole('button', { name: 'I have a license key' }));
    expect(screen.getByText(/^Komla is free with every feature/)).toBeInTheDocument();

    mockState.workspaces = mockState.workspaces.slice(0, 2);
    rerender(
      <UpgradeDialog open={true} onOpenChange={vi.fn()} trigger="settings" workspaceLimit={4} />
    );
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(
      /Licenses from people running it on remote machines keep it in development\.$/
    );
  });

  it('starts the waiting workspace once a license key activates', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onRetry = vi.fn();
    render(
      <UpgradeDialog open={true} onOpenChange={onOpenChange} workspaceLimit={4} onRetry={onRetry} />
    );

    await user.click(screen.getByRole('button', { name: 'I have a license key' }));
    await user.type(screen.getByRole('textbox', { name: 'License key' }), 'KOMLA-AAAA{Enter}');

    expect(licenseState.activateLicense).toHaveBeenCalledWith('KOMLA-AAAA');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
