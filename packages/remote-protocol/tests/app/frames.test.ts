import { describe, expect, it } from 'vitest';

import {
  escapeRemoteAttentionCustomTitleSource,
  isRemoteAttentionCustomTitle,
  parseRemoteAppFrame,
} from '../../src/app/frames';

describe('remote app frames', () => {
  it('escapes user sources that collide with the custom-title marker', () => {
    const source = escapeRemoteAttentionCustomTitleSource(
      `komla:custom-title:${'user-source'.repeat(20)}`
    );

    expect(isRemoteAttentionCustomTitle(source)).toBe(false);
    expect(source.length).toBeLessThanOrEqual(128);
  });

  it('parses a workspace list request', () => {
    expect(parseRemoteAppFrame({ type: 'app:workspaces:list', requestId: 'r1' })).toEqual({
      type: 'app:workspaces:list',
      requestId: 'r1',
    });
  });

  it('parses launch options and workspace creation options', () => {
    expect(
      parseRemoteAppFrame({
        type: 'app:launch-options',
        requestId: 'r1',
        defaultLaunchModeId: 'mode-1',
        projects: [
          {
            id: 'p1',
            name: 'Komla',
            repositoryPath: '/repo/komla',
            color: 'hsl(200, 75%, 50%)',
          },
        ],
        presets: [
          {
            id: 'preset-1',
            name: 'Codex',
            lastLaunchModeId: 'mode-1',
            launchModes: [{ id: 'mode-1', name: 'Full auto', color: 'purple' }],
          },
        ],
        environments: [
          { kind: 'local', name: 'This computer' },
          { kind: 'ssh', id: 'ssh-1', name: 'Build server' },
        ],
        actions: [
          { id: 'action-1', title: 'Run tests', type: 'command' },
          { id: 'action-2', title: 'Investigate', type: 'prompt', requiresInput: true },
        ],
      })
    ).toMatchObject({ type: 'app:launch-options' });

    expect(
      parseRemoteAppFrame({
        type: 'app:workspace:create',
        requestId: 'r2',
        projectId: 'p1',
        presetId: 'preset-1',
        launchModeId: 'mode-1',
        initialPrompt: 'Fix the tests',
        environment: { kind: 'ssh', hostId: 'ssh-1' },
      })
    ).toMatchObject({ type: 'app:workspace:create' });
    expect(
      parseRemoteAppFrame({
        type: 'app:workspace:create',
        requestId: 'r3',
        projectId: 'p1',
        environment: { kind: 'sandbox', methodId: 'lima' },
      })
    ).toBeNull();
  });

  it('parses terminal creation and close frames', () => {
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:create',
        requestId: 'r1',
        workspaceId: 'w1',
        source: { kind: 'agent', presetId: 'preset-1', launchModeId: 'mode-1', prompt: 'Review' },
      })
    ).toMatchObject({ type: 'app:terminal:create', source: { kind: 'agent' } });
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:create',
        requestId: 'r2',
        workspaceId: 'w1',
        source: { kind: 'action', actionId: 'action-1', userInput: 'auth failure' },
      })
    ).toMatchObject({ type: 'app:terminal:create', source: { kind: 'action' } });
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:close',
        requestId: 'r3',
        workspaceId: 'w1',
        terminalId: 't1',
      })
    ).toMatchObject({ type: 'app:terminal:close', terminalId: 't1' });
  });

  it('parses workspace start frames', () => {
    expect(
      parseRemoteAppFrame({
        type: 'app:workspace:start',
        requestId: 'r1',
        workspaceId: 'w1',
      })
    ).toEqual({
      type: 'app:workspace:start',
      requestId: 'r1',
      workspaceId: 'w1',
    });

    expect(
      parseRemoteAppFrame({
        type: 'app:workspace:started',
        requestId: 'r2',
        workspace: {
          id: 'w1',
          name: 'Workspace',
          workingDirectory: '/tmp/w1',
          status: 'active',
          provisioning: false,
          primaryTerminalId: 't1',
          terminals: [{ id: 't1', name: 'Workspace', status: 'starting' }],
        },
      })
    ).toMatchObject({ type: 'app:workspace:started' });
  });

  it('keeps workspace attention compatible with the strict v1 shape', () => {
    const attention = {
      kind: 'generic',
      source: 'custom-hook',
      updatedAt: 1_000,
      title: 'Review ready',
      body: 'Authentication changes are waiting.',
      color: 'oklch(62% 0.2 285)',
      terminalId: 't1',
    };

    expect(
      parseRemoteAppFrame({
        type: 'app:workspaces',
        requestId: 'r1',
        workspaces: [
          {
            id: 'w1',
            name: 'Workspace',
            workingDirectory: '/tmp/w1',
            status: 'active',
            provisioning: false,
            attention,
            terminals: [{ id: 't1', name: 'Agent', status: 'running', attention }],
          },
        ],
      })
    ).toBeNull();
  });

  it('parses workspace stop frames', () => {
    expect(
      parseRemoteAppFrame({
        type: 'app:workspace:stop',
        requestId: 'r1',
        workspaceId: 'w1',
      })
    ).toEqual({
      type: 'app:workspace:stop',
      requestId: 'r1',
      workspaceId: 'w1',
    });

    expect(
      parseRemoteAppFrame({
        type: 'app:workspace:stopped',
        requestId: 'r2',
        workspace: {
          id: 'w1',
          name: 'Workspace',
          workingDirectory: '/tmp/w1',
          status: 'active',
          provisioning: false,
          primaryTerminalId: 't1',
          terminals: [{ id: 't1', name: 'Workspace', status: 'stopped' }],
        },
      })
    ).toMatchObject({ type: 'app:workspace:stopped' });
  });

  it('parses workspace title regeneration frames', () => {
    expect(
      parseRemoteAppFrame({
        type: 'app:workspace:title:regenerate',
        requestId: 'r1',
        workspaceId: 'w1',
      })
    ).toEqual({
      type: 'app:workspace:title:regenerate',
      requestId: 'r1',
      workspaceId: 'w1',
    });

    expect(
      parseRemoteAppFrame({
        type: 'app:workspace:title:regenerated',
        requestId: 'r2',
        workspace: {
          id: 'w1',
          name: 'Generated Title',
          workingDirectory: '/tmp/w1',
          status: 'active',
          provisioning: false,
          terminals: [],
        },
      })
    ).toMatchObject({ type: 'app:workspace:title:regenerated' });
  });

  it('rejects unknown app frames', () => {
    expect(parseRemoteAppFrame({ type: 'app:nope', requestId: 'r1' })).toBeNull();
  });

  it('bounds terminal resize dimensions', () => {
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:resize',
        terminalId: 't1',
        cols: 120,
        rows: 30,
      })
    ).toMatchObject({ type: 'app:terminal:resize' });
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:resize',
        terminalId: 't1',
        cols: 0,
        rows: 30,
      })
    ).toBeNull();
  });

  it('parses chunked authoritative terminal snapshots and reset generations', () => {
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:attached',
        requestId: 'r1',
        snapshot: {
          workspaceId: 'w1',
          terminalId: 't1',
          status: 'running',
          seq: 9,
          generation: 2,
          cols: 48,
          rows: 18,
          chunkCount: 1,
        },
      })
    ).toMatchObject({ type: 'app:terminal:attached' });
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:snapshot-chunk',
        requestId: 'r1',
        terminalId: 't1',
        generation: 2,
        index: 0,
        data: '\u001b[2Jready',
      })
    ).toMatchObject({ type: 'app:terminal:snapshot-chunk', index: 0 });
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:reset',
        workspaceId: 'w1',
        terminalId: 't1',
        generation: 3,
        seq: 9,
        cols: 48,
        rows: 18,
      })
    ).toMatchObject({ type: 'app:terminal:reset', generation: 3 });
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:data',
        workspaceId: 'w1',
        terminalId: 't1',
        generation: 3,
        data: 'next',
        seq: 10,
      })
    ).toMatchObject({ type: 'app:terminal:data', generation: 3 });
  });

  it('says who a terminal is sized for, the desktop or the remote device', () => {
    const frame = {
      type: 'app:terminal:size',
      workspaceId: 'w1',
      terminalId: 't1',
      owner: 'desktop',
      cols: 140,
      rows: 40,
    };
    expect(parseRemoteAppFrame(frame)).toEqual(frame);
    expect(parseRemoteAppFrame({ ...frame, owner: 'remote' })).toMatchObject({ owner: 'remote' });
    expect(parseRemoteAppFrame({ ...frame, owner: 'phone' })).toBeNull();
    expect(parseRemoteAppFrame({ ...frame, cols: 0 })).toBeNull();
    expect(parseRemoteAppFrame({ ...frame, extra: true })).toBeNull();
  });

  it('allows an empty generation-0 snapshot only for a terminal that has not spawned', () => {
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:attached',
        requestId: 'r1',
        snapshot: {
          workspaceId: 'w1',
          terminalId: 't1',
          status: 'starting',
          seq: 0,
          generation: 0,
          cols: 48,
          rows: 18,
          chunkCount: 1,
        },
      })
    ).toMatchObject({ type: 'app:terminal:attached' });
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:snapshot-chunk',
        requestId: 'r1',
        terminalId: 't1',
        generation: 0,
        index: 0,
        data: '',
      })
    ).toMatchObject({ type: 'app:terminal:snapshot-chunk', generation: 0 });
    expect(
      parseRemoteAppFrame({
        type: 'app:terminal:data',
        workspaceId: 'w1',
        terminalId: 't1',
        generation: 0,
        data: 'next',
        seq: 1,
      })
    ).toBeNull();
  });

  it('parses voice status and availability frames', () => {
    expect(parseRemoteAppFrame({ type: 'app:voice:status', requestId: 'r1' })).toEqual({
      type: 'app:voice:status',
      requestId: 'r1',
    });
    expect(
      parseRemoteAppFrame({ type: 'app:voice:availability', requestId: 'r1', available: true })
    ).toEqual({ type: 'app:voice:availability', requestId: 'r1', available: true });
  });

  it('parses voice transcribe chunks and rejects empty audio', () => {
    expect(
      parseRemoteAppFrame({
        type: 'app:voice:transcribe',
        requestId: 'r1',
        terminalId: 't1',
        audio: 'AAAA',
        seq: 0,
        final: true,
        enter: false,
      })
    ).toMatchObject({ type: 'app:voice:transcribe', terminalId: 't1', seq: 0, final: true });
    expect(
      parseRemoteAppFrame({
        type: 'app:voice:transcribe',
        requestId: 'r1',
        purpose: 'prompt',
        audio: 'AAAA',
        seq: 0,
        final: true,
        enter: false,
      })
    ).toMatchObject({ type: 'app:voice:transcribe', purpose: 'prompt' });
    expect(
      parseRemoteAppFrame({ type: 'app:voice:transcribed', requestId: 'r1', text: 'hello' })
    ).toEqual({
      type: 'app:voice:transcribed',
      requestId: 'r1',
      text: 'hello',
    });
    expect(
      parseRemoteAppFrame({
        type: 'app:voice:transcribe',
        requestId: 'r1',
        terminalId: 't1',
        audio: '',
        seq: 0,
        final: true,
        enter: false,
      })
    ).toBeNull();
    // Chunking/enter fields are required.
    expect(
      parseRemoteAppFrame({
        type: 'app:voice:transcribe',
        requestId: 'r1',
        terminalId: 't1',
        audio: 'AAAA',
      })
    ).toBeNull();
  });

  it('parses the SSH hosts a phone may open, pinned and over TLS', () => {
    const host = {
      id: 'host-1',
      name: 'devbox',
      url: 'wss://devbox.tail1.ts.net:48123/remote/ws',
      fingerprint: 'f'.repeat(64),
    };
    const hosts = (list: unknown[]) =>
      parseRemoteAppFrame({ type: 'app:hosts', requestId: 'h1', hosts: list });

    expect(parseRemoteAppFrame({ type: 'app:hosts:list', requestId: 'h1' })).not.toBeNull();
    expect(hosts([host])).toEqual({ type: 'app:hosts', requestId: 'h1', hosts: [host] });
    expect(hosts([{ ...host, url: 'ws://127.0.0.1:48123/remote/ws' }])).not.toBeNull();
    expect(hosts([{ ...host, url: 'ws://devbox.tail1.ts.net:48123/remote/ws' }])).toBeNull();
    expect(hosts([{ ...host, url: 'ws://localhost.evil.net:1/' }])).toBeNull();
    expect(hosts([{ ...host, fingerprint: 'F'.repeat(64) }])).toBeNull();
    expect(hosts([{ ...host, extra: true }])).toBeNull();
  });

  it('parses Web Push subscription frames and rejects keys a browser cannot produce', () => {
    const subscription = {
      endpoint: 'https://web.push.apple.com/QGuQyavXutnMH8Eu8',
      keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    };

    expect(parseRemoteAppFrame({ type: 'app:push:config:get', requestId: 'r1' })).not.toBeNull();
    expect(
      parseRemoteAppFrame({
        type: 'app:push:config',
        requestId: 'r1',
        available: true,
        vapidPublicKey: `B${'A'.repeat(86)}`,
        subscribed: true,
        notifyWhen: 'away',
      })
    ).not.toBeNull();
    expect(
      parseRemoteAppFrame({
        type: 'app:push:subscribe',
        requestId: 'r2',
        subscription,
        notifyWhen: 'always',
      })
    ).toEqual({ type: 'app:push:subscribe', requestId: 'r2', subscription, notifyWhen: 'always' });
    expect(
      parseRemoteAppFrame({
        type: 'app:push:subscribe',
        requestId: 'r2',
        subscription: { ...subscription, endpoint: 'http://push.example/x' },
        notifyWhen: 'away',
      })
    ).toBeNull();
    expect(
      parseRemoteAppFrame({
        type: 'app:push:subscribe',
        requestId: 'r2',
        subscription: { ...subscription, keys: { ...subscription.keys, auth: 'not base64url!' } },
        notifyWhen: 'away',
      })
    ).toBeNull();
    expect(
      parseRemoteAppFrame({
        type: 'app:push:subscribe',
        requestId: 'r2',
        subscription,
        notifyWhen: 'often',
      })
    ).toBeNull();
    expect(parseRemoteAppFrame({ type: 'app:push:unsubscribe', requestId: 'r3' })).not.toBeNull();
    expect(parseRemoteAppFrame({ type: 'app:push:test', requestId: 'r4' })).not.toBeNull();
    expect(
      parseRemoteAppFrame({ type: 'app:push:tested', requestId: 'r4', outcome: 'delivered' })
    ).not.toBeNull();
    expect(parseRemoteAppFrame({ type: 'app:client:visibility', visible: false })).toEqual({
      type: 'app:client:visibility',
      visible: false,
    });
  });
});
