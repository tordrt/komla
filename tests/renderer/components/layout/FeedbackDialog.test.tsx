/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FeedbackDialog } from '../../../../src/renderer/components/layout/FeedbackDialog';

vi.mock('../../../../src/renderer/components/ui/dialog', () => ({
  // "Dismiss" stands in for Escape / outside click, which Radix reports via onOpenChange(false).
  Dialog: ({
    open,
    onOpenChange,
    children,
  }: React.PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) =>
    open ? (
      <div>
        <button type="button" onClick={() => onOpenChange?.(false)}>
          Dismiss
        </button>
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

vi.mock('../../../../src/renderer/stores/license.store', () => ({
  useLicenseStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ status: { customerEmail: null }, loadStatus: vi.fn() }),
}));

const mockAddToast = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/renderer/stores/toast.store', () => ({
  useToastStore: () => ({ addToast: mockAddToast }),
}));

function Harness() {
  const [open, setOpen] = React.useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open feedback
      </button>
      <FeedbackDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

describe('FeedbackDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.api = {
      sendFeedback: vi.fn().mockResolvedValue({ success: true }),
      selectScreenshots: vi.fn().mockResolvedValue([]),
    } as never;
  });

  it('shows only the file name for Windows screenshot paths', async () => {
    const user = userEvent.setup();
    vi.mocked(window.api.selectScreenshots).mockResolvedValue([
      'C:\\Users\\me\\Pictures\\shot.png',
    ]);
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Add screenshot' }));

    expect(await screen.findByText('shot.png')).toBeInTheDocument();
    expect(screen.queryByText(/Pictures/)).not.toBeInTheDocument();
  });

  it('keeps the draft when the dialog is dismissed without sending', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: 'Bug report' }));
    await user.type(screen.getByPlaceholderText(/describe what happened/i), 'A long report');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Open feedback' }));

    expect(screen.getByRole('radio', { name: 'Bug report' })).toBeChecked();
    expect(screen.getByPlaceholderText(/describe what happened/i)).toHaveValue('A long report');
  });

  it('clears the draft after feedback is sent', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('radio', { name: 'Bug report' }));
    await user.type(screen.getByPlaceholderText(/describe what happened/i), 'A long report');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument());
    expect(window.api.sendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'bug', description: 'A long report' })
    );

    await user.click(screen.getByRole('button', { name: 'Open feedback' }));

    expect(screen.getByRole('radio', { name: 'General' })).toBeChecked();
    expect(screen.getByPlaceholderText('Share your thoughts...')).toHaveValue('');
  });
});
