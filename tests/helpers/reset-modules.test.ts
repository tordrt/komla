import { describe, expect, it } from 'vitest';
import { resetModulesKeepingShared } from './reset-modules';

// resetModulesKeepingShared() mirrors Vitest's private resetModules(). These
// tests fail if a Vitest upgrade changes what it has to reset.
describe('resetModulesKeepingShared', () => {
  it('loads a module again after a reset', async () => {
    const before = (await import('./fixtures/stateful-module')).instance;

    resetModulesKeepingShared();

    expect((await import('./fixtures/stateful-module')).instance).not.toBe(before);
  });

  it('keeps src/shared/ loaded', async () => {
    const before = (await import('../../src/shared/constants/ipc-channels')).IPC;

    resetModulesKeepingShared();

    expect((await import('../../src/shared/constants/ipc-channels')).IPC).toBe(before);
  });
});
