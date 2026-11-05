import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

import { writeFileAtomicSync } from '../../../src/main/lib/atomic-write';
import { SshHostService } from '../../../src/main/services/ssh-host.service';
import { komlaSshRemoteDataPort, type SshHost } from '../../../src/shared/types';

vi.mock('electron', () => mockElectron());
vi.mock('../../../src/main/lib/atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/lib/atomic-write')>();
  return { ...actual, writeFileAtomicSync: vi.fn(actual.writeFileAtomicSync) };
});

const posixIt = it.skipIf(process.platform === 'win32');

const HOST: SshHost = {
  id: 'build',
  name: 'Build host',
  hostname: 'build.example.com',
};

describe('SshHostService', () => {
  let directory: string;
  let sshHostService: SshHostService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'komla-ssh-hosts-'));
    sshHostService = new SshHostService(directory);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
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
        komlaFolder: '/home/dev/.komla',
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
      komlaFolder: '/home/dev/.komla',
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
    });
    sshHostService.save({
      id: 'second',
      name: 'Second',
      hostname: 'second.example.com',
    });

    sshHostService.save({
      id: 'first',
      name: 'Renamed',
      hostname: 'first.example.com',
    });

    expect(sshHostService.list()).toEqual([
      {
        id: 'first',
        name: 'Renamed',
        hostname: 'first.example.com',
      },
      {
        id: 'second',
        name: 'Second',
        hostname: 'second.example.com',
      },
    ]);
  });

  it('persists and clears whether the user marked a host isolated', () => {
    const host = { id: 'box', name: 'Box', hostname: 'box.example.com' };
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
      setupPending: true,
    });

    expect(sshHostService.get('first')?.setupPending).toBe(true);

    sshHostService.save({
      id: 'first',
      name: 'First',
      hostname: 'first.example.com',
      setupPending: false,
    });

    expect(sshHostService.get('first')?.setupPending).toBeUndefined();
  });

  it('persists the last checked host capabilities', () => {
    const capabilities = {
      checkedAt: '2026-08-03T12:00:00.000Z',
      git: { status: 'available' as const, version: 'git version 2.43.0' },
      tmux: { status: 'missing' as const },
      localCopy: {
        platform: 'supported' as const,
        localRsync: 'available' as const,
        remoteRsync: 'missing' as const,
      },
    };
    sshHostService.save({
      id: 'capabilities',
      name: 'Capabilities',
      hostname: 'capabilities.example.com',
      capabilities,
    });

    expect(sshHostService.get('capabilities')?.capabilities).toEqual(capabilities);
  });

  it('deletes hosts and reports whether one existed', () => {
    sshHostService.save({
      id: 'build',
      name: 'Build',
      hostname: 'build.example.com',
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
      })
    ).toThrow('SSH hostname');
    expect(() =>
      sshHostService.save({
        id: ' ',
        name: 'Invalid',
        hostname: 'example.com',
      })
    ).toThrow('SSH host id');
    expect(() =>
      sshHostService.save({
        id: 'duplicate-forwards',
        name: 'Duplicate forwards',
        hostname: 'example.com',
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
  describe('the hosts file', () => {
    const hostsPath = () => join(directory, 'ssh-hosts.json');

    it('keeps every field and the order for the next launch', () => {
      const full: SshHost = {
        id: 'full',
        name: 'Full',
        hostname: 'full.example.com',
        user: 'dev',
        port: 2222,
        identityFile: '~/.ssh/id_ed25519',
        komlaFolder: '/home/dev/.komla',
        forwardAgent: true,
        isolated: true,
        extraSshArgs: ['-J', 'bastion'],
        portForwards: [
          { id: 'db', name: 'DB', localPort: 5432, remotePort: 15432, enabled: true },
          {
            id: 'web',
            name: 'Web',
            direction: 'remote-to-local',
            localPort: 3000,
            remotePort: 3000,
            enabled: false,
          },
        ],
        setupPending: true,
        capabilities: {
          checkedAt: '2026-04-30T00:00:00.000Z',
          git: { status: 'available' },
          tmux: { status: 'available' },
          localCopy: {
            platform: 'supported',
            localRsync: 'available',
            remoteRsync: 'available',
          },
        },
      };
      sshHostService.save(HOST);
      sshHostService.save(full);
      sshHostService.save({ ...HOST, name: 'Renamed' });

      const reloaded = new SshHostService(directory);

      expect(reloaded.list()).toEqual([{ ...HOST, name: 'Renamed' }, full]);
    });

    it('forgets a deleted host on the next launch', () => {
      sshHostService.save(HOST);
      expect(sshHostService.delete(HOST.id)).toBe(true);

      expect(new SshHostService(directory).list()).toEqual([]);
    });

    it('does not touch the disk when deleting a host that is not there', () => {
      vi.mocked(writeFileAtomicSync).mockClear();

      expect(sshHostService.delete('missing')).toBe(false);

      expect(writeFileAtomicSync).not.toHaveBeenCalled();
    });

    it('writes atomically, readable only by the user', () => {
      vi.mocked(writeFileAtomicSync).mockClear();

      sshHostService.save(HOST);

      expect(writeFileAtomicSync).toHaveBeenCalledWith(hostsPath(), expect.any(String), 0o600);
      expect(readdirSync(directory)).toEqual(['ssh-hosts.json']);
    });

    posixIt('creates the file with mode 0600 whatever the umask allows', () => {
      const umask = process.umask(0);
      try {
        sshHostService.save(HOST);
      } finally {
        process.umask(umask);
      }

      expect(statSync(hostsPath()).mode & 0o777).toBe(0o600);
    });

    posixIt('tightens a file whose mode was loosened', () => {
      sshHostService.save(HOST);
      chmodSync(hostsPath(), 0o644);

      new SshHostService(directory).list();

      expect(statSync(hostsPath()).mode & 0o777).toBe(0o600);
    });

    it('keeps the saved hosts when a write fails', () => {
      sshHostService.save(HOST);
      const before = readFileSync(hostsPath(), 'utf8');
      vi.mocked(writeFileAtomicSync).mockImplementationOnce(() => {
        throw new Error('disk full');
      });

      expect(() => sshHostService.save({ ...HOST, id: 'second' })).toThrow('disk full');

      expect(sshHostService.list()).toEqual([HOST]);
      expect(readFileSync(hostsPath(), 'utf8')).toBe(before);
    });

    it('hands out copies, so a caller cannot change what is stored', () => {
      const saved = sshHostService.save({ ...HOST, extraSshArgs: ['-v'] });
      saved.extraSshArgs?.push('saved');
      sshHostService.list()[0].name = 'Listed';
      const fetched = sshHostService.get(HOST.id);
      if (fetched) fetched.name = 'Fetched';

      expect(sshHostService.get(HOST.id)).toEqual({ ...HOST, extraSshArgs: ['-v'] });
    });

    it.each([
      ['is not JSON', '{ "version": 1, "hosts": ['],
      ['is from a newer version', JSON.stringify({ version: 2, hosts: [] })],
      ['has no hosts', JSON.stringify({ version: 1 })],
      ['has a host without an id', JSON.stringify({ version: 1, hosts: [{ name: 'No id' }] })],
      ['has two hosts with one id', JSON.stringify({ version: 1, hosts: [HOST, HOST] })],
    ])('refuses a file that %s rather than overwriting it', (_, contents) => {
      writeFileSync(hostsPath(), contents);

      expect(() => sshHostService.list()).toThrow('ssh-hosts.json');
      expect(() => sshHostService.save(HOST)).toThrow('ssh-hosts.json');
      expect(() => sshHostService.delete(HOST.id)).toThrow('ssh-hosts.json');

      expect(readFileSync(hostsPath(), 'utf8')).toBe(contents);
    });

    it('drops capabilities that are damaged deep inside, keeping the other hosts', () => {
      writeFileSync(
        hostsPath(),
        JSON.stringify({
          version: 1,
          hosts: [
            {
              ...HOST,
              capabilities: {
                checkedAt: '2026-04-30T00:00:00.000Z',
                git: { status: 'available' },
                tmux: { status: 'available' },
                localCopy: {
                  platform: 'supported',
                  localRsync: 'available',
                  remoteRsync: 'available',
                },
                monitoring: null,
              },
            },
            { ...HOST, id: 'second' },
          ],
        })
      );

      expect(sshHostService.list()).toEqual([HOST, { ...HOST, id: 'second' }]);
    });

    it('does not overwrite what another instance saved, as dev builds share a directory', () => {
      const other = new SshHostService(directory);
      other.list();
      sshHostService.save(HOST);

      other.save({ ...HOST, id: 'second' });

      expect(new SshHostService(directory).list().map((host) => host.id)).toEqual([
        HOST.id,
        'second',
      ]);
    });

    it('does not bring back what another instance deleted', () => {
      sshHostService.save(HOST);
      sshHostService.save({ ...HOST, id: 'second' });
      const other = new SshHostService(directory);
      other.list();
      sshHostService.delete('second');

      other.save({ ...HOST, name: 'Renamed' });

      expect(new SshHostService(directory).list().map((host) => host.id)).toEqual([HOST.id]);
    });

    it('keeps listing hosts when the file goes bad while running, but refuses to write', () => {
      sshHostService.save(HOST);
      const damaged = '{ "version": 1, "hosts": [';
      writeFileSync(hostsPath(), damaged);

      expect(sshHostService.list()).toEqual([HOST]);
      expect(sshHostService.has(HOST.id)).toBe(true);
      expect(() => sshHostService.save({ ...HOST, id: 'second' })).toThrow('ssh-hosts.json');
      expect(() => sshHostService.delete(HOST.id)).toThrow('ssh-hosts.json');
      expect(readFileSync(hostsPath(), 'utf8')).toBe(damaged);
    });

    it('keeps listing hosts when a write fails after the file went missing', () => {
      sshHostService.save(HOST);
      rmSync(hostsPath());
      vi.mocked(writeFileAtomicSync).mockImplementationOnce(() => {
        throw new Error('disk full');
      });

      expect(() => sshHostService.save({ ...HOST, id: 'second' })).toThrow('disk full');

      expect(sshHostService.list()).toEqual([HOST]);
    });

    it('keeps listing hosts after a delete that found nothing to delete', () => {
      sshHostService.save(HOST);
      rmSync(hostsPath());

      expect(sshHostService.delete('missing')).toBe(false);

      expect(sshHostService.list()).toEqual([HOST]);
    });

    it('keeps listing hosts after a save refused for a port conflict', () => {
      sshHostService.save(HOST);
      rmSync(hostsPath());
      const forward = {
        id: 'web',
        name: 'Web',
        direction: 'remote-to-local' as const,
        localPort: 3000,
        remotePort: 3000,
        enabled: true,
      };
      writeFileSync(
        hostsPath(),
        JSON.stringify({ version: 1, hosts: [{ ...HOST, id: 'other', portForwards: [forward] }] })
      );

      expect(() => sshHostService.save({ ...HOST, portForwards: [forward] })).toThrow('3000');

      expect(sshHostService.list()).toEqual([HOST]);
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
      'treats a data directory it may not enter as an error, not as having no hosts',
      () => {
        chmodSync(directory, 0o000);
        try {
          expect(() => sshHostService.list()).toThrow('EACCES');
        } finally {
          chmodSync(directory, 0o700);
        }
      }
    );

    it('reads the file once, however often hosts are read', () => {
      sshHostService.save(HOST);
      const reloaded = new SshHostService(directory);
      reloaded.list();
      rmSync(hostsPath());

      expect(reloaded.list()).toEqual([HOST]);
    });

    it('starts over when the data directory is reset, not bringing the hosts back', () => {
      sshHostService.save(HOST);
      rmSync(directory, { recursive: true, force: true });

      sshHostService.save({ ...HOST, id: 'saved-after-reset' });

      expect(new SshHostService(directory).list().map((host) => host.id)).toEqual([
        'saved-after-reset',
      ]);
    });

    it('drops a damaged optional field but keeps the host', () => {
      writeFileSync(
        hostsPath(),
        JSON.stringify({
          version: 1,
          hosts: [
            {
              ...HOST,
              user: 7,
              port: 70000,
              extraSshArgs: 'not-a-list',
              portForwards: [{ id: 'no-ports' }],
              capabilities: null,
            },
          ],
        })
      );

      expect(sshHostService.list()).toEqual([HOST]);
    });
  });

  it.each(['~/.komla', 'data/komla', '', '/', 7])(
    'drops a saved Komla folder %j that is not an absolute folder',
    (komlaFolder) => {
      writeFileSync(
        join(directory, 'ssh-hosts.json'),
        JSON.stringify({ version: 1, hosts: [{ ...HOST, komlaFolder }] })
      );

      expect(sshHostService.list()).toEqual([HOST]);
      expect(
        sshHostService.save({ ...HOST, komlaFolder: komlaFolder as string })
      ).not.toHaveProperty('komlaFolder');
    }
  );
});
