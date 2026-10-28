import { describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());
vi.mock('node-pty', () => ({ spawn: vi.fn() }));
vi.mock('../../../src/main/services/workspace.service', () => ({ workspaceService: {} }));
vi.mock('../../../src/main/services/pty.service', () => ({ ptyService: {} }));
vi.mock('../../../src/main/services/project.service', () => ({ projectService: {} }));
vi.mock('../../../src/main/services/agent-preset.service', () => ({ agentPresetService: {} }));
vi.mock('../../../src/main/services/config.service', () => ({
  configService: { get: vi.fn(() => ({})) },
}));
vi.mock('../../../src/main/services/ssh-host.service', () => ({
  sshHostService: { list: vi.fn(() => []) },
}));
vi.mock('../../../src/main/services/action.service', () => ({ actionService: {} }));
vi.mock('../../../src/main/services/git.service', () => ({ gitService: {} }));
vi.mock('../../../src/main/services/voice-transcription.service', () => ({
  voiceTranscriptionService: { getStatus: vi.fn(() => 'not-downloaded') },
}));
vi.mock('../../../src/main/services/window.service', () => ({
  windowService: { getMainWindowId: vi.fn(() => null), broadcastWhenReady: vi.fn() },
}));
vi.mock('../../../src/main/services/paired-device-registry.service', () => ({
  pairedDeviceRegistryService: { list: vi.fn(() => []), onChange: vi.fn(() => () => {}) },
}));

import { RemoteControlSessionService } from '../../../src/main/services/remote-control-session.service';

import type { PushViewer } from '../../../src/main/services/remote-control-push.service';
import type { DecodedMessage } from '@komla/remote-protocol';

const subscription = {
  endpoint: 'https://web.push.apple.com/abc',
  keys: { p256dh: `B${'A'.repeat(86)}`, auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
};

class FakePeer {
  sent: unknown[] = [];
  private handlers: Array<(msg: DecodedMessage) => void> = [];

  onMessage(cb: (msg: DecodedMessage) => void): void {
    this.handlers.push(cb);
  }

  onClose(): void {}

  async sendEncryptedJson(value: unknown): Promise<void> {
    this.sent.push(value);
  }

  async emit(data: unknown): Promise<void> {
    for (const handler of this.handlers) handler({ kind: 'json', data });
    // Frames are handled on a promise chain; let it drain.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
}

function makeSession(device?: { credentialId: string }) {
  let viewer: (() => PushViewer) | null = null;
  const unregister = vi.fn();
  const push = {
    config: vi.fn(() => ({
      available: true,
      vapidPublicKey: `B${'C'.repeat(86)}`,
      subscribed: true,
      notifyWhen: 'away' as const,
    })),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sendTest: vi.fn(async () => 'delivered' as const),
    registerViewer: vi.fn((_: string, current: () => PushViewer) => {
      viewer = current;
      return unregister;
    }),
  };
  const noop = () => () => {};
  const service = new RemoteControlSessionService({
    pty: { onData: noop, onReset: noop, onStatus: noop, onExit: noop } as never,
    push,
  });
  const peer = new FakePeer();
  const session = service.attachPeer(peer, device);
  return { peer, push, session, unregister, viewer: () => viewer?.() };
}

describe('remote control session push frames', () => {
  it('answers with the push state of the device the session authenticated as', async () => {
    const { peer, push } = makeSession({ credentialId: 'cred-phone' });

    await peer.emit({ type: 'app:push:config:get', requestId: 'r1' });

    expect(push.config).toHaveBeenCalledWith('cred-phone');
    expect(peer.sent).toEqual([
      {
        type: 'app:push:config',
        requestId: 'r1',
        available: true,
        vapidPublicKey: `B${'C'.repeat(86)}`,
        subscribed: true,
        notifyWhen: 'away',
      },
    ]);
  });

  it('stores and removes the subscription for that device only', async () => {
    const { peer, push } = makeSession({ credentialId: 'cred-phone' });

    await peer.emit({
      type: 'app:push:subscribe',
      requestId: 'r1',
      subscription,
      notifyWhen: 'always',
    });
    await peer.emit({ type: 'app:push:unsubscribe', requestId: 'r2' });

    expect(push.subscribe).toHaveBeenCalledWith('cred-phone', subscription, 'always');
    expect(push.unsubscribe).toHaveBeenCalledWith('cred-phone');
    expect(peer.sent).toMatchObject([
      { type: 'app:push:config', requestId: 'r1' },
      { type: 'app:push:config', requestId: 'r2' },
    ]);
  });

  it('reports a rejected subscription as an error', async () => {
    const { peer, push } = makeSession({ credentialId: 'cred-phone' });
    push.subscribe.mockImplementation(() => {
      throw new Error('Notifications need an OS keychain on this computer.');
    });

    await peer.emit({
      type: 'app:push:subscribe',
      requestId: 'r1',
      subscription,
      notifyWhen: 'away',
    });

    expect(peer.sent).toEqual([
      {
        type: 'app:error',
        requestId: 'r1',
        code: 'push-rejected',
        message: 'Notifications need an OS keychain on this computer.',
      },
    ]);
  });

  it('sends a test notification and reports what the push service said', async () => {
    const { peer, push } = makeSession({ credentialId: 'cred-phone' });

    await peer.emit({ type: 'app:push:test', requestId: 'r1' });

    expect(push.sendTest).toHaveBeenCalledWith('cred-phone');
    expect(peer.sent).toEqual([{ type: 'app:push:tested', requestId: 'r1', outcome: 'delivered' }]);
  });

  it('tells the push service whether the phone page is on screen', async () => {
    const { peer, viewer, session, unregister } = makeSession({ credentialId: 'cred-phone' });

    expect(viewer()).toMatchObject({ visible: true });
    await peer.emit({ type: 'app:client:visibility', visible: false });
    expect(viewer()).toMatchObject({ visible: false });

    session.dispose();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('refuses push frames from a session with no trusted device', async () => {
    const { peer, push } = makeSession();

    await peer.emit({ type: 'app:push:config:get', requestId: 'r1' });

    expect(push.registerViewer).not.toHaveBeenCalled();
    expect(peer.sent).toMatchObject([
      { type: 'app:error', requestId: 'r1', code: 'push-unavailable' },
    ]);
  });
});
