import { describe, expect, it, vi } from 'vitest';

import {
  filePanelShows,
  openInFilePanel,
} from '../../../../src/renderer/components/terminal/file-panel';
import { useFileViewerStore } from '../../../../src/renderer/stores/file-viewer.store';

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
