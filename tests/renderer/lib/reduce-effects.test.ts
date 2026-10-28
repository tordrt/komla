// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

const { setTerminalRendererWebglLimit } = vi.hoisted(() => ({
  setTerminalRendererWebglLimit: vi.fn(),
}));
vi.mock('../../../src/renderer/lib/terminal-renderer-runtime', () => ({
  setTerminalRendererWebglLimit,
}));

import { applyReduceEffects } from '../../../src/renderer/lib/reduce-effects';

describe('applyReduceEffects', () => {
  it('marks the document for the stylesheet and lowers the WebGL budget, then restores both', () => {
    applyReduceEffects(true);
    expect(document.documentElement.hasAttribute('data-reduce-effects')).toBe(true);
    expect(setTerminalRendererWebglLimit).toHaveBeenLastCalledWith(4);

    applyReduceEffects(false);
    expect(document.documentElement.hasAttribute('data-reduce-effects')).toBe(false);
    expect(setTerminalRendererWebglLimit).toHaveBeenLastCalledWith(undefined);
  });
});
