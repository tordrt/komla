import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listSshConfigHosts } from '../../../src/main/services/ssh-config-hosts';

describe('listSshConfigHosts', () => {
  let home: string;
  const write = (relative: string, content: string) => {
    const file = path.join(home, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  };

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'komla-ssh-config-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('lists concrete hosts with the values from their own block', async () => {
    write(
      '.ssh/config',
      [
        '# Work machines',
        'Host devbox',
        '  HostName dev.example.com',
        '  User devuser',
        '  Port 2222',
        '  IdentityFile ~/.ssh/id_dev',
        '  IdentityFile ~/.ssh/id_other',
        '',
        'Host gpu gpu-alt',
        '  HostName=10.0.0.5',
        '  ProxyJump bastion',
        '',
        'Host *.internal !secret *',
        '  User shared',
      ].join('\n')
    );

    expect(await listSshConfigHosts(home)).toEqual([
      {
        alias: 'devbox',
        hostname: 'dev.example.com',
        user: 'devuser',
        port: 2222,
        identityFile: '~/.ssh/id_dev',
      },
      { alias: 'gpu', hostname: '10.0.0.5', proxyJump: 'bastion' },
      { alias: 'gpu-alt', hostname: '10.0.0.5', proxyJump: 'bastion' },
    ]);
  });

  it('fills in later blocks for an alias without overriding earlier values', async () => {
    write(
      '.ssh/config',
      ['Host devbox', '  User first', 'Host devbox', '  User second', '  Port 22'].join('\n')
    );

    expect(await listSshConfigHosts(home)).toEqual([{ alias: 'devbox', user: 'first', port: 22 }]);
  });

  it('ignores the contents of Match blocks and keyword case', async () => {
    write(
      '.ssh/config',
      ['HOST devbox', '  hostname %h.example.com', 'Match host devbox', '  User matched'].join('\n')
    );

    expect(await listSshConfigHosts(home)).toEqual([
      { alias: 'devbox', hostname: 'devbox.example.com' },
    ]);
  });

  it('reads quoted values and drops trailing comments', async () => {
    write(
      '.ssh/config',
      ['Host "quoted" plain # trailing', '  IdentityFile "~/My Keys/id"'].join('\n')
    );

    expect(await listSshConfigHosts(home)).toEqual([
      { alias: 'quoted', identityFile: '~/My Keys/id' },
      { alias: 'plain', identityFile: '~/My Keys/id' },
    ]);
  });

  it('leaves out aliases Komla cannot connect to as a host', async () => {
    write('.ssh/config', 'Host "spaced alias" deploy@box box:2222 ok');

    expect((await listSshConfigHosts(home)).map((host) => host.alias)).toEqual(['ok']);
  });

  it('follows Include paths relative to ~/.ssh, absolute paths, and globs', async () => {
    write(
      '.ssh/config',
      [
        'Include config.d/*.conf',
        `Include ${path.join(home, 'elsewhere', 'extra')}`,
        'Include ~/.ssh/tilde',
        'Host main',
      ].join('\n')
    );
    write('.ssh/config.d/b.conf', 'Host second');
    write('.ssh/config.d/a.conf', 'Host first');
    write('.ssh/config.d/.hidden.conf', 'Host hidden');
    write('.ssh/config.d/notes.txt', 'Host skipped');
    write('elsewhere/extra', 'Host absolute');
    write('.ssh/tilde', 'Host tilde');

    expect((await listSshConfigHosts(home)).map((host) => host.alias)).toEqual([
      'first',
      'second',
      'absolute',
      'tilde',
      'main',
    ]);
  });

  it('goes back to the enclosing Host block after an Include', async () => {
    write('.ssh/config', ['Host a', '  Include common.conf', '  User alice'].join('\n'));
    write('.ssh/common.conf', ['Host other', '  User bob'].join('\n'));

    expect(await listSshConfigHosts(home)).toEqual([
      { alias: 'a', user: 'alice' },
      { alias: 'other', user: 'bob' },
    ]);
  });

  it('stops at an Include cycle', async () => {
    write('.ssh/config', 'Include other\nHost main');
    write('.ssh/other', 'Include config\nHost other');

    expect((await listSshConfigHosts(home)).map((host) => host.alias)).toEqual(['other', 'main']);
  });

  it('returns nothing without a config file', async () => {
    expect(await listSshConfigHosts(home)).toEqual([]);
  });
});
