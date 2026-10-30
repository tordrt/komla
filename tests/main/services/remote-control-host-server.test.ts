// Runs the TypeScript phone protocol against the Rust phone server in the Remote Companion
// (`komla __phone-serve`), with a real tmux session, so the two implementations cannot
// drift apart. ADR 0005.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'child_process';
import { generateKeyPairSync, type KeyObject } from 'crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

import {
  Peer,
  buildDeviceProof,
  decodeBinaryAppFrame,
  deviceIdFromPublicKey,
  encodeBinaryTerminalInput,
  encodeBase64,
  exportDevicePublicKey,
  generateDeviceKeyPair,
  parseRemoteAppFrame,
  signDeviceProof,
  type DecodedMessage,
} from '@komla/remote-protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { fakeAuthenticate } from '../../helpers/fake-authenticator';

const COMPANION = resolve(__dirname, '../../../native');
const BINARY = join(COMPANION, 'target/debug/komla');
const ORIGIN = 'https://mac.tail1.ts.net';
const RP_ID = 'mac.tail1.ts.net';
const CREDENTIAL_ID = new TextEncoder().encode('phone-passkey');
const hasTmux = spawnSync('tmux', ['-V']).status === 0;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => done(typeof address === 'object' && address ? address.port : 0));
    });
  });
}

interface PhoneDevice {
  deviceId: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
  passkey: KeyObject;
  passkeySpki: Buffer;
}

async function makePhone(): Promise<PhoneDevice> {
  const pair = await generateDeviceKeyPair();
  const publicKey = await exportDevicePublicKey(pair.publicKey);
  const passkey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    deviceId: await deviceIdFromPublicKey(publicKey),
    publicKey,
    privateKey: pair.privateKey,
    passkey: passkey.privateKey,
    passkeySpki: passkey.publicKey.export({ type: 'spki', format: 'der' }),
  };
}

function trustFile(phones: PhoneDevice[], expiresAt = Date.now() + 60_000): string {
  return JSON.stringify({
    version: 1,
    expiresAt,
    devices: phones.map((phone) => ({
      deviceId: phone.deviceId,
      devicePublicKey: encodeBase64(phone.publicKey),
      credentialId: base64url(CREDENTIAL_ID),
      credentialPublicKey: phone.passkeySpki.toString('base64'),
      label: 'iPhone',
      rpId: RP_ID,
      origin: ORIGIN,
    })),
  });
}

/** One phone connection: the encrypted Peer over a WebSocket, with a frame inbox. */
class PhoneConnection {
  readonly frames: Array<Record<string, unknown>> = [];
  closed: { code: number; reason: string } | null = null;
  binaryReceived = 0;
  private readonly socket: WebSocket;
  private readonly peer: Peer;
  private waiters: Array<() => void> = [];

  constructor(url: string, fingerprint: string, origin = ORIGIN) {
    this.socket = new WebSocket(url, { origin });
    this.peer = new Peer({
      role: 'client',
      expectedFingerprint: fingerprint,
      transport: {
        send: (data) => this.socket.send(data),
        sendBinary: (data) => this.socket.send(data),
        close: (code, reason) => this.socket.close(code, reason),
      },
    });
    this.peer.onMessage((message: DecodedMessage) => {
      if (message.kind === 'json') this.frames.push(message.data as Record<string, unknown>);
      else {
        const frame = decodeBinaryAppFrame(message.data);
        if (frame) this.frames.push({ ...frame, binary: true });
      }
      this.notify();
    });
    this.socket.on('message', (data, isBinary) => {
      if (!isBinary) {
        this.peer.handleMessage(String(data));
        return;
      }
      this.binaryReceived += 1;
      this.peer.handleBinaryMessage(new Uint8Array(data as Buffer));
    });
    this.socket.on('close', (code, reason) => {
      this.closed = { code, reason: String(reason) };
      this.peer.handleClose({ code, reason: String(reason) });
      this.notify();
    });
  }

  private notify(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  async open(): Promise<void> {
    await new Promise<void>((done, fail) => {
      this.socket.once('open', () => done());
      this.socket.once('unexpected-response', (_request, response) =>
        fail(new Error(`upgrade refused: ${response.statusCode}`))
      );
      this.socket.once('error', fail);
    });
    await this.peer.connect();
  }

  send(frame: Record<string, unknown>): Promise<void> {
    return this.peer.sendEncryptedJson(frame);
  }

  enableBinaryFrames(): void {
    this.peer.enableBinaryFrames();
  }

  sendBinary(bytes: Uint8Array): Promise<void> {
    return this.peer.sendEncryptedBinary(bytes);
  }

  binding(): Uint8Array {
    return this.peer.getChannelBinding();
  }

  async next(
    match: (frame: Record<string, unknown>) => boolean,
    timeoutMs = 10_000
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex(match);
      if (index >= 0) return this.frames.splice(index, 1)[0]!;
      if (this.closed) throw new Error(`closed ${this.closed.code} ${this.closed.reason}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('timed out waiting for a frame');
      await new Promise<void>((done) => {
        const timer = setTimeout(done, remaining);
        this.waiters.push(() => {
          clearTimeout(timer);
          done();
        });
      });
    }
  }

  async waitClosed(timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      if (Date.now() > deadline) throw new Error('socket did not close');
      await new Promise((done) => setTimeout(done, 50));
    }
    return this.closed;
  }

  close(): void {
    this.socket.close();
  }
}

describe.skipIf(process.platform === 'win32' || !hasTmux)('phone server on an SSH host', () => {
  let root: string;
  let stateDir: string;
  let tmuxSocket: string;
  let server: ChildProcess;
  let url: string;
  let fingerprint: string;
  let phone: PhoneDevice;
  let signCount = 0;
  let launchFile: string;

  /** The next frame of `type`, checked against the protocol's strict schema. */
  async function reply(
    connection: PhoneConnection,
    requestId: string,
    timeoutMs?: number
  ): Promise<Record<string, unknown>> {
    const frame = await connection.next(
      (candidate) =>
        candidate.requestId === requestId &&
        candidate.type !== 'app:workspaces' &&
        candidate.type !== 'app:terminal:snapshot-chunk',
      timeoutMs
    );
    expect(parseRemoteAppFrame(frame), JSON.stringify(frame)).not.toBeNull();
    return frame;
  }

  async function output(connection: PhoneConnection, terminalId: string, text: string) {
    let seen = '';
    while (!seen.includes(text)) {
      const data = await connection.next(
        (frame) => frame.type === 'app:terminal:data' && frame.terminalId === terminalId,
        20_000
      );
      seen += data.data as string;
    }
  }

  async function signIn(capabilities?: string[]): Promise<{
    connection: PhoneConnection;
    resumeToken: string;
    authenticated: Record<string, unknown>;
  }> {
    const connection = new PhoneConnection(url, fingerprint);
    await connection.open();
    await connection.send({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'authenticate',
      deviceId: phone.deviceId,
      ...(capabilities ? { capabilities } : {}),
    });
    const challenge = await connection.next((frame) => frame.type === 'pair:auth-challenge');
    expect(challenge).toMatchObject({ rpId: RP_ID, origin: ORIGIN });
    signCount += 1;
    const { response } = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: challenge.challenge as string,
      signCount,
      credentialId: CREDENTIAL_ID,
      privateKey: phone.passkey,
    });
    const proof = buildDeviceProof(
      'authenticate',
      challenge.challenge as string,
      connection.binding()
    );
    await connection.send({
      type: 'pair:auth-response',
      authenticationResponse: response,
      deviceSignature: encodeBase64(await signDeviceProof(phone.privateKey, proof)),
    });
    const authenticated = await connection.next((frame) => frame.type === 'pair:authenticated');
    expect(authenticated).toMatchObject({ deviceId: phone.deviceId, label: 'iPhone' });
    return { connection, resumeToken: authenticated.resumeToken as string, authenticated };
  }

  beforeAll(async () => {
    execFileSync('cargo', ['build', '--quiet', '--manifest-path', join(COMPANION, 'Cargo.toml')], {
      stdio: 'inherit',
    });
    root = mkdtempSync(join(tmpdir(), 'komla-phone-host-'));
    stateDir = join(root, 'base/helpers/companion/phone-test');
    tmuxSocket = `komla-phone-test-${process.pid}`;
    mkdirSync(join(root, 'base/workspaces'), { recursive: true });
    writeFileSync(
      join(root, 'base/workspaces/ws-1.json'),
      JSON.stringify({
        schema: 1,
        workspaceId: 'ws-1',
        name: 'fix-ssh',
        customName: 'Fix SSH prompt',
        tag: { name: 'In review', tone: 'info' },
        branchName: 'ssh-passphrase',
        backend: { remoteDirectory: join(root, 'work'), projectName: 'komla' },
        terminals: [{ id: 'term-a', name: 'Claude Code', createdAt: 1 }],
        primaryTerminalId: 'term-a',
        createdAt: 1_000,
        updatedAt: 2_000,
      })
    );
    execFileSync('tmux', [
      '-L',
      tmuxSocket,
      '-f',
      '/dev/null',
      'new-session',
      '-d',
      '-s',
      'komla-term-a',
      '-x',
      '80',
      '-y',
      '24',
      "printf 'agent ready\\n'; exec cat",
    ]);

    // A project whose repository Komla set up here, and what the desktop lets phones start.
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        stdio: 'ignore',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Komla',
          GIT_AUTHOR_EMAIL: 'komla@example.com',
          GIT_COMMITTER_NAME: 'Komla',
          GIT_COMMITTER_EMAIL: 'komla@example.com',
        },
      });
    mkdirSync(join(root, 'origin'));
    git(join(root, 'origin'), 'init', '--quiet', '--initial-branch', 'main');
    writeFileSync(join(root, 'origin/README.md'), 'hello\n');
    git(join(root, 'origin'), 'add', 'README.md');
    git(join(root, 'origin'), 'commit', '--quiet', '-m', 'init');
    mkdirSync(join(root, 'base/repos/app'), { recursive: true });
    git(
      root,
      'clone',
      '--quiet',
      '--bare',
      join(root, 'origin'),
      join(root, 'base/repos/app/repo.git')
    );
    launchFile = JSON.stringify({
      version: 1,
      hostId: 'host-1',
      projects: [
        {
          summary: { id: 'p-app', name: 'app', repositoryPath: '/Users/me/app' },
          remoteRepoPath: join(root, 'base/repos/app/repo.git'),
          remoteProjectRoot: join(root, 'base/worktrees/app'),
          gitUrl: join(root, 'origin'),
          projectName: 'app',
          baseBranch: 'main',
        },
      ],
      presets: [
        {
          summary: { id: 'echo', name: 'Echo', launchModes: [] },
          launches: [
            {
              promptCommand: "printf 'asked %s\\n' {{prompt}}; exec cat",
              openCommand: 'exec cat',
              continueCommand: "printf 'resumed\\n'; exec cat",
            },
          ],
        },
      ],
    });

    phone = await makePhone();
    const port = await freePort();
    fingerprint = JSON.parse(
      execFileSync(BINARY, ['__phone-init', stateDir], { encoding: 'utf8' })
    ).fingerprint;
    writeFileSync(join(stateDir, 'trust.json'), trustFile([phone]));
    writeFileSync(join(stateDir, 'launch.json'), launchFile);
    writeFileSync(
      join(stateDir, 'config.json'),
      JSON.stringify({
        version: 1,
        port,
        basePath: join(root, 'base'),
        tmuxSocket,
        hostName: 'devbox',
      })
    );
    server = spawn(BINARY, ['__phone-serve', join(stateDir, 'config.json')], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, TMUX: '' },
    });
    await new Promise<void>((done, fail) => {
      server.stderr!.on('data', (chunk) => {
        if (String(chunk).includes('listening')) done();
      });
      server.once('exit', (code) => fail(new Error(`server exited ${code}`)));
    });
    url = `ws://127.0.0.1:${port}/remote/ws`;
  }, 300_000);

  afterAll(() => {
    server?.kill();
    spawnSync('tmux', ['-L', tmuxSocket, 'kill-server']);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('signs a trusted phone in with its passkey and installation key and lists the workspace', async () => {
    const { connection } = await signIn();

    await connection.send({ type: 'app:workspaces:list', requestId: 'r1' });
    const list = await connection.next((frame) => frame.type === 'app:workspaces');

    expect(list.workspaces).toEqual([
      expect.objectContaining({
        id: 'ws-1',
        name: 'Fix SSH prompt',
        projectName: 'komla',
        primaryTerminalId: 'term-a',
        terminals: [
          {
            id: 'term-a',
            name: 'Claude Code',
            status: 'running',
            environment: { kind: 'ssh', name: 'devbox' },
          },
        ],
      }),
    ]);
    connection.close();
  });

  it("lists workspaces' tags only for a phone that agreed to them", async () => {
    const tagsOf = async (capabilities?: string[]) => {
      const { connection } = await signIn(capabilities);
      await connection.send({ type: 'app:workspaces:list', requestId: 'r1' });
      const list = await connection.next((frame) => frame.type === 'app:workspaces');
      connection.close();
      expect(parseRemoteAppFrame(list)).not.toBeNull();
      return (list.workspaces as Array<{ tag?: unknown }>).map((workspace) => workspace.tag);
    };

    expect(await tagsOf(['workspace-tags'])).toEqual([{ name: 'In review', tone: 'info' }]);
    expect(await tagsOf()).toEqual([undefined]);
  });

  it('attaches to the running tmux session and types into it', async () => {
    const { connection } = await signIn();

    await connection.send({
      type: 'app:terminal:attach',
      requestId: 'a1',
      workspaceId: 'ws-1',
      terminalId: 'term-a',
      cols: 60,
      rows: 20,
    });
    const attached = await connection.next((frame) => frame.type === 'app:terminal:attached');
    expect(attached.snapshot).toMatchObject({ terminalId: 'term-a', cols: 60, rows: 20 });
    await connection.next((frame) => frame.type === 'app:terminal:snapshot-chunk');
    let output = '';
    const sawText = async (text: string) => {
      while (!output.includes(text)) {
        const data = await connection.next((frame) => frame.type === 'app:terminal:data');
        output += data.data as string;
      }
    };
    await sawText('agent ready');
    await connection.send({
      type: 'app:terminal:input',
      terminalId: 'term-a',
      data: 'from the phone\r',
    });
    await sawText('from the phone');

    await connection.send({
      type: 'app:workspace:title:regenerate',
      requestId: 's1',
      workspaceId: 'ws-1',
    });
    const refused = await connection.next((frame) => frame.type === 'app:error');
    expect(refused).toMatchObject({ requestId: 's1', code: 'unsupported' });
    connection.close();
  });

  it('creates, stops and starts a workspace, and opens and closes its tabs, without the desktop', async () => {
    const { connection } = await signIn();

    await connection.send({ type: 'app:launch-options:get', requestId: 'o1' });
    expect(await reply(connection, 'o1')).toMatchObject({
      projects: [{ id: 'p-app', name: 'app' }],
      presets: [{ id: 'echo', name: 'Echo' }],
      environments: [{ kind: 'ssh', id: 'host-1', name: 'devbox' }],
    });

    await connection.send({
      type: 'app:workspace:create',
      requestId: 'c1',
      projectId: 'p-app',
      presetId: 'echo',
      initialPrompt: 'hello host',
      environment: { kind: 'ssh', hostId: 'host-1' },
    });
    const created = await reply(connection, 'c1', 30_000);
    expect(created.type).toBe('app:workspace:created');
    const workspace = created.workspace as {
      id: string;
      branchName: string;
      terminals: Array<{ id: string; status: string }>;
    };
    expect(workspace.branchName).toBe('hello-host');
    expect(workspace.terminals).toEqual([expect.objectContaining({ status: 'running' })]);
    const agent = workspace.terminals[0]!.id;
    await connection.send({
      type: 'app:terminal:attach',
      requestId: 'a1',
      workspaceId: workspace.id,
      terminalId: agent,
      cols: 80,
      rows: 24,
    });
    await reply(connection, 'a1');
    await output(connection, agent, 'asked hello host');

    await connection.send({
      type: 'app:terminal:create',
      requestId: 't1',
      workspaceId: workspace.id,
      source: { kind: 'shell' },
    });
    const shell = await reply(connection, 't1');
    expect(shell.type).toBe('app:terminal:created');
    await connection.send({
      type: 'app:terminal:close',
      requestId: 't2',
      workspaceId: workspace.id,
      terminalId: shell.terminalId,
    });
    expect((await reply(connection, 't2')).type).toBe('app:terminal:closed');

    await connection.send({
      type: 'app:workspace:stop',
      requestId: 's1',
      workspaceId: workspace.id,
    });
    const stopped = await reply(connection, 's1');
    expect(stopped.type).toBe('app:workspace:stopped');
    expect((stopped.workspace as typeof workspace).terminals).toEqual([
      expect.objectContaining({ id: agent, status: 'stopped' }),
    ]);

    await connection.send({
      type: 'app:workspace:start',
      requestId: 's2',
      workspaceId: workspace.id,
    });
    const started = await reply(connection, 's2');
    expect(started.type).toBe('app:workspace:started');
    const resumed = (started.workspace as typeof workspace).terminals;
    expect(resumed).toEqual([expect.objectContaining({ status: 'running' })]);
    expect(resumed[0]!.id).not.toBe(agent);
    await connection.send({
      type: 'app:terminal:attach',
      requestId: 'a2',
      workspaceId: workspace.id,
      terminalId: resumed[0]!.id,
      cols: 80,
      rows: 24,
    });
    await reply(connection, 'a2');
    await output(connection, resumed[0]!.id, 'resumed');

    await connection.send({
      type: 'app:workspace:create',
      requestId: 'c2',
      projectId: 'p-missing',
    });
    expect(await reply(connection, 'c2', 30_000)).toMatchObject({
      type: 'app:error',
      code: 'create-failed',
    });
    connection.close();
  }, 60_000);

  it('switches to binary frames when the phone asks, for output and typing alike', async () => {
    const { connection, authenticated } = await signIn(['binary-frames', 'from-the-future']);
    expect(authenticated.capabilities).toEqual(['binary-frames']);
    connection.enableBinaryFrames();

    await connection.send({
      type: 'app:terminal:attach',
      requestId: 'a2',
      workspaceId: 'ws-1',
      terminalId: 'term-a',
      cols: 60,
      rows: 20,
    });
    await connection.next((frame) => frame.type === 'app:terminal:attached');
    let output = '';
    const sawText = async (text: string) => {
      while (!output.includes(text)) {
        const data = await connection.next((frame) => frame.type === 'app:terminal:data');
        expect(data.binary).toBe(true);
        output += data.data as string;
      }
    };
    await sawText('agent ready');
    await connection.sendBinary(
      encodeBinaryTerminalInput({ terminalId: 'term-a', data: 'typed in binary\r' })
    );
    await sawText('typed in binary');
    expect(connection.binaryReceived).toBeGreaterThan(0);
    connection.close();
  });

  it('resumes a recent session once with a fresh installation-key signature', async () => {
    const { connection, resumeToken } = await signIn();
    connection.close();
    await connection.waitClosed();
    await new Promise((done) => setTimeout(done, 200));

    const resumed = new PhoneConnection(url, fingerprint);
    await resumed.open();
    await resumed.send({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'resume',
      deviceId: phone.deviceId,
      resumeToken,
    });
    const challenge = await resumed.next((frame) => frame.type === 'pair:resume-challenge');
    const proof = buildDeviceProof('resume', challenge.challenge as string, resumed.binding());
    await resumed.send({
      type: 'pair:resume-response',
      deviceSignature: encodeBase64(await signDeviceProof(phone.privateKey, proof)),
    });

    await resumed.next((frame) => frame.type === 'pair:authenticated');
    resumed.close();
  });

  it('refuses another origin, a wrong passkey and a pinned fingerprint mismatch', async () => {
    await expect(
      new PhoneConnection(url, fingerprint, 'https://evil.ts.net').open()
    ).rejects.toThrow(/403/);
    await expect(new PhoneConnection(url, 'f'.repeat(64)).open()).rejects.toThrow();

    const connection = new PhoneConnection(url, fingerprint);
    await connection.open();
    await connection.send({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'authenticate',
      deviceId: phone.deviceId,
    });
    const challenge = await connection.next((frame) => frame.type === 'pair:auth-challenge');
    const impostor = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const { response } = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: challenge.challenge as string,
      signCount: 1_000,
      credentialId: CREDENTIAL_ID,
      privateKey: impostor,
    });
    const proof = buildDeviceProof(
      'authenticate',
      challenge.challenge as string,
      connection.binding()
    );
    await connection.send({
      type: 'pair:auth-response',
      authenticationResponse: response,
      deviceSignature: encodeBase64(await signDeviceProof(phone.privateKey, proof)),
    });

    const rejected = await connection.next((frame) => frame.type === 'pair:rejected');
    expect(rejected.reason).toBe('signature-failed');
  });

  it('replaces the older session when the same phone signs in again, so it does not reconnect', async () => {
    const first = await signIn();
    const second = await signIn();

    expect(await first.connection.waitClosed()).toMatchObject({ code: 4409, reason: 'replaced' });
    await second.connection.send({ type: 'app:workspaces:list', requestId: 'r2' });
    await second.connection.next((frame) => frame.type === 'app:workspaces');
    second.connection.close();
  });

  it('ends the session of a phone the desktop stops trusting', async () => {
    const { connection } = await signIn();

    writeFileSync(join(stateDir, 'trust.json'), trustFile([]));

    expect(await connection.waitClosed()).toMatchObject({ code: 4401, reason: 'device-removed' });
    writeFileSync(join(stateDir, 'trust.json'), trustFile([phone]));
  });
});
