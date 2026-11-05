/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReactElement } from 'react';

const { rootRender } = vi.hoisted(() => ({ rootRender: vi.fn() }));

vi.mock('react-dom/client', () => ({
  default: { createRoot: () => ({ render: rootRender }) },
}));
vi.mock('../../src/renderer/App', () => ({
  default: () => {
    throw new Error('App failed to render');
  },
}));
vi.mock('../../src/renderer/lib/error-reporting', () => ({ reportError: vi.fn() }));
vi.mock('../../src/renderer/lib/monaco-loader', () => ({ ensureMonacoInitialized: vi.fn() }));
vi.mock('../../src/renderer/lib/palette-runtime', () => ({
  applyPalette: vi.fn(),
  readStoredPaletteId: vi.fn(),
}));
vi.mock('../../src/renderer/lib/renderer-diagnostics', () => ({
  startRendererDiagnostics: vi.fn(),
}));
vi.mock('../../src/renderer/styles/globals.css', () => ({}));

// jsdom has no User Timing, which the entry marks its startup with.
performance.mark ??= vi.fn();

/** A window.api whose calls answer with `answer`, or never when it's undefined. */
function stubApi(answer?: (key: string) => unknown): void {
  const api = new Proxy(
    {},
    {
      get: (_target, key: string) => () =>
        answer ? Promise.resolve(answer(key)) : new Promise(() => {}),
    }
  );
  Object.defineProperty(window, 'api', { value: api, configurable: true });
}

describe('renderer entry', () => {
  beforeEach(() => {
    vi.resetModules();
    rootRender.mockReset();
    document.body.innerHTML = '<div id="root"></div>';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the window once its config, workspaces and projects are in', async () => {
    const answers: Record<string, unknown> = {
      getConfig: { agentSetupComplete: true },
      hasProjects: true,
      getWorkspaces: [],
      getProjects: [],
    };
    stubApi((key) => answers[key]);

    await import('../../src/renderer/main');
    await vi.waitFor(() => expect(rootRender).toHaveBeenCalledOnce());

    const { useConfigStore } = await import('../../src/renderer/stores/config.store');
    const { useProjectsStore } = await import('../../src/renderer/stores/projects.store');
    const { useWorkspacesStore } = await import('../../src/renderer/stores/workspaces.store');
    expect(useConfigStore.getState().isLoading).toBe(false);
    expect(useWorkspacesStore.getState().hasLoaded).toBe(true);
    expect(useProjectsStore.getState().hasLoaded).toBe(true);
  });

  it("doesn't wait long for them, showing Loading instead", async () => {
    vi.useFakeTimers();
    stubApi();

    await import('../../src/renderer/main');
    expect(rootRender).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);

    expect(rootRender).toHaveBeenCalledOnce();
  });

  it('wraps the app in a root error boundary that offers a reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    stubApi(() => undefined);

    await import('../../src/renderer/main');
    await vi.waitFor(() => expect(rootRender).toHaveBeenCalled());

    const element = rootRender.mock.calls[0][0] as ReactElement;
    render(element);

    expect(screen.getByRole('button', { name: 'Reload window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy error details' })).toBeInTheDocument();
  });
});
