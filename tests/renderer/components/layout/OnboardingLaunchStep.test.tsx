/** @vitest-environment jsdom */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingLaunchStep } from '../../../../src/renderer/components/layout/OnboardingLaunchStep';

function props() {
  return { isCreating: false, error: null, onBack: vi.fn(), onFinish: vi.fn() };
}

describe('onboarding finish', () => {
  it('finishes setup without offering a demo', () => {
    const p = props();
    render(<OnboardingLaunchStep {...p} />);
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start working' }));
    expect(p.onFinish).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(p.onBack).toHaveBeenCalledOnce();
  });

  it('offers only Back and Start working', () => {
    render(<OnboardingLaunchStep {...props()} />);
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Back',
      'Start working',
    ]);
  });

  it('prevents duplicate submissions while finishing', () => {
    const p = props();
    render(<OnboardingLaunchStep {...p} isCreating />);
    expect(screen.getByRole('button', { name: 'Start working' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  it('holds Start working back while finishing is disabled', () => {
    render(<OnboardingLaunchStep {...props()} finishDisabled />);
    expect(screen.getByRole('button', { name: 'Start working' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
  });

  it('shows a completion error so setup can be retried', () => {
    render(<OnboardingLaunchStep {...props()} error="Could not save your agent" />);
    expect(screen.getByText('Could not save your agent')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start working' })).toBeEnabled();
  });
});
