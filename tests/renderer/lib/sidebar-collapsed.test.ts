/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'komla.sidebarCollapsed';

async function load() {
  vi.resetModules();
  return import('../../../src/renderer/lib/sidebar-collapsed');
}

// A stand-in for the sidebar, which registers while mounted, and a reader of the collapsed state.
function renderWithSidebar(module: Awaited<ReturnType<typeof load>>, mounted = true) {
  const sidebar = mounted ? renderHook(() => module.useSidebarMounted()) : null;
  const reader = renderHook(() => module.useSidebarCollapsed());
  return { ...reader, sidebar };
}

describe('sidebar collapsed state', () => {
  beforeEach(() => window.localStorage.clear());

  it('is kept across restarts', async () => {
    const first = await load();
    const { result } = renderWithSidebar(first);
    act(() => first.toggleSidebarCollapsed());
    expect(result.current).toBe(true);

    const reloaded = await load();
    expect(renderWithSidebar(reloaded).result.current).toBe(true);
  });

  it('only counts while a sidebar is mounted', async () => {
    window.localStorage.setItem(KEY, 'true');
    const module = await load();
    const { result } = renderWithSidebar(module, false);
    expect(result.current).toBe(false);

    const sidebar = renderHook(() => module.useSidebarMounted());
    expect(result.current).toBe(true);

    sidebar.unmount();
    expect(result.current).toBe(false);
  });

  it('leaves the choice alone when toggled without a sidebar, as on Overview', async () => {
    const module = await load();
    const { result } = renderWithSidebar(module, false);

    act(() => module.toggleSidebarCollapsed());

    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it('collapses while the window has no workspaces, without changing the choice', async () => {
    const module = await load();
    const { result } = renderWithSidebar(module);
    const window_ = renderHook(({ empty }) => module.useSidebarWindowEmpty(empty), {
      initialProps: { empty: true },
    });
    expect(result.current).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBeNull();

    window_.rerender({ empty: false });
    expect(result.current).toBe(false);
  });

  it('keeps a collapsed choice once the first workspace arrives', async () => {
    window.localStorage.setItem(KEY, 'true');
    const module = await load();
    const { result } = renderWithSidebar(module);
    const window_ = renderHook(({ empty }) => module.useSidebarWindowEmpty(empty), {
      initialProps: { empty: true },
    });

    window_.rerender({ empty: false });
    expect(result.current).toBe(true);
  });

  it('shows the sidebar when expanded without workspaces, until the window next has none', async () => {
    const module = await load();
    const { result } = renderWithSidebar(module);
    const window_ = renderHook(({ empty }) => module.useSidebarWindowEmpty(empty), {
      initialProps: { empty: true },
    });

    act(() => module.toggleSidebarCollapsed());
    expect(result.current).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBeNull();

    window_.rerender({ empty: false });
    window_.rerender({ empty: true });
    expect(result.current).toBe(true);
  });

  it('leaves the choice alone when expanded and collapsed again without workspaces', async () => {
    window.localStorage.setItem(KEY, 'true');
    const module = await load();
    const { result } = renderWithSidebar(module);
    const window_ = renderHook(({ empty }) => module.useSidebarWindowEmpty(empty), {
      initialProps: { empty: true },
    });

    act(() => module.toggleSidebarCollapsed());
    expect(result.current).toBe(false);
    act(() => module.toggleSidebarCollapsed());
    expect(result.current).toBe(true);
    act(() => module.toggleSidebarCollapsed());
    expect(window.localStorage.getItem(KEY)).toBe('true');

    window_.rerender({ empty: false });
    expect(result.current).toBe(true);
  });

  it("follows another window's choice", async () => {
    const module = await load();
    const { result } = renderWithSidebar(module);

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: 'true' }));
    });
    expect(result.current).toBe(true);

    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: 'false' }));
    });
    expect(result.current).toBe(true);
  });
});
