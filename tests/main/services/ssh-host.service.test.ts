import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { DatabaseSync } from 'node:sqlite';
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

// The schema every install's komla.db has, as the last release to use it created it.
const LEGACY_SCHEMA = `
  CREATE TABLE ssh_hosts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    user TEXT,
    port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
    identity_file TEXT,
    base_path TEXT NOT NULL,
    forward_agent INTEGER NOT NULL DEFAULT 0 CHECK (forward_agent IN (0, 1)),
    extra_ssh_args_json TEXT,
    sort_order INTEGER NOT NULL,
    setup_pending INTEGER NOT NULL DEFAULT 0 CHECK (setup_pending IN (0, 1)),
    capabilities_json TEXT,
    port_forwards_json TEXT,
    isolated INTEGER NOT NULL DEFAULT 0 CHECK (isolated IN (0, 1))
  );
  PRAGMA user_version = 1;
`;

function openLegacyDatabase(directory: string): DatabaseSync {
  const database = new DatabaseSync(join(directory, 'komla.db'));
  database.exec('PRAGMA journal_mode = WAL');
  // Before the first write, as the app did: SQLite gives the -wal and -shm files this mode too.
  chmodSync(join(directory, 'komla.db'), 0o600);
  database.exec(LEGACY_SCHEMA);
  return database;
}

function insertLegacyHost(
  database: DatabaseSync,
  id: string,
  sortOrder: number,
  columns: Record<string, string | number | null> = {}
): void {
  const row: Record<string, string | number | null> = {
    id,
    name: id,
    hostname: `${id}.example.com`,
    base_path: '~/.komla',
    sort_order: sortOrder,
    ...columns,
  };
  const names = Object.keys(row);
  database
    .prepare(
      `INSERT INTO ssh_hosts (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`
    )
    .run(...Object.values(row));
}

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
          localMirror: {
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

    posixIt('tightens a file whose mode was loosened, as opening komla.db did', () => {
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
                localMirror: {
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

    it('moves a database that appeared since it last looked, rather than ending the move', () => {
      expect(sshHostService.list()).toEqual([]);
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'from-older-build', 0);
      database.close();

      sshHostService.save(HOST);

      expect(new SshHostService(directory).list().map((host) => host.id)).toEqual([
        'from-older-build',
        HOST.id,
      ]);
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

  describe('moving hosts out of komla.db', () => {
    const hostsPath = () => join(directory, 'ssh-hosts.json');
    const legacyFiles = () => readdirSync(directory).filter((name) => name.startsWith('komla.db'));

    it('moves every field of every host, in the order they were listed', () => {
      const database = openLegacyDatabase(directory);
      // Listed by sort_order, then by insertion, not by id or insertion alone.
      insertLegacyHost(database, 'second', 1);
      insertLegacyHost(database, 'first', 0, {
        name: 'First host',
        user: 'dev',
        port: 2222,
        identity_file: '~/.ssh/id_ed25519',
        forward_agent: 1,
        isolated: 1,
        setup_pending: 1,
        extra_ssh_args_json: JSON.stringify(['-J', 'bastion']),
        port_forwards_json: JSON.stringify([
          { id: 'db', name: 'DB', localPort: 5432, remotePort: 15432, enabled: true },
        ]),
        capabilities_json: JSON.stringify({
          checkedAt: '2026-04-30T00:00:00.000Z',
          git: { status: 'available' },
          tmux: { status: 'missing' },
          localMirror: { platform: 'supported', localRsync: 'available', remoteRsync: 'missing' },
        }),
      });
      insertLegacyHost(database, 'tied-with-second', 1);
      database.close();

      const expected: SshHost[] = [
        {
          id: 'first',
          name: 'First host',
          hostname: 'first.example.com',
          user: 'dev',
          port: 2222,
          identityFile: '~/.ssh/id_ed25519',
          forwardAgent: true,
          isolated: true,
          extraSshArgs: ['-J', 'bastion'],
          portForwards: [
            { id: 'db', name: 'DB', localPort: 5432, remotePort: 15432, enabled: true },
          ],
          setupPending: true,
          capabilities: {
            checkedAt: '2026-04-30T00:00:00.000Z',
            git: { status: 'available' },
            tmux: { status: 'missing' },
            localMirror: { platform: 'supported', localRsync: 'available', remoteRsync: 'missing' },
          },
        },
        {
          id: 'second',
          name: 'second',
          hostname: 'second.example.com',
        },
        {
          id: 'tied-with-second',
          name: 'tied-with-second',
          hostname: 'tied-with-second.example.com',
        },
      ];

      expect(sshHostService.list()).toEqual(expected);
      expect(new SshHostService(directory).list()).toEqual(expected);
    });

    it('moves hosts that were only ever written to the write-ahead log', () => {
      // How installs really look: the app was closed without a checkpoint, so komla.db is
      // little more than a header and its tables and rows are all in komla.db-wal.
      const liveDirectory = join(directory, 'live');
      const crashedDirectory = join(directory, 'crashed');
      mkdirSync(liveDirectory);
      mkdirSync(crashedDirectory);
      const database = openLegacyDatabase(liveDirectory);
      insertLegacyHost(database, 'in-wal', 0);
      for (const suffix of ['', '-wal', '-shm']) {
        copyFileSync(
          join(liveDirectory, `komla.db${suffix}`),
          join(crashedDirectory, `komla.db${suffix}`)
        );
      }
      database.close();
      expect(readFileSync(join(crashedDirectory, 'komla.db')).includes('in-wal')).toBe(false);
      const walBefore = readFileSync(join(crashedDirectory, 'komla.db-wal'));
      expect(walBefore.includes('in-wal')).toBe(true);
      const databaseBefore = readFileSync(join(crashedDirectory, 'komla.db'));

      const hosts = new SshHostService(crashedDirectory).list();

      expect(hosts.map((host) => host.id)).toEqual(['in-wal']);
      // Not even a checkpoint: a move that goes wrong can still start over from these.
      expect(readFileSync(join(crashedDirectory, 'komla.db')).equals(databaseBefore)).toBe(true);
      expect(readFileSync(join(crashedDirectory, 'komla.db-wal')).equals(walBefore)).toBe(true);
    });

    it('leaves the database as it was, so a rolled-back build still has its hosts', () => {
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'kept', 0);
      database.close();
      const before = readFileSync(join(directory, 'komla.db'));

      sshHostService.list();

      expect(readFileSync(join(directory, 'komla.db')).equals(before)).toBe(true);
      const rolledBack = new DatabaseSync(join(directory, 'komla.db'));
      expect(rolledBack.prepare('SELECT id FROM ssh_hosts').all()).toEqual([{ id: 'kept' }]);
      rolledBack.close();
    });

    posixIt('keeps the moved hosts and the database readable only by the user', () => {
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'private', 0);
      database.close();
      const umask = process.umask(0);
      try {
        sshHostService.list();
      } finally {
        process.umask(umask);
      }

      expect(statSync(hostsPath()).mode & 0o777).toBe(0o600);
      for (const name of legacyFiles()) {
        expect(statSync(join(directory, name)).mode & 0o777).toBe(0o600);
      }
    });

    it('moves only once: a deleted or edited host does not come back', () => {
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'deleted', 0);
      insertLegacyHost(database, 'edited', 1);
      database.close();
      sshHostService.delete('deleted');
      sshHostService.save({
        id: 'edited',
        name: 'Edited',
        hostname: 'edited.example.com',
      });

      const reloaded = new SshHostService(directory);

      expect(reloaded.list().map((host) => host.name)).toEqual(['Edited']);
    });

    it('stays moved when the user removed every host', () => {
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'only', 0);
      database.close();
      sshHostService.delete('only');

      expect(new SshHostService(directory).list()).toEqual([]);
    });

    it('never overwrites a hosts file with what the database has', () => {
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'from-database', 0);
      database.close();
      writeFileSync(hostsPath(), JSON.stringify({ version: 1, hosts: [HOST] }));

      expect(sshHostService.list()).toEqual([HOST]);
    });

    it('records an empty database as moved, so later launches skip SQLite', () => {
      openLegacyDatabase(directory).close();

      expect(sshHostService.list()).toEqual([]);

      expect(JSON.parse(readFileSync(hostsPath(), 'utf8'))).toEqual({ version: 1, hosts: [] });
      const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule');
      expect(new SshHostService(directory).list()).toEqual([]);
      expect(getBuiltinModule).not.toHaveBeenCalledWith('node:sqlite');
    });

    it('does not load SQLite on an install that never had a database', () => {
      const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule');

      expect(sshHostService.list()).toEqual([]);
      sshHostService.save(HOST);

      expect(getBuiltinModule).not.toHaveBeenCalledWith('node:sqlite');
    });

    it('treats a database that never got its table as empty', () => {
      writeFileSync(join(directory, 'komla.db'), '');

      expect(sshHostService.list()).toEqual([]);
    });

    it('moves a host the current checks would refuse rather than losing it', () => {
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'old', 0, { hostname: 'dev@old.example.com:22', base_path: '/' });
      database.close();

      expect(sshHostService.list()).toEqual([
        { id: 'old', name: 'old', hostname: 'dev@old.example.com:22' },
      ]);
    });

    it('keeps a host whose JSON columns are damaged, as listing it did', () => {
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'damaged', 0, {
        extra_ssh_args_json: '{not json',
        port_forwards_json: '[{"id":"missing-ports"}]',
        capabilities_json: '"not an object"',
      });
      database.close();

      expect(sshHostService.list()).toEqual([
        {
          id: 'damaged',
          name: 'damaged',
          hostname: 'damaged.example.com',
        },
      ]);
    });

    it('moves a host whose capabilities are damaged deep inside', () => {
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'damaged', 0, {
        capabilities_json: JSON.stringify({
          checkedAt: '2026-04-30T00:00:00.000Z',
          git: { status: 'available' },
          tmux: { status: 'available' },
          localMirror: { platform: 'supported', localRsync: 'available', remoteRsync: 'available' },
          monitoring: null,
        }),
      });
      database.close();

      expect(sshHostService.list().map((host) => host.id)).toEqual(['damaged']);
    });

    it('moves nothing from an unreadable database, and tries again once it is readable', () => {
      writeFileSync(join(directory, 'komla.db'), 'this is not a SQLite database, not even close');

      // An empty list here would look like no hosts and, once saved, end the move for good.
      expect(() => sshHostService.list()).toThrow('komla.db');
      expect(() => sshHostService.save(HOST)).toThrow('komla.db');
      expect(existsSync(hostsPath())).toBe(false);
      expect(readFileSync(join(directory, 'komla.db'), 'utf8')).toContain('not a SQLite');

      rmSync(join(directory, 'komla.db'));
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'recovered', 0);
      database.close();

      expect(sshHostService.list().map((host) => host.id)).toEqual(['recovered']);
    });

    it('survives a crash while writing the hosts file', () => {
      const database = openLegacyDatabase(directory);
      insertLegacyHost(database, 'safe', 0);
      database.close();
      vi.mocked(writeFileAtomicSync).mockImplementationOnce(() => {
        throw new Error('power cut');
      });

      expect(() => sshHostService.list()).toThrow('power cut');
      expect(existsSync(hostsPath())).toBe(false);

      expect(new SshHostService(directory).list().map((host) => host.id)).toEqual(['safe']);
    });
  });
});
