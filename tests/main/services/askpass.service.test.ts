import { EventEmitter } from 'events';

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { createMockBrowserWindow, mockElectron } from '../../mocks/electron';

const electronMock = mockElectron();
(
  electronMock.BrowserWindow as unknown as { getFocusedWindow: ReturnType<typeof vi.fn> }
).getFocusedWindow = vi.fn(() => null);
vi.mock('electron', () => electronMock);

vi.mock('os', () => ({
  tmpdir: vi.fn(() => '/tmp'),
}));

const mockRandomUUID = vi.fn(() => 'fixed-id-1234');
vi.mock('crypto', () => ({
  randomUUID: mockRandomUUID,
}));

let keyFile = { mtimeMs: 1, size: 464 };
const mockFs = {
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  statSync: vi.fn(() => keyFile),
};
vi.mock('fs', () => mockFs);

let sshVersionOutput = 'OpenSSH_10.0p2 Debian-7, OpenSSL 3.5.7';
let keyPassphrase = 'secret';
const mockExecFile = vi.fn(
  (
    file: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv },
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ) => {
    if (file === 'ssh') {
      callback(null, '', sshVersionOutput);
      return;
    }
    // ssh-keygen asks for the passphrase through the askpass socket, like the real helper.
    const socket = createSocket();
    socket.write.mockImplementation((data: string) => {
      const { passphrase } = JSON.parse(data) as { passphrase: string | null };
      callback(passphrase === keyPassphrase ? null : new Error('incorrect passphrase'), '', '');
    });
    latestConnectionHandler?.(socket);
    const prompt = `Enter passphrase for "${args[2]}": `;
    const session = options.env?.KOMLA_ASKPASS_SESSION;
    socket.emit('data', Buffer.from(JSON.stringify({ id: 'keygen', prompt, session }) + '\n'));
  }
);
vi.mock('child_process', () => ({ execFile: mockExecFile }));

interface MockServer extends EventEmitter {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockSocket extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
}

let latestConnectionHandler: ((socket: MockSocket) => void) | null = null;
let latestServer: MockServer | null = null;

const mockCreateServer = vi.fn((handler: (socket: MockSocket) => void) => {
  latestConnectionHandler = handler;
  const server = new EventEmitter() as MockServer;
  server.listen = vi.fn((_: string, cb?: () => void) => cb?.());
  server.close = vi.fn();
  latestServer = server;
  return server;
});
vi.mock('net', () => ({
  createServer: mockCreateServer,
}));

function createSocket(): MockSocket {
  const socket = new EventEmitter() as MockSocket;
  socket.write = vi.fn();
  socket.end = vi.fn();
  return socket;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('AskpassService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    latestConnectionHandler = null;
    latestServer = null;
    vi.useFakeTimers();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([]);
    (
      electronMock.BrowserWindow as unknown as { getFocusedWindow: ReturnType<typeof vi.fn> }
    ).getFocusedWindow.mockReturnValue(null);
    mockFs.existsSync.mockReturnValue(false);
    keyFile = { mtimeMs: 1, size: 464 };
    sshVersionOutput = 'OpenSSH_10.0p2 Debian-7, OpenSSL 3.5.7';
    keyPassphrase = 'secret';
  });

  it('starts service and registers socket server + IPC listener', async () => {
    const { askpassService } = await import('../../../src/main/services/askpass.service');

    await askpassService.start();

    expect(askpassService.isRunning()).toBe(true);
    expect(askpassService.getSocketPath()).toBe('/tmp/komla-askpass-fixed-id-1234.sock');
    expect(askpassService.getHelperScriptPath()).toBe('/tmp/komla-askpass-fixed-id-1234.sh');
    expect(mockFs.writeFileSync).toHaveBeenCalledTimes(2); // .js helper + .sh wrapper
    expect(mockFs.chmodSync).toHaveBeenCalledWith('/tmp/komla-askpass-fixed-id-1234.sh', 0o700);
    expect(electronMock.ipcMain.on).toHaveBeenCalledWith('askpass:response', expect.any(Function));
  });

  it('ensures tmpdir exists before writing helper scripts', async () => {
    const writeOrder: string[] = [];
    mockFs.mkdirSync.mockImplementation(() => {
      writeOrder.push('mkdir');
      return undefined;
    });
    mockFs.writeFileSync.mockImplementation(() => {
      writeOrder.push('write');
    });

    const { askpassService } = await import('../../../src/main/services/askpass.service');
    await askpassService.start();

    expect(mockFs.mkdirSync).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(writeOrder[0]).toBe('mkdir');
    expect(writeOrder).toContain('write');
  });

  it('cancels request immediately when no windows are available', async () => {
    const { askpassService } = await import('../../../src/main/services/askpass.service');
    await askpassService.start();

    const socket = createSocket();
    latestConnectionHandler?.(socket);
    socket.emit('data', Buffer.from('{"id":"req-1","prompt":"Enter passphrase"}\n'));
    await settle();

    expect(socket.write).toHaveBeenCalledWith('{"passphrase":null}\n');
    expect(socket.end).toHaveBeenCalled();
  });

  it('sends prompt to focused window and returns renderer response', async () => {
    const focusedWindow = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([focusedWindow]);
    (
      electronMock.BrowserWindow as unknown as { getFocusedWindow: ReturnType<typeof vi.fn> }
    ).getFocusedWindow.mockReturnValue(focusedWindow);

    const { askpassService } = await import('../../../src/main/services/askpass.service');
    await askpassService.start();

    const socket = createSocket();
    latestConnectionHandler?.(socket);
    socket.emit('data', Buffer.from('{"id":"req-22","prompt":"SSH key passphrase"}\n'));
    await settle();

    expect(focusedWindow.webContents.send).toHaveBeenCalledWith('askpass:request', {
      id: 'req-22',
      prompt: 'SSH key passphrase',
      canRemember: false,
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
    expect(focusedWindow.focus).toHaveBeenCalled();

    const listener = vi.mocked(electronMock.ipcMain.on).mock.calls[0][1] as (
      ...args: unknown[]
    ) => void;
    listener({} as never, { id: 'req-22', passphrase: 'secret-phrase' });

    expect(socket.write).toHaveBeenLastCalledWith('{"passphrase":"secret-phrase"}\n');
    expect(socket.end).toHaveBeenCalled();
  });

  it('times out pending passphrase requests and responds with null', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    const { askpassService } = await import('../../../src/main/services/askpass.service');
    await askpassService.start();

    const socket = createSocket();
    latestConnectionHandler?.(socket);
    socket.emit('data', Buffer.from('{"id":"req-timeout","prompt":"SSH"}\n'));
    await settle();

    vi.advanceTimersByTime(2 * 60 * 1000);

    expect(socket.write).toHaveBeenLastCalledWith('{"passphrase":null}\n');
    expect(socket.end).toHaveBeenCalled();
  });

  it('stop() removes listener, closes server, resolves pending requests, and unlinks files', async () => {
    const window = createMockBrowserWindow();
    (
      electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
    ).getAllWindows.mockReturnValue([window]);

    const { askpassService } = await import('../../../src/main/services/askpass.service');
    await askpassService.start();

    const socket = createSocket();
    latestConnectionHandler?.(socket);
    socket.emit('data', Buffer.from('{"id":"req-stop","prompt":"SSH"}\n'));
    await settle();

    mockFs.existsSync.mockReturnValue(true);
    askpassService.stop();

    expect(electronMock.ipcMain.removeListener).toHaveBeenCalledWith(
      'askpass:response',
      expect.any(Function)
    );
    expect(latestServer?.close).toHaveBeenCalled();
    expect(socket.write).toHaveBeenCalledWith('{"passphrase":null}\n');
    expect(mockFs.unlinkSync).toHaveBeenCalledWith('/tmp/komla-askpass-fixed-id-1234.sock');
    expect(mockFs.unlinkSync).toHaveBeenCalledWith('/tmp/komla-askpass-fixed-id-1234.js');
    expect(mockFs.unlinkSync).toHaveBeenCalledWith('/tmp/komla-askpass-fixed-id-1234.sh');
    expect(askpassService.isRunning()).toBe(false);
  });

  describe('SSH key passphrases', () => {
    const KEY_PATH = '/home/me/.ssh/id_ed25519';
    const KEY_PROMPT = `Enter passphrase for key '${KEY_PATH}': `;

    async function startWithWindow() {
      const window = createMockBrowserWindow();
      (
        electronMock.BrowserWindow as unknown as { getAllWindows: ReturnType<typeof vi.fn> }
      ).getAllWindows.mockReturnValue([window]);
      const { askpassService } = await import('../../../src/main/services/askpass.service');
      await askpassService.start();
      const respond = vi.mocked(electronMock.ipcMain.on).mock.calls[0][1] as (
        ...args: unknown[]
      ) => void;
      const issueSession = (id: string, usesPathSsh?: () => Promise<boolean>): string => {
        mockRandomUUID.mockReturnValueOnce(id);
        return askpassService.issueSession(usesPathSsh);
      };
      return {
        askpassService,
        window,
        issueSession,
        respond: async (payload: unknown) => {
          respond({}, payload);
          await settle();
        },
      };
    }

    async function ask(request: {
      id: string;
      prompt: string;
      session?: string;
    }): Promise<MockSocket> {
      const socket = createSocket();
      latestConnectionHandler?.(socket);
      socket.emit('data', Buffer.from(JSON.stringify(request) + '\n'));
      await settle();
      return socket;
    }

    function sent(window: ReturnType<typeof createMockBrowserWindow>, channel: string) {
      return vi
        .mocked(window.webContents.send)
        .mock.calls.filter(([sentChannel]) => sentChannel === channel)
        .map(([, payload]) => payload);
    }

    function dialogs(window: ReturnType<typeof createMockBrowserWindow>) {
      return sent(window, 'askpass:request');
    }

    function keygenRuns(): number {
      return mockExecFile.mock.calls.filter(([file]) => file === 'ssh-keygen').length;
    }

    it('answers later SSH processes from memory once ssh-keygen accepts the passphrase', async () => {
      const { window, issueSession, respond } = await startWithWindow();

      const first = await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      const second = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: issueSession('ssh-2') });
      const again = await ask({ id: 'req-3', prompt: KEY_PROMPT, session: issueSession('ssh-2') });

      expect(dialogs(window)).toEqual([
        { id: 'req-1', prompt: KEY_PROMPT, canRemember: true, expiresAt: expect.any(Number) },
      ]);
      expect(mockExecFile).toHaveBeenCalledWith(
        'ssh-keygen',
        ['-y', '-f', KEY_PATH],
        expect.anything(),
        expect.any(Function)
      );
      // ssh-2 asking again could mean ssh rejected the passphrase, so it was checked again
      expect(keygenRuns()).toBe(2);
      for (const socket of [first, second, again]) {
        expect(socket.write).toHaveBeenCalledWith('{"passphrase":"secret"}\n');
      }
    });

    it('does not remember a passphrase that ssh-keygen rejects, and says so', async () => {
      const { window, issueSession, respond } = await startWithWindow();

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      await respond({ id: 'req-1', passphrase: 'typo', remember: true });
      const later = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: issueSession('ssh-2') });

      expect(later.write).not.toHaveBeenCalled();
      expect(dialogs(window)).toHaveLength(2);
      expect(sent(window, 'askpass:not-remembered')).toEqual([KEY_PATH]);
    });

    it('checks a remembered passphrase again when the key file changes', async () => {
      const { window, issueSession, respond } = await startWithWindow();

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      keyFile = { mtimeMs: 2, size: 464 };
      const touched = await ask({
        id: 'req-2',
        prompt: KEY_PROMPT,
        session: issueSession('ssh-2'),
      });
      keyFile = { mtimeMs: 3, size: 464 };
      keyPassphrase = 'changed';
      const changed = await ask({
        id: 'req-3',
        prompt: KEY_PROMPT,
        session: issueSession('ssh-3'),
      });

      expect(touched.write).toHaveBeenCalledWith('{"passphrase":"secret"}\n');
      expect(changed.write).not.toHaveBeenCalled();
      expect(dialogs(window)).toHaveLength(2);
    });

    it('forgets a remembered passphrase that stops working when ssh asks again', async () => {
      const { window, issueSession, respond } = await startWithWindow();

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      const session = issueSession('ssh-2');
      const first = await ask({ id: 'req-2', prompt: KEY_PROMPT, session });
      // The key was re-encrypted without changing its mtime or size, so ssh rejects it
      keyPassphrase = 'changed';
      const retry = await ask({ id: 'req-3', prompt: KEY_PROMPT, session });
      const later = await ask({ id: 'req-4', prompt: KEY_PROMPT, session: issueSession('ssh-3') });

      expect(first.write).toHaveBeenCalledWith('{"passphrase":"secret"}\n');
      expect(retry.write).not.toHaveBeenCalled();
      expect(later.write).not.toHaveBeenCalled();
      expect(dialogs(window)).toEqual([
        expect.objectContaining({ id: 'req-1' }),
        expect.objectContaining({ id: 'req-3' }),
      ]);
    });

    it('keeps asking when the user does not tick remember', async () => {
      const { window, issueSession, respond } = await startWithWindow();

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      await respond({ id: 'req-1', passphrase: 'secret', remember: false });
      const later = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: issueSession('ssh-2') });

      expect(later.write).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalledWith(
        'ssh-keygen',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
      expect(dialogs(window)).toHaveLength(2);
    });

    it('does not remember an empty passphrase', async () => {
      const { window, issueSession, respond } = await startWithWindow();
      keyPassphrase = '';

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      await respond({ id: 'req-1', passphrase: '', remember: true });
      const later = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: issueSession('ssh-2') });

      expect(later.write).not.toHaveBeenCalled();
      expect(dialogs(window)).toHaveLength(2);
    });

    it('shares one dialog between concurrent prompts', async () => {
      const { window, issueSession, respond } = await startWithWindow();

      const first = await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      const second = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: issueSession('ssh-2') });
      await respond({ id: 'req-1', passphrase: 'secret', remember: false });

      expect(dialogs(window)).toEqual([expect.objectContaining({ id: 'req-1' })]);
      expect(first.write).toHaveBeenCalledWith('{"passphrase":"secret"}\n');
      expect(second.write).toHaveBeenCalledWith('{"passphrase":"secret"}\n');
      expect(sent(window, 'askpass:ended')).toEqual(['req-1']);
    });

    it('keeps the deadline of a shared dialog when another prompt joins it', async () => {
      const { window, issueSession } = await startWithWindow();

      const first = await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      const expiresAt = Date.now() + 2 * 60 * 1000;
      vi.advanceTimersByTime(90 * 1000);
      const second = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: issueSession('ssh-2') });
      vi.advanceTimersByTime(30 * 1000);

      expect(dialogs(window)).toEqual([expect.objectContaining({ id: 'req-1', expiresAt })]);
      expect(first.write).toHaveBeenCalledWith('{"passphrase":null}\n');
      expect(second.write).toHaveBeenCalledWith('{"passphrase":null}\n');
      expect(sent(window, 'askpass:ended')).toEqual(['req-1']);
    });

    it('ends a request once every ssh waiting for it has gone', async () => {
      const { window, issueSession, respond } = await startWithWindow();

      const first = await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      const second = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: issueSession('ssh-2') });
      first.emit('close');
      expect(sent(window, 'askpass:ended')).toEqual([]);
      second.emit('close');

      expect(sent(window, 'askpass:ended')).toEqual(['req-1']);
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      expect(first.write).not.toHaveBeenCalled();
      expect(second.write).not.toHaveBeenCalled();
      expect(keygenRuns()).toBe(0);
    });

    it('does not remember for a process that runs another ssh', async () => {
      const { window, issueSession, respond } = await startWithWindow();
      const git = () => issueSession('git-1', () => Promise.resolve(false));

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: git() });
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      await ask({ id: 'req-2', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      await respond({ id: 'req-2', passphrase: 'secret', remember: true });
      const later = await ask({ id: 'req-3', prompt: KEY_PROMPT, session: git() });

      expect(later.write).not.toHaveBeenCalled();
      expect(
        dialogs(window).map((request) => (request as { canRemember: boolean }).canRemember)
      ).toEqual([false, true, false]);
    });

    it('shows no dialog for a prompt still being checked when the service stops', async () => {
      const { askpassService, window, issueSession } = await startWithWindow();
      let finishVersionCheck = () => undefined as void;
      mockExecFile.mockImplementationOnce((_file, _args, _options, callback) => {
        finishVersionCheck = () => callback(null, '', sshVersionOutput);
      });

      const socket = await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      askpassService.stop();
      finishVersionCheck();
      await settle();

      expect(socket.write).toHaveBeenCalledWith('{"passphrase":null}\n');
      expect(dialogs(window)).toEqual([]);
    });

    it('keeps requests Komla did not start out of memory and shared dialogs', async () => {
      const { window, issueSession, respond } = await startWithWindow();

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      const anonymous = await ask({ id: 'req-2', prompt: KEY_PROMPT });
      const forged = await ask({ id: 'req-3', prompt: KEY_PROMPT, session: 'not-issued' });
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      const anonymousLater = await ask({ id: 'req-4', prompt: KEY_PROMPT });

      expect(anonymous.write).not.toHaveBeenCalled();
      expect(forged.write).not.toHaveBeenCalled();
      expect(anonymousLater.write).not.toHaveBeenCalled();
      expect(
        dialogs(window).map((request) => (request as { canRemember: boolean }).canRemember)
      ).toEqual([true, false, false, false]);
    });

    it('accepts each verification token once', async () => {
      const { window, issueSession, respond } = await startWithWindow();

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      mockRandomUUID.mockReturnValueOnce('verify-1');
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      const replay = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: 'verify-1' });

      expect(replay.write).not.toHaveBeenCalled();
      expect(dialogs(window)).toHaveLength(2);
    });

    it('offers nothing to remember when ssh does not mark server prompts', async () => {
      sshVersionOutput = 'OpenSSH_8.2p1 Ubuntu-4ubuntu0.5, OpenSSL 1.1.1f';
      const { window, issueSession, respond } = await startWithWindow();

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      const concurrent = await ask({
        id: 'req-2',
        prompt: KEY_PROMPT,
        session: issueSession('ssh-2'),
      });
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      const later = await ask({ id: 'req-3', prompt: KEY_PROMPT, session: issueSession('ssh-3') });

      expect(concurrent.write).not.toHaveBeenCalled();
      expect(later.write).not.toHaveBeenCalled();
      expect(dialogs(window)).toEqual([
        expect.objectContaining({ canRemember: false }),
        expect.objectContaining({ canRemember: false }),
        expect.objectContaining({ canRemember: false }),
      ]);
    });

    it('never remembers or shares answers to other prompts', async () => {
      const { window, issueSession, respond } = await startWithWindow();
      const serverPrompt = `(git@example.com) ${KEY_PROMPT}`;

      await ask({ id: 'req-1', prompt: 'Password: ', session: issueSession('ssh-1') });
      await respond({ id: 'req-1', passphrase: 'host-a-password', remember: true });
      const otherHost = await ask({
        id: 'req-2',
        prompt: 'Password: ',
        session: issueSession('ssh-2'),
      });
      const concurrent = await ask({
        id: 'req-3',
        prompt: 'Password: ',
        session: issueSession('ssh-3'),
      });
      await ask({ id: 'req-4', prompt: serverPrompt, session: issueSession('ssh-4') });
      await respond({ id: 'req-4', passphrase: 'secret', remember: true });
      const spoofed = await ask({
        id: 'req-5',
        prompt: serverPrompt,
        session: issueSession('ssh-5'),
      });

      expect(otherHost.write).not.toHaveBeenCalled();
      expect(concurrent.write).not.toHaveBeenCalled();
      expect(spoofed.write).not.toHaveBeenCalled();
      expect(dialogs(window)).toHaveLength(5);
    });

    it('refuses malformed requests without showing a dialog', async () => {
      const { window } = await startWithWindow();

      const socket = await ask({ id: 'req-1', prompt: ['Enter passphrase'] as unknown as string });

      expect(socket.write).toHaveBeenCalledWith('{"passphrase":null}\n');
      expect(window.webContents.send).not.toHaveBeenCalled();
    });

    it('stops answering from memory once a session expires', async () => {
      const { window, issueSession, respond } = await startWithWindow();
      const stale = issueSession('ssh-stale');

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      vi.advanceTimersByTime(10 * 60 * 1000);
      const late = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: stale });

      expect(late.write).not.toHaveBeenCalled();
      expect(dialogs(window)).toHaveLength(2);
    });

    it('forgets remembered passphrases when stopped', async () => {
      const { askpassService, window, issueSession, respond } = await startWithWindow();

      await ask({ id: 'req-1', prompt: KEY_PROMPT, session: issueSession('ssh-1') });
      await respond({ id: 'req-1', passphrase: 'secret', remember: true });
      askpassService.stop();
      await askpassService.start();
      const later = await ask({ id: 'req-2', prompt: KEY_PROMPT, session: issueSession('ssh-2') });

      expect(later.write).not.toHaveBeenCalled();
      expect(dialogs(window)).toHaveLength(2);
    });
  });
});
