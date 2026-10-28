import { describe, expect, it } from 'vitest';

import {
  getNextSeenWorktreeEventAt,
  shouldOfferDiffBrowserPreview,
  shouldRefreshBrowsePreviewOnReactivate,
} from '../../../../src/renderer/components/terminal/inline-file-preview-state';

describe('InlineFilePreviewPanel helpers', () => {
  describe('getNextSeenWorktreeEventAt', () => {
    it('keeps the latest seen event timestamp', () => {
      expect(getNextSeenWorktreeEventAt(10, 15)).toBe(15);
      expect(getNextSeenWorktreeEventAt(20, 15)).toBe(20);
    });
  });

  describe('shouldRefreshBrowsePreviewOnReactivate', () => {
    it('refreshes when a hidden workspace is reactivated after a newer worktree event', () => {
      expect(
        shouldRefreshBrowsePreviewOnReactivate({
          wasActive: false,
          isActive: true,
          lastWorktreeEventAt: 20,
          lastSeenWorktreeEventAt: 10,
          isPreviewOpen: true,
          mode: 'browse',
          filePath: 'src/app.ts',
        })
      ).toBe(true);
    });

    it('does not refresh when the latest event was already seen while active', () => {
      expect(
        shouldRefreshBrowsePreviewOnReactivate({
          wasActive: false,
          isActive: true,
          lastWorktreeEventAt: 20,
          lastSeenWorktreeEventAt: 20,
          isPreviewOpen: true,
          mode: 'browse',
          filePath: 'src/app.ts',
        })
      ).toBe(false);
    });

    it('does not refresh when the preview is not in browse mode or has no file selected', () => {
      expect(
        shouldRefreshBrowsePreviewOnReactivate({
          wasActive: false,
          isActive: true,
          lastWorktreeEventAt: 20,
          lastSeenWorktreeEventAt: 10,
          isPreviewOpen: true,
          mode: 'diff',
          filePath: 'src/app.ts',
        })
      ).toBe(false);

      expect(
        shouldRefreshBrowsePreviewOnReactivate({
          wasActive: false,
          isActive: true,
          lastWorktreeEventAt: 20,
          lastSeenWorktreeEventAt: 10,
          isPreviewOpen: true,
          mode: 'browse',
          filePath: null,
        })
      ).toBe(false);
    });
  });

  describe('shouldOfferDiffBrowserPreview', () => {
    it.each(['preview.html', 'diagram.svg', 'paper.pdf'])('offers %s diff previews', (filePath) => {
      expect(
        shouldOfferDiffBrowserPreview({ mode: 'diff', filePath, fileStatus: 'modified' })
      ).toBe(true);
    });

    it('hides the preview of a deleted file', () => {
      expect(
        shouldOfferDiffBrowserPreview({
          mode: 'diff',
          filePath: 'page.html',
          fileStatus: 'deleted',
        })
      ).toBe(false);
    });
  });
});
