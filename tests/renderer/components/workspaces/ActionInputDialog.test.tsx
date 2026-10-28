/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  ActionInputDialog,
  getActionInputContextLine,
} from '../../../../src/renderer/components/workspaces/ActionInputDialog';

vi.mock('../../../../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));

function renderDialog(props: Partial<React.ComponentProps<typeof ActionInputDialog>> = {}) {
  return render(
    <ActionInputDialog
      open
      actionTitle="Review"
      actionContent="Review {{user_input}}"
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
      {...props}
    />
  );
}

describe('ActionInputDialog', () => {
  it('labels the confirm button "Run quick command" by default', () => {
    renderDialog();

    expect(screen.getByRole('button', { name: 'Run quick command' })).toBeInTheDocument();
  });

  it('uses a custom confirm label when provided', () => {
    renderDialog({ confirmLabel: 'Insert' });

    expect(screen.getByRole('button', { name: 'Insert' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run quick command' })).not.toBeInTheDocument();
  });

  it('offers the last input without prefilling it, so Enter alone never reruns it', () => {
    const onConfirm = vi.fn();
    renderDialog({ lastInput: 'BAT-42', onConfirm });

    const input = screen.getByRole('textbox', { name: 'Text for Review' });
    expect(input).toHaveValue('');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Use last input: BAT-42' }));
    expect(input).toHaveValue('BAT-42');
    expect(screen.queryByRole('button', { name: /Use last input/ })).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onConfirm).toHaveBeenCalledWith('BAT-42');
  });

  it('fills the last input on ArrowUp in an empty box', () => {
    renderDialog({ lastInput: 'BAT-42' });

    const input = screen.getByRole('textbox', { name: 'Text for Review' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    expect(input).toHaveValue('BAT-42');
  });

  it('keeps Shift+Enter and IME Enter for the text, and ignores Enter with no input', () => {
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });

    const input = screen.getByRole('textbox', { name: 'Text for Review' });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.change(input, { target: { value: 'BAT-42' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('hides the full prompt until asked, then shows the input in place', () => {
    renderDialog({ actionContent: '# Investigate\n\n{{user_input}}\n\nTrace the problem.' });

    expect(screen.queryByText(/Trace the problem/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Text for Review' }), {
      target: { value: 'TypeError at card.tsx:42' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show prompt' }));

    expect(screen.getByText(/Trace the problem/)).toBeInTheDocument();
    expect(screen.getByText('TypeError at card.tsx:42', { selector: 'span' })).toBeInTheDocument();
  });

  it('starts empty and collapsed each time it opens', () => {
    const props = {
      actionTitle: 'Review',
      actionContent: 'Review {{user_input}}',
      onCancel: vi.fn(),
      onConfirm: vi.fn(),
    };
    const { rerender } = renderDialog();
    fireEvent.change(screen.getByRole('textbox', { name: 'Text for Review' }), {
      target: { value: 'draft' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Show prompt' }));

    rerender(<ActionInputDialog open={false} {...props} />);
    rerender(<ActionInputDialog open {...props} />);

    expect(screen.getByRole('textbox', { name: 'Text for Review' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Show prompt' })).toBeInTheDocument();
  });
});

describe('getActionInputContextLine', () => {
  it('returns the line around the input, without Markdown markers', () => {
    expect(getActionInputContextLine('Intro\n- Fix issue {{user_input}} now')).toBe(
      'Fix issue {{user_input}} now'
    );
  });

  it('strips nested markers and inline Markdown', () => {
    expect(getActionInputContextLine('> - **Issue:** `{{user_input}}` today')).toBe(
      'Issue: {{user_input}} today'
    );
  });

  it('cuts a long line to the words around the input', () => {
    const before = 'You are a careful senior engineer. '.repeat(6);
    const after = ' and report what you find in detail.'.repeat(6);
    const line = getActionInputContextLine(`${before}Investigate {{user_input}}${after}`);

    expect(line).toMatch(/^….*Investigate \{\{user_input\}\} and report.*…$/);
    expect(line!.length).toBeLessThan(150);
  });

  it('returns null when the input sits on a line of its own', () => {
    expect(getActionInputContextLine('# Investigate\n\n{{user_input}}\n\nTrace it.')).toBeNull();
    expect(getActionInputContextLine('## {{user_input}}:')).toBeNull();
  });
});
