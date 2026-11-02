/**
 * @vitest-environment jsdom
 */
import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BrowserSurface } from '../../../../../src/renderer/components/terminal/surfaces/BrowserSurface';
import { setDraggedPaneId } from '../../../../../src/renderer/lib/pane-drag';
import { createWorkspace } from '../../../../factories';

const preview = vi.hoisted(() => ({ isCovered: undefined as boolean | undefined }));

vi.mock('../../../../../src/renderer/components/terminal/InlineDevServerPreviewPanel', () => ({
  InlineDevServerPreviewPanel: ({ isCovered }: { isCovered?: boolean }) => {
    preview.isCovered = isCovered;
    return null;
  },
}));
vi.mock('../../../../../src/renderer/components/terminal/BrowserTabList', () => ({
  BrowserTabList: () => null,
}));

describe('BrowserSurface', () => {
  beforeEach(() => {
    preview.isCovered = undefined;
    (window as unknown as { api: unknown }).api = { onDevPreviewFocused: () => () => {} };
  });

  afterEach(() => {
    act(() => setDraggedPaneId(null));
  });

  function renderSurface() {
    render(
      <BrowserSurface
        paneId="pane-1"
        surfaceId="surface:browser:b1"
        workspace={createWorkspace({ id: 'ws-1' })}
        isTabActive
        isFocused
        header={() => null}
        closeButton={null}
        onClose={() => {}}
        onPageFocus={() => {}}
      />
    );
  }

  // The page sits over the window, where it would take the drag that's meant for the pane.
  it('hides its page while another pane is dragged', () => {
    renderSurface();
    expect(preview.isCovered).toBe(false);

    act(() => setDraggedPaneId('pane-2'));
    expect(preview.isCovered).toBe(true);

    act(() => setDraggedPaneId(null));
    expect(preview.isCovered).toBe(false);
  });

  it('keeps its page shown while its own pane is dragged', () => {
    renderSurface();
    act(() => setDraggedPaneId('pane-1'));
    expect(preview.isCovered).toBe(false);
  });
});
