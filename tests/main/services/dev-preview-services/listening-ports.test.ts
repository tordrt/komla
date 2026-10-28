import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  collectListeningPorts,
  isLoopbackReachableAddress,
  mapProcessesToRoots,
  parseLsofListeners,
  parseProcNetTcp,
  parseProcStat,
  parsePsOutput,
  parseWindowsSnapshot,
  withoutPortsHeldBy,
} from '../../../../src/main/services/dev-preview-services/listening-ports';

describe('mapProcessesToRoots', () => {
  it('assigns every descendant to the root whose tree contains it', () => {
    const processes = [
      { pid: 1, ppid: 0, name: 'init' },
      { pid: 10, ppid: 1, name: 'zsh' },
      { pid: 11, ppid: 10, name: 'npm' },
      { pid: 12, ppid: 11, name: 'node' },
      { pid: 20, ppid: 1, name: 'bash' },
      { pid: 21, ppid: 20, name: 'python3' },
      { pid: 30, ppid: 1, name: 'postgres' },
    ];

    expect(mapProcessesToRoots(processes, [10, 20])).toEqual(
      new Map([
        [10, 10],
        [11, 10],
        [12, 10],
        [20, 20],
        [21, 20],
      ])
    );
  });

  it('ignores a parent link when the child started before its parent', () => {
    const processes = [
      { pid: 10, ppid: 1, name: 'pwsh', startedAt: 2_000 },
      { pid: 11, ppid: 10, name: 'node', startedAt: 3_000 },
      // Its real parent exited and Windows later gave PID 10 to the shell.
      { pid: 50, ppid: 10, name: 'Spotify', startedAt: 1_000 },
    ];

    expect([...mapProcessesToRoots(processes, [10]).keys()]).toEqual([10, 11]);
  });

  it('terminates on parent cycles left behind by PID reuse', () => {
    const processes = [
      { pid: 5, ppid: 6, name: 'a' },
      { pid: 6, ppid: 5, name: 'b' },
      { pid: 7, ppid: 7, name: 'self' },
    ];

    expect([...mapProcessesToRoots(processes, [5]).keys()].sort()).toEqual([5, 6]);
  });
});

describe('withoutPortsHeldBy', () => {
  it('drops ports a terminal inherited from the given process', () => {
    expect(
      withoutPortsHeldBy(
        [
          { pid: 1, address: '127.0.0.1', port: 41603 },
          { pid: 20, address: '127.0.0.1', port: 41603 },
          { pid: 21, address: '127.0.0.1', port: 41603 },
          { pid: 21, address: '*', port: 5173 },
        ],
        1
      )
    ).toEqual([{ pid: 21, address: '*', port: 5173 }]);
  });
});

describe('isLoopbackReachableAddress', () => {
  it('accepts wildcard and loopback bindings', () => {
    for (const address of [
      '*',
      '0.0.0.0',
      '::',
      '::1',
      '127.0.0.1',
      '127.1.2.3',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackReachableAddress(address)).toBe(true);
    }
  });

  it('rejects bindings to other interfaces', () => {
    for (const address of ['192.168.1.20', 'fe80::1', '10.0.0.5', '::ffff:10.0.0.5']) {
      expect(isLoopbackReachableAddress(address)).toBe(false);
    }
  });
});

describe('parseProcStat', () => {
  it('reads the PID, parent PID, and a command name containing spaces and parentheses', () => {
    expect(parseProcStat('4242 (next-server (v1) S 4200 4242 4200 0 -1 4194560')).toEqual({
      pid: 4242,
      ppid: 4200,
      name: 'next-server (v1',
    });
  });

  it('rejects malformed content', () => {
    expect(parseProcStat('')).toBeNull();
    expect(parseProcStat('abc (node) S x')).toBeNull();
  });
});

describe('parseProcNetTcp', () => {
  const header =
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

  it('keeps listening IPv4 sockets and decodes their addresses', () => {
    const content = [
      header,
      '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0000000000000000 100 0 0 10 0',
      '   1: 00000000:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 222 1 0000000000000000 100 0 0 10 0',
      '   2: 0100007F:1F90 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 333 1 0000000000000000 20 4 30 10 -1',
    ].join('\n');

    expect(parseProcNetTcp(content)).toEqual([
      { inode: 111, address: '127.0.0.1', port: 8080 },
      { inode: 222, address: '0.0.0.0', port: 5173 },
    ]);
  });

  it('decodes IPv6 loopback, wildcard, and IPv4-mapped addresses', () => {
    const content = [
      header,
      '   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0',
      '   1: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2 1 0 100 0 0 10 0',
      '   2: 0000000000000000FFFF00000100007F:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3 1 0 100 0 0 10 0',
      '   3: 000080FE00000000FF00000201000000:0BBA 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 4 1 0 100 0 0 10 0',
    ].join('\n');

    expect(parseProcNetTcp(content).map(({ address, port }) => ({ address, port }))).toEqual([
      { address: '::1', port: 5173 },
      { address: '::', port: 3000 },
      { address: '::ffff:127.0.0.1', port: 3001 },
      { address: 'fe80:0:0:0:200:ff:0:1', port: 3002 },
    ]);
  });
});

describe('parsePsOutput', () => {
  it('reads PIDs and the executable name from a full path', () => {
    expect(
      parsePsOutput(
        [
          '    1     0 /sbin/launchd',
          '  812     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
          ' 4242   812 /opt/homebrew/bin/node',
          '',
        ].join('\n')
      )
    ).toEqual([
      { pid: 1, ppid: 0, name: 'launchd' },
      { pid: 812, ppid: 1, name: 'Electron' },
      { pid: 4242, ppid: 812, name: 'node' },
    ]);
  });
});

describe('parseLsofListeners', () => {
  it('pairs each socket with the PID listed before it', () => {
    expect(
      parseLsofListeners(
        [
          'p4242',
          'f23',
          'n*:5173',
          'f24',
          'n[::1]:5174',
          'p5000',
          'f7',
          'n127.0.0.1:6006 (LISTEN)',
          '',
        ].join('\n')
      )
    ).toEqual([
      { pid: 4242, address: '*', port: 5173 },
      { pid: 4242, address: '::1', port: 5174 },
      { pid: 5000, address: '127.0.0.1', port: 6006 },
    ]);
  });

  it('ignores malformed socket names', () => {
    expect(parseLsofListeners(['p1', 'nno-port', 'n*:http'].join('\n'))).toEqual([]);
  });
});

describe('parseWindowsSnapshot', () => {
  it('reads processes and listeners and strips the executable extension', () => {
    expect(
      parseWindowsSnapshot(
        JSON.stringify({
          processes: [
            { pid: 100, ppid: 4, name: 'pwsh.exe', startedAt: 1_700_000_000_000 },
            { pid: 200, ppid: 100, name: 'node.exe', startedAt: null },
            { pid: 'bad', ppid: 1, name: 'x' },
          ],
          listeners: [
            { pid: 200, address: '::', port: 5173 },
            { pid: 200, address: '127.0.0.1', port: null },
          ],
        })
      )
    ).toEqual({
      processes: [
        { pid: 100, ppid: 4, name: 'pwsh', startedAt: 1_700_000_000_000 },
        { pid: 200, ppid: 100, name: 'node' },
      ],
      listeners: [{ pid: 200, address: '::', port: 5173 }],
    });
  });

  it('treats missing arrays as empty', () => {
    expect(parseWindowsSnapshot('{}')).toEqual({ processes: [], listeners: [] });
  });
});

describe.runIf(process.platform === 'linux' || process.platform === 'darwin')(
  'collectListeningPorts',
  () => {
    let shell: ChildProcess | undefined;
    let unrelated: Server | undefined;

    afterEach(() => {
      // Kill the whole group so the node grandchild does not outlive the test.
      if (shell?.pid) process.kill(-shell.pid, 'SIGKILL');
      shell = undefined;
      unrelated?.close();
      unrelated = undefined;
    });

    it('finds a port a grandchild of the root listens on and skips sockets it inherited', async () => {
      unrelated = createServer();
      await new Promise<void>((resolve) => unrelated!.listen(0, '127.0.0.1', resolve));
      const unrelatedPort = (unrelated.address() as { port: number }).port;

      // `; :` keeps sh from exec-ing node, so node runs as the shell's child.
      const script =
        "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port))";
      // Hand this process's listening socket to the shell, the way a PTY
      // inherits sockets Komla opened without close-on-exec.
      const inheritedFd = (unrelated as unknown as { _handle: { fd: number } })._handle.fd;
      shell = spawn('sh', ['-c', '"$0" -e "$1"; :', process.execPath, script], {
        detached: true,
        stdio: ['ignore', 'pipe', 'inherit', inheritedFd],
      });
      const port = await new Promise<number>((resolve) => {
        shell!.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
      });

      const snapshot = await collectListeningPorts();
      const owners = mapProcessesToRoots(snapshot.processes, [shell.pid!]);
      const attributed = snapshot.listeners.filter(({ pid }) => owners.has(pid));

      expect(attributed).toEqual([{ pid: expect.any(Number), address: '127.0.0.1', port }]);
      expect(attributed[0].pid).not.toBe(shell.pid);
      expect(snapshot.processes.find(({ pid }) => pid === attributed[0].pid)?.ppid).toBe(shell.pid);
      expect(attributed.some(({ port: listenerPort }) => listenerPort === unrelatedPort)).toBe(
        false
      );
    });
  }
);
