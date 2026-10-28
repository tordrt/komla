/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openFolder = vi.fn();
vi.mock('../../../../src/renderer/lib/open-folder', () => ({ openFolder }));

const { FolderDropZone } =
  await import('../../../../src/renderer/components/workspaces/FolderDropZone');
const { useToastStore } = await import('../../../../src/renderer/stores/toast.store');

// A drag of entries from outside Komla; `paths` are what getPathForFile reads for each file.
function fileDrag(entries: Array<{ path: string; isDirectory: boolean }>) {
  return {
    types: ['Files'],
    dropEffect: 'none',
    items: entries.map(({ path, isDirectory }) => ({
      webkitGetAsEntry: () => ({ isDirectory }),
      getAsFile: () => ({ path }),
    })),
  };
}

describe('FolderDropZone', () => {
  const addToast = vi.fn();

  beforeEach(() => {
    openFolder.mockReset();
    addToast.mockReset();
    useToastStore.setState({ addToast });
    window.api = { getPathForFile: (file: { path: string }) => file.path } as never;
  });

  const zone = () => screen.getByText('Workspaces');

  it('outlines itself while a file drag is over it, and opens the first folder dropped', () => {
    render(<FolderDropZone>Workspaces</FolderDropZone>);
    const dataTransfer = fileDrag([
      { path: '/notes/a.md', isDirectory: false },
      { path: '/notes', isDirectory: true },
    ]);

    fireEvent.dragEnter(zone(), { dataTransfer });
    expect(screen.getByText('Drop a folder to open it')).toBeInTheDocument();
    fireEvent.drop(zone(), { dataTransfer });

    expect(screen.queryByText('Drop a folder to open it')).not.toBeInTheDocument();
    expect(openFolder).toHaveBeenCalledExactlyOnceWith('/notes');
  });

  it('says to drop a folder when only files were dropped', () => {
    render(<FolderDropZone>Workspaces</FolderDropZone>);
    fireEvent.drop(zone(), { dataTransfer: fileDrag([{ path: '/a.md', isDirectory: false }]) });
    expect(openFolder).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('Drop a folder to open it in Komla.', 'info');
  });

  it("leaves the sidebar's own drags alone", () => {
    render(<FolderDropZone>Workspaces</FolderDropZone>);
    const dataTransfer = { types: ['application/x-komla-group'], items: [] };
    fireEvent.dragEnter(zone(), { dataTransfer });
    fireEvent.drop(zone(), { dataTransfer });
    expect(screen.queryByText('Drop a folder to open it')).not.toBeInTheDocument();
    expect(openFolder).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
  });
});
