import { describe, expect, it } from 'vitest';

import {
  hasRenderableTextDiff,
  shouldShowDiffLoadingPlaceholder,
  shouldShowMissingDiffPanel,
} from '../../../../../src/renderer/components/workspaces/file-viewer/diff-pane-state';

import type { FileDiffContent } from '../../../../../src/renderer/types';

function textDiff(overrides: Partial<FileDiffContent>): FileDiffContent {
  return {
    path: 'src/app.ts',
    oldContent: null,
    newContent: null,
    status: 'modified',
    isBinary: false,
    ...overrides,
  };
}

describe('diff pane state', () => {
  it('treats deleted-file old content as renderable', () => {
    expect(
      hasRenderableTextDiff(
        textDiff({
          oldContent: 'const removed = true;\n',
          status: 'deleted',
        })
      )
    ).toBe(true);
  });

  it('shows loading for seeded placeholder diff content', () => {
    expect(
      shouldShowDiffLoadingPlaceholder({
        fileContent: textDiff({ oldContent: null, newContent: null }),
        loadingFile: true,
      })
    ).toBe(true);
  });

  it('does not show loading once deleted-file content has loaded', () => {
    expect(
      shouldShowDiffLoadingPlaceholder({
        fileContent: textDiff({
          oldContent: 'const removed = true;\n',
          status: 'deleted',
        }),
        loadingFile: true,
      })
    ).toBe(false);
  });

  it('shows the missing-file panel for unavailable selected diff content', () => {
    expect(
      shouldShowMissingDiffPanel({
        fileContent: textDiff({ oldContent: null, newContent: null }),
        selectedFile: 'src/app.ts',
        loadingFile: false,
      })
    ).toBe(true);
  });

  it('does not show the missing-file panel while placeholder diff content is loading', () => {
    expect(
      shouldShowMissingDiffPanel({
        fileContent: textDiff({ oldContent: null, newContent: null }),
        selectedFile: 'src/app.ts',
        loadingFile: true,
      })
    ).toBe(false);
  });

  it('does not show the missing-file panel just because a loaded diff is deleted', () => {
    expect(
      shouldShowMissingDiffPanel({
        fileContent: textDiff({ oldContent: 'removed\n', newContent: null, status: 'deleted' }),
        selectedFile: 'src/app.ts',
        loadingFile: false,
      })
    ).toBe(false);
  });

  it('does not show the missing-file panel before a selected deleted diff has loaded', () => {
    expect(
      shouldShowMissingDiffPanel({
        fileContent: null,
        selectedFile: 'src/app.ts',
        loadingFile: false,
      })
    ).toBe(false);
  });
});
