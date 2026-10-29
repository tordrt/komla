import { describe, expect, it } from 'vitest';

import {
  configUpdateArgsSchema,
  configVerifySshHostArgsSchema,
  projectUpdateArgsSchema,
  projectDeleteLeftoverBranchesArgsSchema,
  projectListLeftoverBranchesArgsSchema,
  customizationUpdateTerminalArgsSchema,
  sshDisableIntegrationArgsSchema,
  sshDeleteHostArgsSchema,
  sshEnableIntegrationArgsSchema,
  sshGetIntegrationStatusArgsSchema,
  sshSaveHostArgsSchema,
} from '../../../../src/main/ipc/validation/config-ipc.schemas';

describe('sshDeleteHostArgsSchema', () => {
  it('preserves the remote data purge option', () => {
    expect(sshDeleteHostArgsSchema.parse(['ssh-dev', { deleteRemoteData: true }])).toEqual([
      'ssh-dev',
      { deleteRemoteData: true },
    ]);
  });
});

describe('configUpdateArgsSchema', () => {
  it('snaps zoomLevel to the half steps Settings lists', () => {
    expect(configUpdateArgsSchema.parse([{ zoomLevel: 0.3 }])).toEqual([{ zoomLevel: 0.5 }]);
    expect(configUpdateArgsSchema.parse([{ zoomLevel: -1.1 }])).toEqual([{ zoomLevel: -1 }]);
    expect(configUpdateArgsSchema.parse([{ zoomLevel: 2.5 }])).toEqual([{ zoomLevel: 2.5 }]);
  });

  it('rejects a zoomLevel outside the listed range', () => {
    expect(() => configUpdateArgsSchema.parse([{ zoomLevel: 3.5 }])).toThrow();
  });

  it('preserves hideBranchNameInWorkspaceCards updates', () => {
    const [updates] = configUpdateArgsSchema.parse([{ hideBranchNameInWorkspaceCards: true }]);

    expect(updates).toEqual({ hideBranchNameInWorkspaceCards: true });
  });

  it('preserves compactWorkspaceList updates', () => {
    const [updates] = configUpdateArgsSchema.parse([{ compactWorkspaceList: true }]);

    expect(updates).toEqual({ compactWorkspaceList: true });
  });

  it('preserves sidebar grouping updates and rejects unknown groupings', () => {
    expect(configUpdateArgsSchema.parse([{ workspaceGrouping: 'none' }])).toEqual([
      { workspaceGrouping: 'none' },
    ]);
    expect(() => configUpdateArgsSchema.parse([{ workspaceGrouping: 'host' }])).toThrow();
  });

  it('preserves host visibility and drops legacy grouping updates', () => {
    const [updates] = configUpdateArgsSchema.parse([
      {
        hiddenWorkspaceHostIds: ['local', 'ssh-devbox'],
        dashboardHiddenWorkspaceHostIds: ['ssh-devbox'],
        workspaceGroupMode: 'host',
      },
    ]);

    expect(updates).toEqual({
      hiddenWorkspaceHostIds: ['local', 'ssh-devbox'],
      dashboardHiddenWorkspaceHostIds: ['ssh-devbox'],
    });
  });

  it('preserves showAgentSpinner updates', () => {
    const [enabled] = configUpdateArgsSchema.parse([{ showAgentSpinner: true }]);
    expect(enabled).toEqual({ showAgentSpinner: true });

    const [disabled] = configUpdateArgsSchema.parse([{ showAgentSpinner: false }]);
    expect(disabled).toEqual({ showAgentSpinner: false });
  });

  it('preserves reduceEffects updates and rejects non-booleans', () => {
    expect(configUpdateArgsSchema.parse([{ reduceEffects: true }])).toEqual([
      { reduceEffects: true },
    ]);
    expect(() => configUpdateArgsSchema.parse([{ reduceEffects: 'yes' }])).toThrow();
  });

  it('preserves holdToQuit updates and rejects non-booleans', () => {
    expect(configUpdateArgsSchema.parse([{ holdToQuit: true }])).toEqual([{ holdToQuit: true }]);
    expect(() => configUpdateArgsSchema.parse([{ holdToQuit: 1 }])).toThrow();
  });

  it('preserves a known spinner style and rejects any other', () => {
    const [updates] = configUpdateArgsSchema.parse([{ activitySpinner: 'braille' }]);
    expect(updates).toEqual({ activitySpinner: 'braille' });

    expect(() => configUpdateArgsSchema.parse([{ activitySpinner: 'sparkle' }])).toThrow();
  });

  it('preserves a known status bar size and rejects any other', () => {
    const [updates] = configUpdateArgsSchema.parse([{ statusBarSize: 'large' }]);
    expect(updates).toEqual({ statusBarSize: 'large' });

    expect(() => configUpdateArgsSchema.parse([{ statusBarSize: 'huge' }])).toThrow();
    expect(() => configUpdateArgsSchema.parse([{ statusBarSize: 32 }])).toThrow();
  });

  it('preserves direct remote keep-awake updates', () => {
    const [enabled] = configUpdateArgsSchema.parse([{ directRemoteKeepAwake: true }]);
    expect(enabled).toEqual({ directRemoteKeepAwake: true });

    const [disabled] = configUpdateArgsSchema.parse([{ directRemoteKeepAwake: false }]);
    expect(disabled).toEqual({ directRemoteKeepAwake: false });
  });

  it('preserves the default SSH workspace runtime mode', () => {
    const [updates] = configUpdateArgsSchema.parse([
      { defaultSshWorkspaceMode: 'local-mirror-actions' },
    ]);
    expect(updates).toEqual({ defaultSshWorkspaceMode: 'local-mirror-actions' });
  });

  it('preserves the last-used workspace environment', () => {
    const [ssh] = configUpdateArgsSchema.parse([
      { lastWorkspaceEnvironment: { kind: 'ssh', hostId: 'build-host' } },
    ]);
    expect(ssh.lastWorkspaceEnvironment).toEqual({ kind: 'ssh', hostId: 'build-host' });
  });

  it('rejects malformed last-used workspace environments', () => {
    expect(() =>
      configUpdateArgsSchema.parse([{ lastWorkspaceEnvironment: { kind: 'ssh' } }])
    ).toThrow();
    expect(() =>
      configUpdateArgsSchema.parse([{ lastWorkspaceEnvironment: { kind: 'docker' } }])
    ).toThrow();
  });

  it('preserves agent capability updates', () => {
    // Regression: without these fields declared on appConfigUpdateSchema the
    // `.strip()` clause silently drops them, so toggling a capability in the
    // UI never reached the config service and the switch state never changed.
    const [empty] = configUpdateArgsSchema.parse([{ agentDisabledCapabilities: [] }]);
    expect(empty).toEqual({ agentDisabledCapabilities: [] });

    const [some] = configUpdateArgsSchema.parse([
      {
        agentDisabledCapabilities: ['agent.launch.workspace', 'preview.open'],
      },
    ]);
    expect(some).toEqual({
      agentDisabledCapabilities: ['agent.launch.workspace', 'preview.open'],
    });
  });

  it('preserves the HTTP server kill switches', () => {
    // Same .strip() trap as the agent capabilities — these fields must round-trip
    // through IPC validation or the Settings toggles silently no-op.
    const [mcp] = configUpdateArgsSchema.parse([{ disableMcpServer: true }]);
    expect(mcp).toEqual({ disableMcpServer: true });

    const [notify] = configUpdateArgsSchema.parse([{ disableNotificationEndpoint: true }]);
    expect(notify).toEqual({ disableNotificationEndpoint: true });
  });

  it('accepts SSH hostnames and IP addresses without user or port', () => {
    for (const hostname of ['devbox.example.com', '192.168.1.50', '2001:db8::10']) {
      const [host] = sshSaveHostArgsSchema.parse([
        {
          id: 'ssh-devbox',
          name: 'Devbox',
          hostname,
          basePath: '~/.komla',
        },
      ]);
      expect(host.hostname).toBe(hostname);
    }
  });

  it('preserves SSH port forward direction', () => {
    const [host] = sshSaveHostArgsSchema.parse([
      {
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox.example.com',
        basePath: '~/.komla',
        portForwards: [
          {
            id: 'api',
            name: 'Remote API',
            direction: 'remote-to-local',
            localPort: 8080,
            remotePort: 3000,
            enabled: true,
          },
        ],
      },
    ]);

    expect(host.portForwards?.[0].direction).toBe('remote-to-local');
  });

  it('preserves remote monitoring capabilities when saving an SSH host', () => {
    const [host] = sshSaveHostArgsSchema.parse([
      {
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox.example.com',
        basePath: '~/.komla',
        capabilities: {
          checkedAt: '2026-08-06T12:00:00.000Z',
          git: { status: 'available', version: 'git version 2.43.0' },
          localMirror: {
            platform: 'supported',
            localRsync: 'available',
            remoteRsync: 'available',
          },
          tmux: { status: 'available', version: 'tmux 3.4' },
          monitoring: {
            status: 'missing',
            missingRequirements: ['readlink'],
          },
        },
      },
    ]);

    expect(host.capabilities?.monitoring).toEqual({
      status: 'missing',
      missingRequirements: ['readlink'],
    });
  });

  it('rejects SSH hostnames with user, port, URL, or path syntax', () => {
    for (const hostname of [
      'devuser@devbox.example.com',
      'devbox.example.com:2222',
      'ssh://devbox.example.com',
      'devbox.example.com/tmp',
      '[2001:db8::10]:2222',
    ]) {
      expect(() =>
        sshSaveHostArgsSchema.parse([
          {
            id: 'ssh-devbox',
            name: 'Devbox',
            hostname,
            basePath: '~/.komla',
          },
        ])
      ).toThrow();
    }
  });

  it.each(['/', '~', '.', '..', '../komla', '/tmp/..', '~/.komla/../other'])(
    'rejects unsafe SSH base path %s',
    (basePath) => {
      const host = {
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: 'devbox.example.com',
        basePath,
      };

      expect(() => sshSaveHostArgsSchema.parse([host])).toThrow();
      expect(() => configVerifySshHostArgsSchema.parse([host])).toThrow();
    }
  );

  it.each(['~/.komla', '/srv/komla', 'komla-data', './komla-data'])(
    'accepts safe SSH base path %s',
    (basePath) => {
      expect(() =>
        sshSaveHostArgsSchema.parse([
          {
            id: 'ssh-devbox',
            name: 'Devbox',
            hostname: 'devbox.example.com',
            basePath,
          },
        ])
      ).not.toThrow();
    }
  );

  it('validates SSH host verification payloads', () => {
    const [host] = configVerifySshHostArgsSchema.parse([
      {
        id: 'ssh-devbox',
        name: 'Devbox',
        hostname: '192.168.1.50',
        user: 'devuser',
        port: 2222,
        basePath: '~/.komla',
      },
    ]);

    expect(host).toMatchObject({
      id: 'ssh-devbox',
      hostname: '192.168.1.50',
      port: 2222,
    });
  });

  it('validates SSH integration payloads', () => {
    expect(sshGetIntegrationStatusArgsSchema.parse(['ssh-devbox'])).toEqual(['ssh-devbox']);
    expect(sshEnableIntegrationArgsSchema.parse(['ssh-devbox', 'codex', 'notifications'])).toEqual([
      'ssh-devbox',
      'codex',
      'notifications',
    ]);
    expect(sshDisableIntegrationArgsSchema.parse(['ssh-devbox', 'claude', 'mcp'])).toEqual([
      'ssh-devbox',
      'claude',
      'mcp',
    ]);
    expect(() =>
      sshEnableIntegrationArgsSchema.parse(['ssh-devbox', 'unknown', 'notifications'])
    ).toThrow();
  });
});

describe('projectUpdateArgsSchema SSH workspace mode', () => {
  it('preserves a project runtime override', () => {
    const [, updates] = projectUpdateArgsSchema.parse([
      'project-1',
      { sshWorkspaceMode: 'remote' },
    ]);
    expect(updates).toEqual({ sshWorkspaceMode: 'remote' });
  });
});

describe('projectUpdateArgsSchema workspace setup agents', () => {
  it('preserves an inherited agent setup step', () => {
    const [, updates] = projectUpdateArgsSchema.parse([
      'project-1',
      {
        setupSteps: [
          {
            id: 'agent-step',
            name: 'Agent',
            command: '',
            placement: 'split-right',
            agent: {},
          },
        ],
      },
    ]);

    expect(updates.setupSteps).toEqual([
      {
        id: 'agent-step',
        name: 'Agent',
        command: '',
        placement: 'split-right',
        agent: {},
      },
    ]);
  });
});

describe('projectUpdateArgsSchema workspace setup destinations', () => {
  it('accepts explicit setup destination and trigger values', () => {
    const [, updates] = projectUpdateArgsSchema.parse([
      'project-1',
      {
        setupSteps: [
          {
            id: 'setup-1',
            name: 'Install locally',
            command: 'npm install',
            placement: 'background',
            destination: 'ssh-local-copy',
            trigger: 'workspace-creation',
          },
        ],
      },
    ]);

    expect(updates.setupSteps?.[0]).toMatchObject({
      destination: 'ssh-local-copy',
      trigger: 'workspace-creation',
    });
  });

  it('rejects unknown setup destinations', () => {
    expect(() =>
      projectUpdateArgsSchema.parse([
        'project-1',
        {
          setupSteps: [
            {
              id: 'setup-1',
              name: 'Unsafe fallback',
              command: 'npm install',
              placement: 'background',
              destination: 'somewhere',
              trigger: 'every-workspace-start',
            },
          ],
        },
      ])
    ).toThrow();
  });
});

describe('customizationUpdateTerminalArgsSchema', () => {
  it('accepts a 6-digit hex background', () => {
    const [updates] = customizationUpdateTerminalArgsSchema.parse([
      { colors: { background: '#0e0f12' } },
    ]);
    expect(updates.colors?.background).toBe('#0e0f12');
  });

  it('rejects non-hex background values', () => {
    expect(() =>
      customizationUpdateTerminalArgsSchema.parse([{ colors: { background: 'not-a-color' } }])
    ).toThrow();
    expect(() =>
      customizationUpdateTerminalArgsSchema.parse([{ colors: { background: '#abc' } }])
    ).toThrow();
    expect(() =>
      customizationUpdateTerminalArgsSchema.parse([{ colors: { background: 'rgb(0,0,0)' } }])
    ).toThrow();
  });
});

describe('projectDeleteLeftoverBranchesArgsSchema', () => {
  const commit = 'a'.repeat(40);

  it('accepts branch names with slashes, dots and other allowed characters', () => {
    const branches = ['feature/x', 'devuser/fix-1.2', 'fix#123'].map((name) => ({ name, commit }));
    expect(projectDeleteLeftoverBranchesArgsSchema.parse(['project-1', branches, null])).toEqual([
      'project-1',
      branches,
      null,
    ]);
  });

  it("takes the SSH host whose clone to clean up, or null for this computer's", () => {
    expect(projectDeleteLeftoverBranchesArgsSchema.parse(['project-1', [], 'host-1'])[2]).toBe(
      'host-1'
    );
    expect(projectListLeftoverBranchesArgsSchema.parse(['project-1', null])).toEqual([
      'project-1',
      null,
    ]);
    for (const hostId of ['', 42]) {
      expect(() => projectListLeftoverBranchesArgsSchema.parse(['project-1', hostId])).toThrow();
    }
  });

  it.each(['-D', '--force', 'feat~0', 'feat^{commit}', 'feat@{0}', 'a..b', 'a b', 'x.lock', 'a/'])(
    'rejects %s, which is not a branch name',
    (name) => {
      expect(() =>
        projectDeleteLeftoverBranchesArgsSchema.parse(['project-1', [{ name, commit }], null])
      ).toThrow();
    }
  );

  it('rejects anything but a full commit hash', () => {
    for (const bad of ['abc1234', 'HEAD', 'main']) {
      expect(() =>
        projectDeleteLeftoverBranchesArgsSchema.parse([
          'project-1',
          [{ name: 'x', commit: bad }],
          null,
        ])
      ).toThrow();
    }
  });
});
