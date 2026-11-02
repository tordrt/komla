import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { connectKomla, discoverKomla, komlaDataDir } from '../src/index.js';

const noFiles = async (): Promise<string> => {
  throw new Error('ENOENT');
};

describe('discoverKomla', () => {
  it("takes a managed terminal's route from its environment", async () => {
    await expect(
      discoverKomla({
        env: {
          KOMLA_API_URL: 'http://127.0.0.1:52863/terminals/terminal-1/',
          KOMLA_TERMINAL_ID: 'terminal-1',
          KOMLA_WORKSPACE_ID: 'workspace-1',
        },
        cwd: '/repo',
        readFile: noFiles,
      })
    ).resolves.toEqual({
      url: 'http://127.0.0.1:52863/terminals/terminal-1',
      terminalId: 'terminal-1',
      workspaceId: 'workspace-1',
      cwd: '/repo',
      refresh: false,
    });
  });

  it("reads the port file in Komla's data folder outside a managed terminal", async () => {
    const readFile = vi.fn(async () => '52870\n');

    await expect(
      discoverKomla({ env: { HOME: '/home/me' }, cwd: '/repo', readFile })
    ).resolves.toEqual({ url: 'http://127.0.0.1:52870', cwd: '/repo', refresh: false });
    expect(readFile).toHaveBeenCalledWith(join('/home/me', '.komla', 'port'));
  });

  it("says Komla isn't running when the port file is missing or unreadable", async () => {
    await expect(
      discoverKomla({ env: { HOME: '/home/me' }, readFile: noFiles })
    ).rejects.toMatchObject({ code: 'KOMLA_NOT_RUNNING' });
    await expect(
      discoverKomla({ env: { HOME: '/home/me' }, readFile: async () => 'nope' })
    ).rejects.toMatchObject({ code: 'KOMLA_NOT_RUNNING' });
  });

  it("prefers the managed tmux session's route, which another installation may rewrite", async () => {
    const tmuxEnvironment = vi.fn(
      async () =>
        'KOMLA_API_URL=http://127.0.0.1:61001/terminals/terminal-1\n-KOMLA_COMPANION_INBOX\nKOMLA_WORKSPACE_ID=workspace-1\n'
    );

    await expect(
      discoverKomla({
        env: {
          TMUX: '/tmp/tmux-1000/komla-v1,123,0',
          KOMLA_API_URL: 'http://127.0.0.1:60000/terminals/terminal-1',
          KOMLA_TERMINAL_ID: 'terminal-1',
        },
        cwd: '/repo',
        tmuxEnvironment,
        readFile: noFiles,
      })
    ).resolves.toEqual({
      url: 'http://127.0.0.1:61001/terminals/terminal-1',
      terminalId: 'terminal-1',
      workspaceId: 'workspace-1',
      cwd: '/repo',
      refresh: true,
    });
  });

  it("fills in from another tmux session's environment only what the process lacks", async () => {
    await expect(
      discoverKomla({
        env: { TMUX: '/tmp/tmux-1000/default,1,0', KOMLA_API_URL: 'http://127.0.0.1:1' },
        cwd: '/repo',
        tmuxEnvironment: async () =>
          'KOMLA_API_URL=http://127.0.0.1:2\nKOMLA_TERMINAL_ID=terminal-9\n',
        readFile: noFiles,
      })
    ).resolves.toMatchObject({
      url: 'http://127.0.0.1:1',
      terminalId: 'terminal-9',
      refresh: false,
    });
  });
});

describe('komlaDataDir', () => {
  it('is KOMLA_DATA_DIR when set', () => {
    expect(komlaDataDir({ KOMLA_DATA_DIR: '/data', HOME: '/home/me' })).toBe('/data');
  });

  it("is the folder the CLI was installed in, as for a staging build's", () => {
    expect(komlaDataDir({ KOMLA_CLI: '/home/me/.komla-staging/bin/komla', HOME: '/home/me' })).toBe(
      '/home/me/.komla-staging'
    );
    expect(
      komlaDataDir({ KOMLA_CLI: '/home/me/.komla/helpers/bin/komla', HOME: '/home/me' })
    ).toBe('/home/me/.komla');
  });

  it('is ~/.komla otherwise', () => {
    expect(komlaDataDir({ HOME: '/home/me' })).toBe(join('/home/me', '.komla'));
    expect(komlaDataDir({})).toBeUndefined();
  });
});

describe('connectKomla', () => {
  it("finds Komla at the first call, and again after it wasn't running", async () => {
    let port = 'missing';
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: { tags: [] } }))
    );
    const komla = connectKomla({
      env: { HOME: '/home/me' },
      cwd: '/repo',
      readFile: async () => {
        if (port === 'missing') throw new Error('ENOENT');
        return port;
      },
      fetch,
    });

    await expect(komla.tag.list()).rejects.toMatchObject({ code: 'KOMLA_NOT_RUNNING' });
    port = '52863';
    await expect(komla.tag.list()).resolves.toEqual({ tags: [] });
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:52863/api/v1/commands?cwd=%2Frepo',
      expect.objectContaining({ method: 'POST', body: '{"type":"tag.list"}' })
    );
  });

  it('finds Komla again after it stopped answering, as when it restarts on another port', async () => {
    let port = '52863';
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes(':52863/')) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ ok: true, result: { tags: [] } }));
    });
    const komla = connectKomla({
      env: { HOME: '/home/me' },
      cwd: '/repo',
      readFile: async () => port,
      fetch,
    });

    await expect(komla.tag.list()).rejects.toMatchObject({ code: 'KOMLA_UNREACHABLE' });
    port = '52864';
    await expect(komla.tag.list()).resolves.toEqual({ tags: [] });
  });

  it("sends a hook's notifications as the hook's, which set off no hooks, as the CLI does", async () => {
    const bodies: unknown[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: {} }));
    });
    const route = { url: 'http://127.0.0.1:52863' };
    const fromHook = connectKomla({ env: { KOMLA_HOOK_ID: 'ci-status' }, route, fetch });
    const fromScript = connectKomla({ env: {}, route, fetch });

    await fromHook.workspace.notify({ title: 'CI failed' });
    await fromHook.workspace.notify({ title: 'CI failed', source: 'github-prs' });
    await fromScript.workspace.notify({ title: 'CI failed' });

    expect(bodies).toEqual([
      { type: 'workspace.notify', title: 'CI failed', source: 'hook' },
      { type: 'workspace.notify', title: 'CI failed', source: 'github-prs' },
      { type: 'workspace.notify', title: 'CI failed' },
    ]);
  });
});
