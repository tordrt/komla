/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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

describe('renderer entry', () => {
  it('wraps the app in a root error boundary that offers a reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    document.body.innerHTML = '<div id="root"></div>';

    await import('../../src/renderer/main');

    const element = rootRender.mock.calls[0][0] as ReactElement;
    render(element);

    expect(screen.getByRole('button', { name: 'Reload window' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy error details' })).toBeInTheDocument();
  });
});
