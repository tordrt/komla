/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PassphraseDialog } from '../../../../src/renderer/components/layout/PassphraseDialog';

import type { AskpassRequest } from '../../../../src/shared/types';

const KEY_PROMPT = "Enter passphrase for key '/home/me/.ssh/id_ed25519': ";

function keyRequest(overrides: Partial<AskpassRequest> = {}): AskpassRequest {
  return {
    id: 'req-1',
    prompt: KEY_PROMPT,
    canRemember: true,
    expiresAt: Date.now() + 2 * 60 * 1000,
    ...overrides,
  };
}

function renderDialog(request: AskpassRequest) {
  const onResponse = vi.fn();
  render(<PassphraseDialog open request={request} onResponse={onResponse} />);
  return { onResponse };
}

describe('PassphraseDialog remember option', () => {
  it('offers to remember until Komla quits, unchecked by default', async () => {
    const user = userEvent.setup();
    const { onResponse } = renderDialog(keyRequest());

    expect(screen.getByRole('checkbox', { name: 'Remember until Komla quits' })).not.toBeChecked();
    await user.type(screen.getByLabelText('Passphrase'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));

    expect(onResponse).toHaveBeenCalledWith('req-1', 'secret', false);
  });

  it('remembers the passphrase when the user ticks the option', async () => {
    const user = userEvent.setup();
    const { onResponse } = renderDialog(keyRequest());

    await user.click(screen.getByRole('checkbox', { name: 'Remember until Komla quits' }));
    await user.type(screen.getByLabelText('Passphrase'), 'secret{Enter}');

    expect(onResponse).toHaveBeenCalledWith('req-1', 'secret', true);
  });

  it('does not offer to remember when Komla cannot remember the answer', async () => {
    const user = userEvent.setup();
    const { onResponse } = renderDialog(keyRequest({ canRemember: false }));

    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Passphrase'), 'secret{Enter}');

    expect(onResponse).toHaveBeenCalledWith('req-1', 'secret', false);
  });
});

describe('PassphraseDialog deadline', () => {
  it('counts down to the deadline from Komla and cancels when it passes', async () => {
    const { onResponse } = renderDialog(keyRequest({ expiresAt: Date.now() + 1500 }));

    expect(screen.getByText('Timeout in 0:02')).toBeInTheDocument();
    await waitFor(() => expect(onResponse).toHaveBeenCalledWith('req-1', null), {
      timeout: 3000,
    });
  });
});
