/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';

import {
  filePanelShows,
  openInFilePanel,
  linkedFileOpener,
} from '../../../../src/renderer/components/terminal/file-panel';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';
import { useWorkspacesStore } from '../../../../src/renderer/stores/workspaces.store';

import type { Workspace } from '../../../../src/renderer/types';

describe('filePanelShows', () => {
  it('shows code, text and the types it previews', () => {
    for (const filePath of ['src/main.ts', 'docs/NOTES.md', 'out/results.json', 'shots/a.png']) {
      expect(filePanelShows(filePath, 'local')).toBe(true);
    }
    expect(filePanelShows('report/index.html', 'ssh')).toBe(true);
  });

  it('leaves types it would read as text, unknowingly, to quick look', () => {
    expect(filePanelShows('dist/app.tar.gz', 'local')).toBe(false);
    expect(filePanelShows('data/app.sqlite', 'local')).toBe(false);
  });

  it('previews PDFs and media only on this computer', () => {
    expect(filePanelShows('out/report.pdf', 'local')).toBe(true);
    expect(filePanelShows('recordings/demo.mp4', 'local')).toBe(true);
    expect(filePanelShows('out/report.pdf', 'ssh')).toBe(false);
    expect(filePanelShows('recordings/demo.mp4', 'ssh')).toBe(false);
  });
});

describe('openInFilePanel', () => {
  it('asks the panel to show the file with its tree on its files', () => {
    const requestInlineFilePreviewNav = vi.fn();
    useFileViewerStore.setState({ fileViewerWorkspaceId: null, requestInlineFilePreviewNav });

    openInFilePanel('ws-1', 'src/main.ts', 12);

    // The store switches the tree only once the nav lands, past any unsaved-changes prompt.
    expect(requestInlineFilePreviewNav).toHaveBeenCalledWith('ws-1', 'browse', 'src/main.ts', 12, {
      browseTree: true,
    });
  });
});

describe('linkedFileOpener', () => {
  function setUp(backend?: Workspace['backend']) {
    const requestInlineFilePreviewNav = vi.fn();
    useFileViewerStore.setState({ fileViewerWorkspaceId: null, requestInlineFilePreviewNav });
    useWorkspacesStore.setState({ workspaces: [{ id: 'ws-1', backend } as Workspace] });
    return requestInlineFilePreviewNav;
  }

  it('opens a linked file in the file panel', () => {
    const requestInlineFilePreviewNav = setUp();
    const links = linkedFileOpener('ws-1');
    expect(links.canOpen('docs/setup.md')).toBe(true);
    links.open('docs/setup.md');
    expect(requestInlineFilePreviewNav).toHaveBeenCalledWith(
      'ws-1',
      'browse',
      'docs/setup.md',
      undefined,
      { browseTree: true }
    );
  });

  it("can't open a file the panel doesn't show, or one in a workspace it doesn't know", () => {
    setUp({ kind: 'ssh' } as Workspace['backend']);
    expect(linkedFileOpener('ws-1').canOpen('dist/app.tar.gz')).toBe(false);
    expect(linkedFileOpener('ws-1').canOpen('out/report.pdf')).toBe(false);
    expect(linkedFileOpener('ws-2').canOpen('docs/setup.md')).toBe(false);
  });
});
