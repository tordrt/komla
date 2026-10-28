import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process';
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer as createHttpServer } from 'http';
import { createServer as createNetServer, type Server } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { afterEach, describe, expect, it } from 'vitest';

import { mapProcessesToRoots } from '../../../../src/main/services/dev-preview-services/listening-ports';
import {
  buildRemoteProbeCommand,
  collectRemoteListeningPorts,
  parseRemoteProbe,
  parseRemoteSnapshot,
  parseSsListeners,
  probeRemoteHttpSchemes,
  REMOTE_SNAPSHOT_COMMAND,
} from '../../../../src/main/services/dev-preview-services/remote-listening-ports';

import { createCertificate, createHttpsServerRejectingPlainHttp } from './tls-fixtures';

const execFileAsync = promisify(execFile);

function hasCommand(command: string): boolean {
  try {
    execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('parseSsListeners', () => {
  it('reads addresses, ports, and PIDs across iproute2 output formats', () => {
    const output = [
      'State  Recv-Q Send-Q Local Address:Port  Peer Address:PortProcess',
      'LISTEN 0      511        127.0.0.1:5173      0.0.0.0:*    users:(("node",pid=1234,fd=21))',
      'LISTEN 0      4096               *:8080            *:*    users:(("python3",pid=99,fd=3),("python3",pid=100,fd=3))',
      'LISTEN 0      128            [::1]:3000         [::]:*',
      'LISTEN 0      4096   127.0.0.53%lo:53      0.0.0.0:*',
      'LISTEN     0      128         :::22                      :::*',
      '',
    ].join('\n');

    expect(parseSsListeners(output)).toEqual([
      { address: '127.0.0.1', port: 5173, pids: [1234] },
      { address: '*', port: 8080, pids: [99, 100] },
      { address: '::1', port: 3000, pids: [] },
      { address: '127.0.0.53', port: 53, pids: [] },
      { address: '::', port: 22, pids: [] },
    ]);
  });
});

describe('parseRemoteSnapshot', () => {
  it('reads tmux panes, /proc processes, and ss listeners', () => {
    const snapshot = parseRemoteSnapshot(
      [
        '@@komla-panes',
        'komla-term-1 500',
        'komla-term-2 600',
        '@@komla-processes',
        '#proc',
        '500 (bash) S 400 500 500 0 -1',
        '501 (node) S 500 500 500 0 -1',
        '@@komla-listeners',
        '#ss',
        'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
        'LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=501,fd=20))',
        'LISTEN 0 511 10.0.0.5:9000 0.0.0.0:* users:(("node",pid=501,fd=21))',
        'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
      ].join('\n')
    );

    expect(snapshot).toEqual({
      panePids: new Map([
        ['komla-term-1', [500]],
        ['komla-term-2', [600]],
      ]),
      processes: [
        { pid: 500, ppid: 400, name: 'bash' },
        { pid: 501, ppid: 500, name: 'node' },
      ],
      listeners: [{ pid: 501, address: '127.0.0.1', port: 3000 }],
      listeningPorts: new Set([3000, 22]),
      listenersListed: true,
    });
  });

  it('reads ps processes and lsof listeners on hosts without /proc or ss', () => {
    const snapshot = parseRemoteSnapshot(
      [
        '@@komla-panes',
        'komla-term-1 500',
        '@@komla-processes',
        '#ps',
        '  500   400 /bin/zsh',
        '  501   500 /opt/homebrew/bin/node',
        '@@komla-listeners',
        '#lsof',
        'p501',
        'f20',
        'n*:3000',
      ].join('\n')
    );

    expect(snapshot.processes).toEqual([
      { pid: 500, ppid: 400, name: 'zsh' },
      { pid: 501, ppid: 500, name: 'node' },
    ]);
    expect(snapshot.listeners).toEqual([{ pid: 501, address: '*', port: 3000 }]);
    // lsof shows only the caller's own processes, so other ports may be in use.
    expect(snapshot.listeningPorts).toBeNull();
    expect(snapshot.listenersListed).toBe(true);
  });

  it('reports listening ports as unknown when the host has neither ss nor lsof', () => {
    const snapshot = parseRemoteSnapshot(
      ['@@komla-panes', '@@komla-processes', '#proc', '@@komla-listeners', ''].join('\n')
    );

    expect(snapshot.listeners).toEqual([]);
    expect(snapshot.listeningPorts).toBeNull();
    expect(snapshot.listenersListed).toBe(false);
  });
});

describe('remote HTTP probe', () => {
  it('probes only valid ports', () => {
    const command = buildRemoteProbeCommand([3000, 0, 8080.5, 70000, 8080]);

    expect(command).toContain('for port in 3000 8080; do');
  });

  it('maps each port curl checked to its scheme', () => {
    expect(parseRemoteProbe('3000 http\n4443 https\n5432 none\nnoise\n')).toEqual(
      new Map([
        [3000, 'http'],
        [4443, 'https'],
        [5432, null],
      ])
    );
  });
});

const certificate = createCertificate();

describe.runIf(process.platform === 'linux' && hasCommand('ss') && hasCommand('curl'))(
  'remote commands run by a POSIX shell',
  () => {
    let shell: ChildProcess | undefined;
    let fakeBin: string | undefined;
    const servers: Server[] = [];
    const runInShell = async (command: string): Promise<string> =>
      (
        await execFileAsync('sh', ['-c', command], {
          env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` },
        })
      ).stdout;

    afterEach(() => {
      if (shell?.pid) process.kill(-shell.pid, 'SIGKILL');
      shell = undefined;
      if (fakeBin) rmSync(fakeBin, { recursive: true, force: true });
      fakeBin = undefined;
      for (const server of servers.splice(0)) server.close();
    });

    it('attributes a port to the tmux session whose pane started its process', async () => {
      // `; :` keeps sh from exec-ing node, so node runs as the pane shell's child.
      const script =
        "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port))";
      shell = spawn('sh', ['-c', '"$0" -e "$1"; :', process.execPath, script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const port = await new Promise<number>((resolve) => {
        shell!.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      });
      fakeBin = mkdtempSync(join(tmpdir(), 'komla-fake-tmux-'));
      writeFileSync(join(fakeBin, 'tmux'), `#!/bin/sh\nprintf 'komla-term-1 %s\\n' ${shell.pid}\n`);
      chmodSync(join(fakeBin, 'tmux'), 0o755);

      const snapshot = await collectRemoteListeningPorts(runInShell);
      const roots = snapshot.panePids.get('komla-term-1') ?? [];
      const owners = mapProcessesToRoots(snapshot.processes, roots);

      expect(roots).toEqual([shell.pid]);
      expect(snapshot.listeners.filter(({ pid }) => owners.has(pid))).toEqual([
        { pid: expect.any(Number), address: '127.0.0.1', port },
      ]);
      expect(snapshot.listeningPorts?.has(port)).toBe(true);
      expect(REMOTE_SNAPSHOT_COMMAND).toContain('tmux -L komla-v1 list-panes -a');
    });

    it('reads process names that contain spaces and parentheses', async () => {
      fakeBin = mkdtempSync(join(tmpdir(), 'komla-odd-name-'));
      const oddName = join(fakeBin, 'a (b) c');
      copyFileSync(execFileSync('sh', ['-c', 'command -v sleep']).toString().trim(), oddName);
      chmodSync(oddName, 0o755);
      shell = spawn(oddName, ['30'], { detached: true, stdio: 'ignore' });

      const snapshot = await collectRemoteListeningPorts(runInShell);

      expect(snapshot.processes).toContainEqual({
        pid: shell.pid,
        ppid: process.pid,
        name: 'a (b) c',
      });
    });

    it('reports listening ports as unknown when ss fails', async () => {
      fakeBin = mkdtempSync(join(tmpdir(), 'komla-fake-ss-'));
      writeFileSync(join(fakeBin, 'ss'), '#!/bin/sh\nexit 1\n');
      chmodSync(join(fakeBin, 'ss'), 0o755);

      const snapshot = await collectRemoteListeningPorts(runInShell);

      expect(snapshot.listeningPorts).toBeNull();
    });

    it('tells HTTP servers from other listeners with curl', async () => {
      fakeBin = mkdtempSync(join(tmpdir(), 'komla-probe-path-'));
      const listen = async (server: Server): Promise<number> => {
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        return (server.address() as { port: number }).port;
      };
      const httpPort = await listen(createHttpServer((_request, response) => response.end('ok')));
      const badRequestPort = await listen(
        createHttpServer((_request, response) => {
          response.statusCode = 400;
          response.end();
        })
      );
      const redisLikePort = await listen(
        createNetServer((socket) => {
          socket.on('error', () => {});
          socket.end('-ERR unknown command\r\n');
        })
      );
      const closed = createNetServer();
      const closedPort = await listen(closed);
      servers.pop();
      await new Promise<void>((resolve) => closed.close(() => resolve()));

      await expect(
        probeRemoteHttpSchemes(runInShell, [httpPort, badRequestPort, redisLikePort, closedPort])
      ).resolves.toEqual(
        new Map([
          [httpPort, 'http'],
          [badRequestPort, 'http'],
          [redisLikePort, null],
          [closedPort, null],
        ])
      );
    });

    it.runIf(certificate !== null)(
      'recognizes an HTTPS server that answers plain HTTP with a 400 with curl',
      async () => {
        const server = createHttpsServerRejectingPlainHttp(certificate!);
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as { port: number };

        await expect(probeRemoteHttpSchemes(runInShell, [port])).resolves.toEqual(
          new Map([[port, 'https']])
        );
      }
    );
  }
);
