import { describe, it, expect } from 'vitest';

import {
  resolveDefaultOpenMode,
  resolveOpenTarget,
} from '@/components/workspaces/file-viewer/search-open-target';

describe('resolveDefaultOpenMode', () => {
  it("returns 'viewer' when configured = 'viewer'", () => {
    expect(resolveDefaultOpenMode('viewer', false)).toBe('viewer');
    expect(resolveDefaultOpenMode('viewer', true)).toBe('viewer');
  });

  it("returns 'preview' when configured = 'preview'", () => {
    expect(resolveDefaultOpenMode('preview', false)).toBe('preview');
    expect(resolveDefaultOpenMode('preview', true)).toBe('preview');
  });

  it("resolves 'current' to 'viewer' when the full-screen viewer is open for the workspace", () => {
    expect(resolveDefaultOpenMode('current', true)).toBe('viewer');
  });

  it("resolves 'current' to 'preview' when the full-screen viewer is not open for the workspace", () => {
    expect(resolveDefaultOpenMode('current', false)).toBe('preview');
  });
});

describe('resolveOpenTarget', () => {
  it('returns the default mode when shift is not pressed', () => {
    expect(resolveOpenTarget(false, 'viewer')).toBe('viewer');
    expect(resolveOpenTarget(false, 'preview')).toBe('preview');
  });

  it('flips to the opposite when shift is pressed', () => {
    expect(resolveOpenTarget(true, 'viewer')).toBe('preview');
    expect(resolveOpenTarget(true, 'preview')).toBe('viewer');
  });

  it("composes with resolveDefaultOpenMode for the 'current' + shift scenarios", () => {
    // viewer open + shift → preview
    expect(resolveOpenTarget(true, resolveDefaultOpenMode('current', true))).toBe('preview');
    // viewer closed + shift → viewer
    expect(resolveOpenTarget(true, resolveDefaultOpenMode('current', false))).toBe('viewer');
    // viewer open, no shift → viewer
    expect(resolveOpenTarget(false, resolveDefaultOpenMode('current', true))).toBe('viewer');
    // viewer closed, no shift → preview
    expect(resolveOpenTarget(false, resolveDefaultOpenMode('current', false))).toBe('preview');
  });
});
