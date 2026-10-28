import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

import { DatabaseService } from '../../../src/main/services/database.service';
import { SshHostService } from '../../../src/main/services/ssh-host.service';
import { komlaSshRemoteDataPort } from '../../../src/shared/types';

vi.mock('electron', () => mockElectron());

describe('SshHostService', () => {
  let databaseService: DatabaseService;
  let sshHostService: SshHostService;

  beforeEach(() => {
    databaseService = new DatabaseService(':memory:');
    sshHostService = new SshHostService(databaseService);
  });

  afterEach(() => {
    databaseService.close();
  });

  it('saves, normalizes, and retrieves hosts in insertion order', () => {
    expect(
      sshHostService.save({
        id: 'build',
        name: ' Build host ',
        hostname: ' build.example.com ',
        user: ' dev ',
        port: 2222,
        identityFile: ' ~/.ssh/id_ed25519 ',
        basePath: ' ~/.komla/ ',
        forwardAgent: true,
        extraSshArgs: ['-J', 'bastion'],
        portForwards: [
          {
            id: 'postgres',
            name: ' PostgreSQL ',
            localPort: 5432,
            remotePort: 15432,
            enabled: true,
          },
        ],
      })
    ).toEqual({
      id: 'build',
      name: 'Build host',
      hostname: 'build.example.com',
      user: 'dev',
      port: 2222,
      identityFile: '~/.ssh/id_ed25519',
      basePath: '~/.komla/',
      forwardAgent: true,
      extraSshArgs: ['-J', 'bastion'],
      portForwards: [
        { id: 'postgres', name: 'PostgreSQL', localPort: 5432, remotePort: 15432, enabled: true },
      ],
    });
    sshHostService.save({
      id: 'staging',
      name: 'Staging',
      hostname: 'staging.example.com',
      basePath: '',
    });

    expect(sshHostService.list().map((host) => host.id)).toEqual(['build', 'staging']);
    expect(sshHostService.get('build')?.hostname).toBe('build.example.com');
    expect(sshHostService.has('missing')).toBe(false);
  });

  it('updates a host without changing its order', () => {
    sshHostService.save({
      id: 'first',
      name: 'First',
      hostname: 'first.example.com',
      basePath: '~/.komla',
    });
    sshHostService.save({
      id: 'second',
      name: 'Second',
      hostname: 'second.example.com',
      basePath: '~/.komla',
    });

    sshHostService.save({
      id: 'first',
      name: 'Renamed',
      hostname: 'first.example.com',
      basePath: '/srv/komla',
    });

    expect(sshHostService.list()).toEqual([
      {
        id: 'first',
        name: 'Renamed',
        hostname: 'first.example.com',
        basePath: '/srv/komla',
      },
      {
        id: 'second',
        name: 'Second',
        hostname: 'second.example.com',
        basePath: '~/.komla',
      },
    ]);
  });

  it('persists and clears whether the user marked a host isolated', () => {
    const host = { id: 'box', name: 'Box', hostname: 'box.example.com', basePath: '' };
    expect(sshHostService.save({ ...host, isolated: true })).toMatchObject({ isolated: true });
    expect(sshHostService.get('box')?.isolated).toBe(true);
    expect(sshHostService.list()[0].isolated).toBe(true);

    expect(sshHostService.save({ ...host, isolated: false })).not.toHaveProperty('isolated');
    expect(sshHostService.get('box')).not.toHaveProperty('isolated');
  });

  it('persists and clears pending first-host setup', () => {
    sshHostService.save({
      id: 'first',
      name: 'First',
      hostname: 'first.example.com',
      basePath: '~/.komla',
      setupPending: true,
    });

    expect(sshHostService.get('first')?.setupPending).toBe(true);

    sshHostService.save({
      id: 'first',
      name: 'First',
      hostname: 'first.example.com',
      basePath: '~/.komla',
      setupPending: false,
    });

    expect(sshHostService.get('first')?.setupPending).toBeUndefined();
  });

  it('persists the last checked host capabilities', () => {
    const capabilities = {
      checkedAt: '2026-08-03T12:00:00.000Z',
      git: { status: 'available' as const, version: 'git version 2.43.0' },
      tmux: { status: 'missing' as const },
      localMirror: {
        platform: 'supported' as const,
        localRsync: 'available' as const,
        remoteRsync: 'missing' as const,
      },
    };
    sshHostService.save({
      id: 'capabilities',
      name: 'Capabilities',
      hostname: 'capabilities.example.com',
      basePath: '~/.komla',
      capabilities,
    });

    expect(sshHostService.get('capabilities')?.capabilities).toEqual(capabilities);
  });

  it('deletes hosts and reports whether one existed', () => {
    sshHostService.save({
      id: 'build',
      name: 'Build',
      hostname: 'build.example.com',
      basePath: '~/.komla',
    });

    expect(sshHostService.delete('build')).toBe(true);
    expect(sshHostService.delete('build')).toBe(false);
    expect(sshHostService.list()).toEqual([]);
  });

  it('rejects invalid host records', () => {
    expect(() =>
      sshHostService.save({
        id: 'invalid',
        name: 'Invalid',
        hostname: 'user@example.com',
        basePath: '~/.komla',
      })
    ).toThrow('SSH hostname');
    expect(() =>
      sshHostService.save({
        id: ' ',
        name: 'Invalid',
        hostname: 'example.com',
        basePath: '~/.komla',
      })
    ).toThrow('SSH host id');
    expect(() =>
      sshHostService.save({
        id: 'root',
        name: 'Root',
        hostname: 'example.com',
        basePath: '/',
      })
    ).toThrow('SSH base path must not resolve');
    expect(() =>
      sshHostService.save({
        id: 'duplicate-forwards',
        name: 'Duplicate forwards',
        hostname: 'example.com',
        basePath: '~/.komla',
        portForwards: [
          { id: 'one', name: 'One', localPort: 5432, remotePort: 15432, enabled: true },
          { id: 'two', name: 'Two', localPort: 6379, remotePort: 15432, enabled: true },
        ],
      })
    ).toThrow('remote port 15432 is duplicated');
  });

  it("rejects only the host's Komla data port", () => {
    const hostId = 'reserved-forward';
    const remotePort = komlaSshRemoteDataPort(hostId);
    expect(() =>
      sshHostService.save({
        id: hostId,
        name: 'Reserved forward',
        hostname: 'example.com',
        basePath: '~/.komla',
        portForwards: [
          { id: 'postgres', name: 'PostgreSQL', localPort: 5432, remotePort, enabled: false },
        ],
      })
    ).toThrow(`remote port ${remotePort} is reserved by Komla for this host`);

    expect(
      sshHostService.save({
        id: hostId,
        name: 'Adjacent forward',
        hostname: 'example.com',
        basePath: '~/.komla',
        portForwards: [
          {
            id: 'postgres',
            name: 'PostgreSQL',
            localPort: 5432,
            remotePort: remotePort + 1,
            enabled: true,
          },
        ],
      }).portForwards?.[0].remotePort
    ).toBe(remotePort + 1);
  });

  it('persists remote services forwarded to this computer', () => {
    const saved = sshHostService.save({
      id: 'remote-service',
      name: 'Remote service',
      hostname: 'example.com',
      basePath: '~/.komla',
      portForwards: [
        {
          id: 'api',
          name: 'API',
          direction: 'remote-to-local',
          localPort: 8080,
          remotePort: 3000,
          enabled: true,
        },
      ],
    });

    expect(saved.portForwards).toEqual([
      {
        id: 'api',
        name: 'API',
        direction: 'remote-to-local',
        localPort: 8080,
        remotePort: 3000,
        enabled: true,
      },
    ]);
    expect(sshHostService.get('remote-service')?.portForwards).toEqual(saved.portForwards);
  });

  it('rejects duplicate enabled listener ports on the destination machine', () => {
    expect(() =>
      sshHostService.save({
        id: 'duplicate-local-forwards',
        name: 'Duplicate local forwards',
        hostname: 'example.com',
        basePath: '~/.komla',
        portForwards: [
          {
            id: 'one',
            name: 'One',
            direction: 'remote-to-local',
            localPort: 8080,
            remotePort: 3000,
            enabled: true,
          },
          {
            id: 'two',
            name: 'Two',
            direction: 'remote-to-local',
            localPort: 8080,
            remotePort: 4000,
            enabled: true,
          },
        ],
      })
    ).toThrow('local port 8080 is duplicated');
  });

  it('rejects duplicate enabled local listener ports across SSH hosts', () => {
    sshHostService.save({
      id: 'first',
      name: 'First',
      hostname: 'first.example.com',
      basePath: '~/.komla',
      portForwards: [
        {
          id: 'api',
          name: 'API',
          direction: 'remote-to-local',
          localPort: 8080,
          remotePort: 3000,
          enabled: true,
        },
      ],
    });

    expect(() =>
      sshHostService.save({
        id: 'second',
        name: 'Second',
        hostname: 'second.example.com',
        basePath: '~/.komla',
        portForwards: [
          {
            id: 'api',
            name: 'API',
            direction: 'remote-to-local',
            localPort: 8080,
            remotePort: 4000,
            enabled: true,
          },
        ],
      })
    ).toThrow('local port 8080 is already used by SSH host First');

    sshHostService.save({
      id: 'second',
      name: 'Second',
      hostname: 'second.example.com',
      basePath: '~/.komla',
      portForwards: [
        {
          id: 'api',
          name: 'API',
          direction: 'remote-to-local',
          localPort: 8081,
          remotePort: 4000,
          enabled: true,
        },
      ],
    });

    expect(() =>
      sshHostService.save({
        id: 'second',
        name: 'Second',
        hostname: 'second.example.com',
        basePath: '~/.komla',
        portForwards: [
          {
            id: 'api',
            name: 'API',
            direction: 'remote-to-local',
            localPort: 8080,
            remotePort: 4000,
            enabled: true,
          },
        ],
      })
    ).toThrow('local port 8080 is already used by SSH host First');
    expect(sshHostService.get('second')?.portForwards?.[0].localPort).toBe(8081);
  });
});
