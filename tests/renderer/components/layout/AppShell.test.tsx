/**
 * @vitest-environment jsdom
 */
import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '../../../../src/renderer/components/layout/AppShell';

import type { SettingsApprovalPrompt } from '../../../../src/shared/types';

vi.mock('../../../../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

let onRequested: ((prompt: SettingsApprovalPrompt) => void) | undefined;

describe('AppShell', () => {
  beforeEach(() => {
    onRequested = undefined;
    global.window.api = {
      onSettingsApprovalRequested: vi.fn((callback) => {
        onRequested = callback;
        return vi.fn();
      }),
      onSettingsApprovalDismissed: vi.fn(() => vi.fn()),
      requestPendingSettingsApproval: vi.fn().mockResolvedValue(false),
      resolveSettingsApproval: vi.fn().mockResolvedValue(true),
    } as typeof window.api;
  });

  it('keeps a pending settings approval across app-content transitions', () => {
    const { rerender } = render(
      <AppShell>
        <div>Loading</div>
      </AppShell>
    );
    act(() => {
      onRequested?.({
        id: 'approval-1',
        resource: 'actions',
        target: 'Global Actions',
        changes: [
          {
            operation: 'add',
            kind: 'action',
            title: 'Start dev server',
            contentLabel: 'Command',
            content: 'npm run dev',
            details: [],
          },
        ],
      });
    });

    rerender(
      <AppShell>
        <div>Setup wizard</div>
      </AppShell>
    );

    expect(screen.getByText('Start dev server')).toBeInTheDocument();
  });
});
