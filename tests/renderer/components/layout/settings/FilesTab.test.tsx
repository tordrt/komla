/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FilesTab } from '../../../../../src/renderer/components/layout/settings/FilesTab';

const mocks = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  updateConfig: vi.fn(),
}));

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (
    selector: (state: { config: Record<string, unknown>; updateConfig: () => void }) => unknown
  ) => selector({ config: mocks.config, updateConfig: mocks.updateConfig }),
}));

describe('FilesTab', () => {
  beforeEach(() => {
    mocks.config = {};
  });

  it('leaves the file tree hidden in new workspaces unless turned on', () => {
    render(<FilesTab />);
    expect(screen.getByRole('switch', { name: 'Show file tree by default' })).not.toBeChecked();
  });

  it('picks the default file tree mode from a radio group', async () => {
    const user = userEvent.setup();
    render(<FilesTab />);

    expect(screen.getByRole('radiogroup', { name: 'Default mode' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Diff' })).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByRole('radio', { name: 'Browse' }));

    expect(mocks.updateConfig).toHaveBeenCalledWith({ defaultFileTreeMode: 'browse' });
  });

  it('picks where search results open from a radio group', async () => {
    const user = userEvent.setup();
    mocks.config = { defaultSearchOpenMode: 'viewer' };
    render(<FilesTab />);

    expect(screen.getByRole('radiogroup', { name: 'Open search results in' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Full screen' })).toHaveAttribute(
      'aria-checked',
      'true'
    );

    await user.click(screen.getByRole('radio', { name: 'Workspace view' }));

    expect(mocks.updateConfig).toHaveBeenCalledWith({ defaultSearchOpenMode: 'preview' });
  });
});
