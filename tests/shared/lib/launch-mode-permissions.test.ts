import { describe, expect, it } from 'vitest';

import {
  agentLaunchPolicy,
  agentsMayLaunch,
  isIsolatedEnvironment,
  skipsPermissionPrompts,
} from '../../../src/shared/lib/launch-mode-permissions';

describe('skipsPermissionPrompts', () => {
  it.each([
    '--auto',
    '--auto high',
    '--auto=high',
    '--trust-all-tools',
    '--yolo',
    '-y',
    '--model pro -y',
    '--sandbox danger-full-access',
  ])('flags %s', (args) => {
    expect(skipsPermissionPrompts({ arguments: args })).toBe(true);
  });

  it.each([
    '--auto low',
    '--auto medium',
    '--auto=medium',
    '--autosave',
    '--use-spec',
    '--sandbox workspace-write --ask-for-approval never',
    '-yes',
    '--model x-y',
    '',
  ])('does not flag %s', (args) => {
    expect(skipsPermissionPrompts({ arguments: args })).toBe(false);
  });
});

describe('agentLaunchPolicy', () => {
  it('lets agents start modes that ask before acting anywhere', () => {
    expect(agentLaunchPolicy({ arguments: '--permission-mode plan' })).toBe('always');
  });

  it('lets agents start modes that skip permission prompts only where they run isolated', () => {
    expect(agentLaunchPolicy({ arguments: '--yolo' })).toBe('isolated');
  });

  it('follows the choice the user made on the mode', () => {
    expect(agentLaunchPolicy({ arguments: '--yolo', agentLaunch: 'always' })).toBe('always');
    expect(agentLaunchPolicy({ arguments: '--permission-mode plan', agentLaunch: 'never' })).toBe(
      'never'
    );
  });

  it('reads a value it does not know, as from a hand-edited file, as no choice', () => {
    const handEdited = (agentLaunch: unknown) => ({ arguments: '--yolo', agentLaunch }) as never;
    expect(agentLaunchPolicy(handEdited('sandbox'))).toBe('isolated');
    expect(agentLaunchPolicy(handEdited(true))).toBe('isolated');
  });
});

describe('agentsMayLaunch', () => {
  it('lets agents start a mode allowed everywhere wherever it runs', () => {
    expect(agentsMayLaunch('always', false)).toBe(true);
    expect(agentsMayLaunch('always', true)).toBe(true);
  });

  it('lets agents start a mode allowed only isolated on an isolated SSH host', () => {
    expect(agentsMayLaunch('isolated', true)).toBe(true);
    expect(agentsMayLaunch('isolated', false)).toBe(false);
  });

  it('never lets agents start a mode the user keeps to themselves', () => {
    expect(agentsMayLaunch('never', true)).toBe(false);
  });
});

describe('isIsolatedEnvironment', () => {
  const places = {
    sshHosts: [{ id: 'box', isolated: true }, { id: 'laptop', isolated: false }, { id: 'server' }],
  };

  it('counts the SSH hosts the user marked isolated', () => {
    expect(isIsolatedEnvironment({ kind: 'ssh', hostId: 'box' }, places)).toBe(true);
  });

  it('does not count this computer, unmarked SSH hosts or unknown ones', () => {
    expect(isIsolatedEnvironment({ kind: 'local' }, places)).toBe(false);
    expect(isIsolatedEnvironment({ kind: 'ssh', hostId: 'laptop' }, places)).toBe(false);
    expect(isIsolatedEnvironment({ kind: 'ssh', hostId: 'server' }, places)).toBe(false);
    expect(isIsolatedEnvironment({ kind: 'ssh', hostId: 'gone' }, places)).toBe(false);
  });
});
