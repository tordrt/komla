/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openFolder = vi.fn();
vi.mock('../../../../src/renderer/lib/open-folder', () => ({ openFolder }));

const { RecentFolders } =
  await import('../../../../src/renderer/components/workspaces/RecentFolders');
const { useConfigStore } = await import('../../../../src/renderer/stores/config.store');

// Main answers with the recent folders that are still there.
const getRecentFolders = vi.fn<() => Promise<string[]>>();
const setRecentFolders = (stored: string[], there = stored) => {
  getRecentFolders.mockResolvedValue(there);
  useConfigStore.setState({ config: { recentFolders: stored } as never });
};

describe('RecentFolders', () => {
  beforeEach(() => {
    openFolder.mockReset();
    window.api = { getRecentFolders } as never;
  });

  it('shows nothing before a folder was opened', async () => {
    setRecentFolders([]);
    const { container } = render(<RecentFolders />);
    await Promise.resolve();
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the five opened last by name, and opens one', async () => {
    setRecentFolders(['/a/one', 'C:\\work\\two', '/three', '/four', '/five', '/six']);
    render(<RecentFolders />);

    const rows = await screen.findAllByRole('button');
    expect(rows.map((row) => row.title)).toEqual([
      '/a/one',
      'C:\\work\\two',
      '/three',
      '/four',
      '/five',
    ]);
    expect(rows[1]).toHaveTextContent(/^two/);

    fireEvent.click(rows[1]);
    expect(openFolder).toHaveBeenCalledWith('C:\\work\\two');
  });

  it('leaves out folders that are gone, and asks again when the list changes', async () => {
    setRecentFolders(['/gone', '/there'], ['/there']);
    render(<RecentFolders />);
    expect((await screen.findAllByRole('button')).map((row) => row.title)).toEqual(['/there']);

    setRecentFolders(['/new', '/gone', '/there'], ['/new', '/there']);
    await screen.findByTitle('/new');
    expect(getRecentFolders).toHaveBeenCalledTimes(2);
  });
});
