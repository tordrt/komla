/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CustomSnoozeDialog } from '../../../../src/renderer/components/workspaces/SnoozeMenu';
import { toDateTimeInputValue } from '../../../../src/renderer/lib/snooze';

describe('CustomSnoozeDialog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses a time that passed while the dialog was open', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 20, 14, 0));
    const onSnooze = vi.fn();
    render(<CustomSnoozeDialog open onOpenChange={vi.fn()} onSnooze={onSnooze} />);

    fireEvent.change(screen.getByLabelText('Snooze until'), {
      target: { value: toDateTimeInputValue(new Date(2026, 9, 20, 14, 2).getTime()) },
    });
    vi.setSystemTime(new Date(2026, 9, 20, 14, 5));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze' }));

    expect(onSnooze).not.toHaveBeenCalled();
  });
});
