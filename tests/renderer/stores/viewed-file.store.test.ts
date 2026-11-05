/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  selectViewedFile,
  useViewedFile,
  useViewedFileStore,
} from '../../../src/renderer/stores/viewed-file.store';

const viewedIn = (workspaceId: string) =>
  selectViewedFile(useViewedFileStore.getState(), workspaceId);

describe('useViewedFile', () => {
  beforeEach(() => {
    useViewedFileStore.setState({ viewed: [] });
  });

  it("offers the file a viewer shows, by its name, with the viewer's reference", () => {
    renderHook(() => useViewedFile('ws-1', 'src/app/main.ts', () => '@src/app/main.ts:3-5'));
    expect(viewedIn('ws-1')?.name).toBe('main.ts');
    expect(viewedIn('ws-1')?.getReference()).toBe('@src/app/main.ts:3-5');
  });

  it('names a folder by its last part', () => {
    renderHook(() => useViewedFile('ws-1', 'src/app/', () => '@src/app/'));
    expect(viewedIn('ws-1')?.name).toBe('app');
  });

  it('reads the latest reference, such as the lines selected now', () => {
    let lines = '1';
    const { rerender } = renderHook(() => useViewedFile('ws-1', 'a.ts', () => `@a.ts:${lines}`));
    lines = '7-9';
    rerender();
    expect(viewedIn('ws-1')?.getReference()).toBe('@a.ts:7-9');
  });

  it('offers nothing for a viewer showing no file, or for another workspace', () => {
    renderHook(() => useViewedFile('ws-1', null, () => '@x'));
    expect(viewedIn('ws-1')).toBeNull();
    renderHook(() => useViewedFile('ws-2', 'b.ts', () => '@b.ts'));
    expect(viewedIn('ws-1')).toBeNull();
    expect(viewedIn('ws-2')?.name).toBe('b.ts');
  });

  it('offers the file shown last, then the one before it once that closes', () => {
    renderHook(() => useViewedFile('ws-1', 'panel.ts', () => '@panel.ts'));
    const quickLook = renderHook(() => useViewedFile('ws-1', 'shot.png', () => '@shot.png'));
    expect(viewedIn('ws-1')?.name).toBe('shot.png');
    quickLook.unmount();
    expect(viewedIn('ws-1')?.name).toBe('panel.ts');
  });

  it('offers the file of the viewer the user turned to', () => {
    const panel = renderHook(() => useViewedFile('ws-1', 'panel.ts', () => '@panel.ts'));
    renderHook(() => useViewedFile('ws-1', 'pane.ts', () => '@pane.ts'));
    expect(viewedIn('ws-1')?.name).toBe('pane.ts');
    act(() => panel.result.current.onPointerDownCapture());
    expect(viewedIn('ws-1')?.name).toBe('panel.ts');
  });

  it('offers a file a viewer moves on to, and none once it hides', () => {
    const { rerender } = renderHook(({ path }) => useViewedFile('ws-1', path, () => `@${path}`), {
      initialProps: { path: 'a.ts' as string | null },
    });
    rerender({ path: 'b.ts' });
    expect(viewedIn('ws-1')?.name).toBe('b.ts');
    expect(useViewedFileStore.getState().viewed).toHaveLength(1);
    rerender({ path: null });
    expect(viewedIn('ws-1')).toBeNull();
  });
});
