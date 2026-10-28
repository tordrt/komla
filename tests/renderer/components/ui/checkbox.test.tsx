/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Checkbox } from '../../../../src/renderer/components/ui/checkbox';

describe('Checkbox', () => {
  it('is a native checkbox named by its label', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <label>
        <Checkbox checked={false} onChange={(event) => onChange(event.target.checked)} />
        Run on stash
      </label>
    );

    const checkbox = screen.getByRole('checkbox', { name: 'Run on stash' });
    expect(checkbox).toHaveAttribute('type', 'checkbox');
    await user.click(screen.getByText('Run on stash'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('can be focused and toggled from the keyboard', async () => {
    const user = userEvent.setup();
    render(<Checkbox aria-label="Auto" defaultChecked={false} />);

    await user.tab();
    const checkbox = screen.getByRole('checkbox', { name: 'Auto' });
    expect(checkbox).toHaveFocus();
    expect(checkbox.className).toContain('focus-visible:ring-2');
    await user.keyboard(' ');
    expect(checkbox).toBeChecked();
  });

  it('does not change when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Checkbox aria-label="Auto" disabled onChange={onChange} />);

    await user.click(screen.getByRole('checkbox', { name: 'Auto' }));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Auto' })).toBeDisabled();
  });

  it('forwards its ref to the input and puts className on the box', () => {
    const ref = React.createRef<HTMLInputElement>();
    const { container } = render(<Checkbox ref={ref} aria-label="Auto" className="mt-0.5" />);

    expect(ref.current).toBe(screen.getByRole('checkbox', { name: 'Auto' }));
    expect(container.firstElementChild?.className).toContain('mt-0.5');
  });
});
