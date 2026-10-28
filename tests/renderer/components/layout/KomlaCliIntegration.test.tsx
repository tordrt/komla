/** @vitest-environment jsdom */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { KomlaCliIntegration } from '../../../../src/renderer/components/layout/KomlaCliIntegration';

describe('further integration', () => {
  it('links the public CLI documentation', () => {
    Object.assign(window, { api: { websiteUrl: 'https://komla.dev' } });
    render(<KomlaCliIntegration komlaBasePath={null} />);
    const link = screen.getByRole('link', { name: /Read the CLI docs/ });
    expect(link).toHaveAttribute('href', 'https://komla.dev/komla-cli');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('copies the install command using the actual Komla data directory', async () => {
    const copyToClipboard = vi.fn().mockResolvedValue(undefined);
    Object.assign(window, { api: { copyToClipboard } });
    render(<KomlaCliIntegration komlaBasePath="/data/Komla Dev" />);
    fireEvent.click(screen.getByText('Install the Komla skill for another agent'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Komla skill install command' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied'));
    expect(copyToClipboard).toHaveBeenCalledWith(
      'npx skills add "/data/Komla Dev/skills" --skill komla --global'
    );
  });

  it('does not offer a placeholder command before the path resolves', () => {
    render(<KomlaCliIntegration komlaBasePath={null} />);
    fireEvent.click(screen.getByText('Install the Komla skill for another agent'));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    for (const status of screen.getAllByRole('status')) {
      expect(status).toHaveTextContent('Loading');
    }
  });
});
