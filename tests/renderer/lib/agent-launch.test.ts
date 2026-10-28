import { describe, it, expect } from 'vitest';

import {
  resolveDefaultLaunchTarget,
  resolveLaunchModeForPreset,
  resolveLaunchablePresets,
  isSameLaunchTarget,
  toggleLaunchTarget,
  type LaunchTarget,
} from '../../../src/renderer/lib/agent-launch';

import { createWorkspace } from '../../factories';

import type { ActivePresetEntry, AgentPreset, LaunchMode } from '../../../src/renderer/types';

const planMode: LaunchMode = { id: 'plan', name: 'Plan', command: 'claude --plan' };
const dangerousMode: LaunchMode = { id: 'dangerous', name: 'Dangerous', command: 'claude --yolo' };

function makePreset(overrides: Partial<AgentPreset> = {}): AgentPreset {
  return {
    id: 'claude',
    name: 'Claude Code',
    openCommand: 'claude',
    continueCommand: 'claude --continue',
    promptCommand: 'claude {{prompt}}',
    launchModes: [planMode, dangerousMode],
    isBuiltin: true,
    ...overrides,
  };
}

describe('resolveLaunchModeForPreset', () => {
  const preset = makePreset();

  it('returns the per-preset last-used mode when valid', () => {
    const active: ActivePresetEntry[] = [
      { presetId: 'claude', lastUsedAt: 1, lastLaunchModeId: 'plan' },
    ];
    expect(resolveLaunchModeForPreset(preset, active, 'dangerous')).toBe('plan');
  });

  it('returns null when the user explicitly chose Default, ignoring the global default', () => {
    const active: ActivePresetEntry[] = [
      { presetId: 'claude', lastUsedAt: 1, lastLaunchModeId: null },
    ];
    expect(resolveLaunchModeForPreset(preset, active, 'dangerous')).toBeNull();
  });

  it('falls back to the global default when the preset has no recorded mode', () => {
    const active: ActivePresetEntry[] = [{ presetId: 'claude', lastUsedAt: 1 }];
    expect(resolveLaunchModeForPreset(preset, active, 'dangerous')).toBe('dangerous');
  });

  it('falls back to the global default when never active', () => {
    expect(resolveLaunchModeForPreset(preset, [], 'plan')).toBe('plan');
  });

  it('ignores a stale per-preset mode that no longer exists and falls back to the global default', () => {
    const active: ActivePresetEntry[] = [
      { presetId: 'claude', lastUsedAt: 1, lastLaunchModeId: 'removed' },
    ];
    expect(resolveLaunchModeForPreset(preset, active, 'plan')).toBe('plan');
  });

  it('ignores a stale global default that does not match any of the preset modes', () => {
    const active: ActivePresetEntry[] = [{ presetId: 'claude', lastUsedAt: 1 }];
    expect(resolveLaunchModeForPreset(preset, active, 'removed')).toBeNull();
  });

  it('returns null when neither a per-preset mode nor a global default is available', () => {
    expect(resolveLaunchModeForPreset(preset, [], null)).toBeNull();
    expect(resolveLaunchModeForPreset(preset, [], undefined)).toBeNull();
  });
});

describe('resolveLaunchablePresets', () => {
  it('returns active presets in configured preset order', () => {
    const a = makePreset({ id: 'a', name: 'A' });
    const b = makePreset({ id: 'b', name: 'B' });
    const c = makePreset({ id: 'c', name: 'C' });
    const active: ActivePresetEntry[] = [
      { presetId: 'a', lastUsedAt: 100 },
      { presetId: 'b', lastUsedAt: 300 },
      { presetId: 'c', lastUsedAt: 200 },
    ];
    expect(resolveLaunchablePresets([a, b, c], active).map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not move a preset after usage changes', () => {
    const a = makePreset({ id: 'a', name: 'A' });
    const b = makePreset({ id: 'b', name: 'B' });
    const active: ActivePresetEntry[] = [
      { presetId: 'a', lastUsedAt: 100 },
      { presetId: 'b', lastUsedAt: 300 },
    ];
    const afterUsingA: ActivePresetEntry[] = [
      { presetId: 'a', lastUsedAt: 400 },
      { presetId: 'b', lastUsedAt: 300 },
    ];

    expect(resolveLaunchablePresets([a, b], active).map((p) => p.id)).toEqual(['a', 'b']);
    expect(resolveLaunchablePresets([a, b], afterUsingA).map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('excludes the Shell Only preset', () => {
    const claude = makePreset({ id: 'claude' });
    const shell = makePreset({ id: 'shell', name: 'Shell Only' });
    const active: ActivePresetEntry[] = [
      { presetId: 'shell', lastUsedAt: 200 },
      { presetId: 'claude', lastUsedAt: 100 },
    ];
    expect(resolveLaunchablePresets([claude, shell], active).map((p) => p.id)).toEqual(['claude']);
  });

  it('skips active entries pointing at deleted presets', () => {
    const claude = makePreset({ id: 'claude' });
    const active: ActivePresetEntry[] = [
      { presetId: 'ghost', lastUsedAt: 200 },
      { presetId: 'claude', lastUsedAt: 100 },
    ];
    expect(resolveLaunchablePresets([claude], active).map((p) => p.id)).toEqual(['claude']);
  });

  it('returns an empty list when nothing is active', () => {
    expect(resolveLaunchablePresets([makePreset()], [])).toEqual([]);
  });
});

describe('resolveDefaultLaunchTarget', () => {
  it('prefers the workspace preset over the most-recently-used active preset', () => {
    const claude = makePreset({ id: 'claude' });
    const codex = makePreset({ id: 'codex', name: 'Codex' });
    const workspace = createWorkspace({ presetId: 'claude' });
    const active: ActivePresetEntry[] = [
      { presetId: 'codex', lastUsedAt: 999, lastLaunchModeId: 'dangerous' },
      { presetId: 'claude', lastUsedAt: 1, lastLaunchModeId: 'plan' },
    ];
    expect(resolveDefaultLaunchTarget(workspace, [claude, codex], active, null)).toEqual({
      presetId: 'claude',
      launchModeId: 'plan',
    });
  });

  it('skips the workspace preset when it is Shell Only and falls back to MRU', () => {
    const shell = makePreset({ id: 'shell', name: 'Shell Only', launchModes: [] });
    const claude = makePreset({ id: 'claude' });
    const workspace = createWorkspace({ presetId: 'shell' });
    const active: ActivePresetEntry[] = [
      { presetId: 'claude', lastUsedAt: 5, lastLaunchModeId: 'plan' },
    ];
    expect(resolveDefaultLaunchTarget(workspace, [shell, claude], active, null)).toEqual({
      presetId: 'claude',
      launchModeId: 'plan',
    });
  });

  it('skips the workspace preset when it points at a deleted preset and falls back to MRU', () => {
    const claude = makePreset({ id: 'claude' });
    const workspace = createWorkspace({ presetId: 'ghost' });
    const active: ActivePresetEntry[] = [
      { presetId: 'claude', lastUsedAt: 5, lastLaunchModeId: 'plan' },
    ];
    expect(resolveDefaultLaunchTarget(workspace, [claude], active, null)).toEqual({
      presetId: 'claude',
      launchModeId: 'plan',
    });
  });

  it('uses the most-recently-used active preset when the workspace has no preset', () => {
    const a = makePreset({ id: 'a', name: 'A' });
    const b = makePreset({ id: 'b', name: 'B' });
    const workspace = createWorkspace();
    const active: ActivePresetEntry[] = [
      { presetId: 'a', lastUsedAt: 100 },
      { presetId: 'b', lastUsedAt: 200, lastLaunchModeId: 'plan' },
    ];
    expect(resolveDefaultLaunchTarget(workspace, [a, b], active, null)).toEqual({
      presetId: 'b',
      launchModeId: 'plan',
    });
  });

  it('skips Shell Only entries in the MRU fallback', () => {
    const shell = makePreset({ id: 'shell', name: 'Shell Only', launchModes: [] });
    const claude = makePreset({ id: 'claude' });
    const workspace = createWorkspace();
    const active: ActivePresetEntry[] = [
      { presetId: 'shell', lastUsedAt: 200 },
      { presetId: 'claude', lastUsedAt: 100, lastLaunchModeId: 'plan' },
    ];
    expect(resolveDefaultLaunchTarget(workspace, [shell, claude], active, null)).toEqual({
      presetId: 'claude',
      launchModeId: 'plan',
    });
  });

  it('returns null when no launchable preset can be resolved', () => {
    expect(resolveDefaultLaunchTarget(undefined, [], [], null)).toBeNull();
    const shell = makePreset({ id: 'shell', name: 'Shell Only', launchModes: [] });
    const workspace = createWorkspace({ presetId: 'shell' });
    expect(resolveDefaultLaunchTarget(workspace, [shell], [], null)).toBeNull();
  });

  it('honors an explicit Default pick on the workspace preset over the global default mode', () => {
    const claude = makePreset({ id: 'claude' });
    const workspace = createWorkspace({ presetId: 'claude' });
    const active: ActivePresetEntry[] = [
      { presetId: 'claude', lastUsedAt: 1, lastLaunchModeId: null },
    ];
    expect(resolveDefaultLaunchTarget(workspace, [claude], active, 'dangerous')).toEqual({
      presetId: 'claude',
      launchModeId: null,
    });
  });

  it('falls back to the global launch mode when the resolved preset has no recorded mode', () => {
    const claude = makePreset({ id: 'claude' });
    const workspace = createWorkspace({ presetId: 'claude' });
    expect(resolveDefaultLaunchTarget(workspace, [claude], [], 'plan')).toEqual({
      presetId: 'claude',
      launchModeId: 'plan',
    });
  });
});

const claudeDefaultTarget: LaunchTarget = { presetId: 'claude', launchModeId: null };
const claudePlanTarget: LaunchTarget = { presetId: 'claude', launchModeId: 'plan' };
const codexDefaultTarget: LaunchTarget = { presetId: 'codex', launchModeId: null };

describe('launch target selection', () => {
  it('distinguishes launch modes from the same preset', () => {
    expect(isSameLaunchTarget(claudeDefaultTarget, { ...claudeDefaultTarget })).toBe(true);
    expect(isSameLaunchTarget(claudeDefaultTarget, claudePlanTarget)).toBe(false);
  });

  it('adds another preset or launch mode', () => {
    expect(toggleLaunchTarget([claudeDefaultTarget], codexDefaultTarget)).toEqual([
      claudeDefaultTarget,
      codexDefaultTarget,
    ]);
    expect(toggleLaunchTarget([claudeDefaultTarget], claudePlanTarget)).toEqual([
      claudeDefaultTarget,
      claudePlanTarget,
    ]);
  });

  it('removes selected targets and allows returning to an empty selection', () => {
    expect(
      toggleLaunchTarget([claudeDefaultTarget, codexDefaultTarget], claudeDefaultTarget)
    ).toEqual([codexDefaultTarget]);
    expect(toggleLaunchTarget([claudeDefaultTarget], claudeDefaultTarget)).toEqual([]);
  });
});
