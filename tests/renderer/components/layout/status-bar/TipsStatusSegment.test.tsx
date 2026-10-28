/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TipsStatusSegment } from '../../../../../src/renderer/components/layout/status-bar/TipsStatusSegment';
import { useSshHostDialogStore } from '../../../../../src/renderer/stores/ssh-host-dialog.store';

const banner = vi.hoisted(() => ({ showing: false }));

vi.mock('../../../../../src/renderer/components/layout/BannerHost', () => ({
  useAnyBannerShowing: () => banner.showing,
}));

const mockState = vi.hoisted(() => ({
  config: {} as Record<string, unknown> | null,
  updateConfig: vi.fn(),
}));

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: (state: typeof mockState) => unknown) => selector(mockState),
}));

// Tips has its own tests; here it only shows whether it's open.
vi.mock('../../../../../src/renderer/components/layout/GettingStartedMenu', () => ({
  GettingStartedMenu: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <>
      <span>{open ? 'Tips open' : 'Tips closed'}</span>
      <button type="button" onClick={() => onOpenChange(!open)}>
        Tips
      </button>
    </>
  ),
}));

const actions = {
  onOpenShortcuts: vi.fn(),
  onOpenFeedback: vi.fn(),
  onOpenSettingsTab: vi.fn(),
  onOpenNewWorkspace: vi.fn(),
};

describe('TipsStatusSegment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockState.config = {};
    mockState.updateConfig = vi.fn();
    useSshHostDialogStore.setState({ open: false, request: null });
    banner.showing = false;
  });

  afterEach(() => vi.useRealTimers());

  const pointer = () => screen.queryByRole('dialog', { name: 'Tips' });

  it('points at Tips after setup without opening it, until Got it', () => {
    mockState.config = { tipsIntroPending: true };
    render(<TipsStatusSegment {...actions} />);
    expect(pointer()).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(2000));

    expect(pointer()).toHaveTextContent('Tips live here');
    expect(screen.getByText('Tips closed')).toBeInTheDocument();

    act(() => screen.getByRole('button', { name: 'Got it' }).click());
    expect(pointer()).not.toBeInTheDocument();
    expect(screen.getByText('Tips closed')).toBeInTheDocument();
    expect(mockState.updateConfig).toHaveBeenCalledWith({ tipsIntroPending: false });
  });

  it('opens Tips from the pointer', () => {
    mockState.config = { tipsIntroPending: true };
    render(<TipsStatusSegment {...actions} />);
    act(() => vi.advanceTimersByTime(2000));

    act(() => screen.getByRole('button', { name: 'Show tips' }).click());

    expect(screen.getByText('Tips open')).toBeInTheDocument();
    expect(pointer()).not.toBeInTheDocument();
  });

  it('goes away while Tips is open from its button', () => {
    mockState.config = { tipsIntroPending: true };
    render(<TipsStatusSegment {...actions} />);
    act(() => vi.advanceTimersByTime(2000));

    act(() => screen.getByRole('button', { name: 'Tips' }).click());

    expect(screen.getByText('Tips open')).toBeInTheDocument();
    expect(pointer()).not.toBeInTheDocument();
  });

  it('closes on Escape only from inside', () => {
    mockState.config = { tipsIntroPending: true };
    render(<TipsStatusSegment {...actions} />);
    act(() => vi.advanceTimersByTime(2000));

    // Meant for a terminal, say: it reaches the app as usual and the pointer stays.
    const elsewhere = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => document.body.dispatchEvent(elsewhere));
    expect(elsewhere.defaultPrevented).toBe(false);
    expect(pointer()).toBeInTheDocument();
    expect(mockState.updateConfig).not.toHaveBeenCalled();

    act(() => {
      fireEvent.keyDown(screen.getByRole('button', { name: 'Got it' }), { key: 'Escape' });
    });
    expect(pointer()).not.toBeInTheDocument();
    expect(mockState.updateConfig).toHaveBeenCalledWith({ tipsIntroPending: false });
  });

  it('waits while a dialog is open, then starts its delay over', async () => {
    mockState.config = { tipsIntroPending: true };
    render(<TipsStatusSegment {...actions} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(pointer()).toBeInTheDocument();

    // Radix locks the page's scrolling while a modal dialog is open.
    await act(async () => document.body.setAttribute('data-scroll-locked', '1'));
    expect(pointer()).not.toBeInTheDocument();

    await act(async () => document.body.removeAttribute('data-scroll-locked'));
    expect(pointer()).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2000));
    expect(pointer()).toBeInTheDocument();
  });

  it('waits for the SSH host dialog setup opened', () => {
    mockState.config = { tipsIntroPending: true };
    useSshHostDialogStore.setState({ open: true });
    render(<TipsStatusSegment {...actions} />);

    act(() => vi.advanceTimersByTime(2000));
    expect(pointer()).not.toBeInTheDocument();

    act(() => useSshHostDialogStore.setState({ open: false }));
    act(() => vi.advanceTimersByTime(2000));
    expect(pointer()).toBeInTheDocument();
  });

  it('waits while a banner shows', () => {
    mockState.config = { tipsIntroPending: true };
    banner.showing = true;
    const { rerender } = render(<TipsStatusSegment {...actions} />);

    act(() => vi.advanceTimersByTime(2000));
    expect(pointer()).not.toBeInTheDocument();

    banner.showing = false;
    rerender(<TipsStatusSegment {...actions} />);
    act(() => vi.advanceTimersByTime(2000));
    expect(pointer()).toBeInTheDocument();
  });

  it('points at nothing without setup just finished', () => {
    render(<TipsStatusSegment {...actions} />);

    act(() => vi.advanceTimersByTime(2000));

    expect(pointer()).not.toBeInTheDocument();
    expect(mockState.updateConfig).not.toHaveBeenCalled();
  });
});
