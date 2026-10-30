import { generateKeyPairSync, sign as nodeSign } from 'crypto';

import {
  Peer,
  buildDeviceProof,
  buildPasskeyChallenge,
  deviceIdFromPublicKey,
  encodeBase64,
  exportDevicePublicKey,
  fingerprintFromPublicKey,
  generateDeviceKeyPair,
  signDeviceProof,
  type PeerTransport,
} from '@komla/remote-protocol';
import { describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../mocks/electron';

vi.mock('electron', () => mockElectron());

import {
  RemoteControlCeremony,
  type RemoteControlPairedDeviceRegistry,
} from '../../../src/main/services/remote-control-authentication';
import { verifyRegistration } from '../../../src/main/lib/webauthn-verify';
import { fakeAuthenticate, fakeRegister } from '../../helpers/fake-authenticator';

import type { PairedDeviceRecord } from '../../../src/shared/types/paired-device';

/** What the page asks a passkey to sign for a challenge, on this connection. */
async function signedChallenge(challenge: string, browser: Peer): Promise<string> {
  const bytes = await buildPasskeyChallenge(challenge, browser.getChannelBinding());
  return Buffer.from(bytes).toString('base64url');
}

const RP_ID = 'mac.tailnet.ts.net';
const ORIGIN = 'https://mac.tailnet.ts.net';
const SECRET = 'A'.repeat(43);
const CHALLENGE = new Uint8Array(32).fill(0x5a);

function registry(): RemoteControlPairedDeviceRegistry & { records: PairedDeviceRecord[] } {
  const records: PairedDeviceRecord[] = [];
  return {
    records,
    list: () => [...records],
    add: (record) => records.push(record),
    getByCredentialId: (id) => records.find((record) => record.credentialId === id) ?? null,
    getByDeviceId: (id) => records.find((record) => record.deviceId === id) ?? null,
    recordAuthSuccess(id, signCounter, lastUsedAt) {
      const index = records.findIndex((record) => record.credentialId === id);
      if (index < 0) throw new Error('credential not found');
      records[index] = { ...records[index]!, signCounter, lastUsedAt };
      return records[index]!;
    },
  };
}

async function peers(): Promise<{ desktop: Peer; browser: Peer }> {
  const install = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const publicKey = new Uint8Array(install.publicKey.export({ format: 'der', type: 'spki' }));
  const fingerprint = await fingerprintFromPublicKey(publicKey);
  let desktop!: Peer;
  let browser!: Peer;
  const desktopTransport: PeerTransport = {
    send: (data) => queueMicrotask(() => browser.handleMessage(data)),
    close: () => {},
  };
  const browserTransport: PeerTransport = {
    send: (data) => queueMicrotask(() => desktop.handleMessage(data)),
    close: () => {},
  };
  desktop = new Peer({
    role: 'desktop',
    transport: desktopTransport,
    installPubkey: publicKey,
    sign: async (data) =>
      new Uint8Array(
        nodeSign('sha256', Buffer.from(data), {
          key: install.privateKey,
          dsaEncoding: 'ieee-p1363',
        })
      ),
  });
  browser = new Peer({
    role: 'client',
    transport: browserTransport,
    expectedFingerprint: fingerprint,
  });
  const desktopEstablished = new Promise<void>((resolve) => desktop.onEstablished(resolve));
  const browserEstablished = new Promise<void>((resolve) => browser.onEstablished(resolve));
  void desktop.connect();
  void browser.connect();
  await Promise.all([desktopEstablished, browserEstablished]);
  return { desktop, browser };
}

function offer() {
  return {
    pairUrl: `${ORIGIN}/remote/pair#secret=${SECRET}`,
    fingerprint: 'f'.repeat(64),
    pairingSecret: SECRET,
  };
}

async function nextJson(peer: Peer): Promise<unknown> {
  return await new Promise((resolve) => {
    peer.onMessage((message) => {
      if (message.kind === 'json') resolve(message.data);
    });
  });
}

describe('RemoteControlCeremony', () => {
  it('enrolls a browser only with its device-key proof and a user-verified passkey', async () => {
    const paired = registry();
    const { desktop, browser } = await peers();
    const deviceKeys = await generateDeviceKeyPair();
    const devicePublicKey = await exportDevicePublicKey(deviceKeys.publicKey);
    const deviceId = await deviceIdFromPublicKey(devicePublicKey);
    const completed = vi.fn();

    new RemoteControlCeremony({
      peer: desktop,
      endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
      fingerprint: 'f'.repeat(64),
      registerCeremonyTimeoutMs: 5_000,
      authCeremonyTimeoutMs: 5_000,
      passkeyTimeoutMs: 5_000,
      registry: paired,
      generateChallenge: () => CHALLENGE,
      getPairingOffer: offer,
      claimPairingOffer: () => true,
      onPairVerifying: vi.fn(),
      onAuthenticating: vi.fn(),
      onPairCompleted: completed,
      onAuthCompleted: vi.fn(),
      onCeremonyFailed: vi.fn(),
    });

    const challengePromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'register',
      pairingSecret: SECRET,
      proposedLabel: 'Phone',
      devicePublicKey: encodeBase64(devicePublicKey),
    });
    const challenge = (await challengePromise) as {
      type: string;
      challenge: string;
      rpId: string;
      origin: string;
    };
    const passkey = fakeRegister({
      rpId: challenge.rpId,
      origin: challenge.origin,
      challenge: challenge.challenge,
    });
    const proof = await signDeviceProof(
      deviceKeys.privateKey,
      buildDeviceProof('register', challenge.challenge, browser.getChannelBinding())
    );
    const registeredPromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:registration-response',
      attestationResponse: passkey.response,
      deviceSignature: encodeBase64(proof),
    });
    const registered = (await registeredPromise) as { type: string; deviceId: string };

    expect(registered).toMatchObject({ type: 'pair:registered', deviceId });
    expect(paired.records[0]).toMatchObject({
      deviceId,
      devicePublicKey: encodeBase64(devicePublicKey),
      credentialId: passkey.response.id,
      rpId: RP_ID,
      origin: ORIGIN,
    });
    expect(completed).toHaveBeenCalledWith('Phone', passkey.response.id);
  });

  it('reconnects only when the browser key and exact passkey both prove possession', async () => {
    const paired = registry();
    const deviceKeys = await generateDeviceKeyPair();
    const devicePublicKey = await exportDevicePublicKey(deviceKeys.publicKey);
    const deviceId = await deviceIdFromPublicKey(devicePublicKey);
    const seed = fakeRegister({ rpId: RP_ID, origin: ORIGIN, challenge: 'seed' });
    const verifiedSeed = await verifyRegistration({
      attestationResponse: seed.response,
      expectedChallenge: 'seed',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!verifiedSeed.ok) throw new Error(verifiedSeed.message);
    paired.add({
      deviceId,
      devicePublicKey: encodeBase64(devicePublicKey),
      credentialId: seed.response.id,
      publicKey: verifiedSeed.credential.publicKey,
      signCounter: 0,
      aaguid: null,
      label: 'Phone',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      transports: ['internal'],
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const { desktop, browser } = await peers();
    const completed = vi.fn();

    new RemoteControlCeremony({
      peer: desktop,
      endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
      fingerprint: 'f'.repeat(64),
      registerCeremonyTimeoutMs: 5_000,
      authCeremonyTimeoutMs: 5_000,
      passkeyTimeoutMs: 5_000,
      registry: paired,
      generateChallenge: () => CHALLENGE,
      getPairingOffer: () => null,
      claimPairingOffer: () => false,
      onPairVerifying: vi.fn(),
      onAuthenticating: vi.fn(),
      onPairCompleted: vi.fn(),
      onAuthCompleted: completed,
      onCeremonyFailed: vi.fn(),
    });

    const challengePromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'authenticate',
      deviceId,
    });
    const challenge = (await challengePromise) as {
      type: string;
      challenge: string;
      credentialId: string;
    };
    const auth = fakeAuthenticate({
      rpId: RP_ID,
      origin: ORIGIN,
      challenge: await signedChallenge(challenge.challenge, browser),
      signCount: 1,
      credentialId: seed.credentialIdBytes,
      privateKey: seed.privateKey,
    });
    const proof = await signDeviceProof(
      deviceKeys.privateKey,
      buildDeviceProof('authenticate', challenge.challenge, browser.getChannelBinding())
    );
    const authenticatedPromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:auth-response',
      authenticationResponse: auth.response,
      deviceSignature: encodeBase64(proof),
    });
    expect(await authenticatedPromise).toMatchObject({
      type: 'pair:authenticated',
      deviceId,
      credentialId: seed.response.id,
    });
    expect(completed).toHaveBeenCalledWith('Phone', seed.response.id, undefined, []);
    expect(paired.records[0]?.signCounter).toBe(1);
  });

  it('rotates the grant after silent resumption, keeping the last passkey time', async () => {
    const paired = registry();
    const deviceKeys = await generateDeviceKeyPair();
    const devicePublicKey = await exportDevicePublicKey(deviceKeys.publicKey);
    const deviceId = await deviceIdFromPublicKey(devicePublicKey);
    const seed = fakeRegister({ rpId: RP_ID, origin: ORIGIN, challenge: 'seed' });
    const verifiedSeed = await verifyRegistration({
      attestationResponse: seed.response,
      expectedChallenge: 'seed',
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    if (!verifiedSeed.ok) throw new Error(verifiedSeed.message);
    paired.add({
      deviceId,
      devicePublicKey: encodeBase64(devicePublicKey),
      credentialId: seed.response.id,
      publicKey: verifiedSeed.credential.publicKey,
      signCounter: 1,
      aaguid: null,
      label: 'Phone',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      transports: ['internal'],
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const { desktop, browser } = await peers();
    const holder = {
      deviceId,
      devicePublicKey: encodeBase64(devicePublicKey),
      credentialId: seed.response.id,
    };
    const resumption = {
      peek: vi.fn(() => ({ holder, verifiedAt: 1_234 })),
      consume: vi.fn(() => ({ holder, verifiedAt: 1_234 })),
      issue: vi.fn(() => ({ token: 'B'.repeat(43), expiresAt: Date.now() + 120_000 })),
    };
    const completed = vi.fn();
    new RemoteControlCeremony({
      peer: desktop,
      endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
      fingerprint: 'f'.repeat(64),
      registerCeremonyTimeoutMs: 5_000,
      authCeremonyTimeoutMs: 5_000,
      passkeyTimeoutMs: 5_000,
      registry: paired,
      resumption,
      generateChallenge: () => CHALLENGE,
      getPairingOffer: () => null,
      claimPairingOffer: () => false,
      onPairVerifying: vi.fn(),
      onAuthenticating: vi.fn(),
      onPairCompleted: vi.fn(),
      onAuthCompleted: completed,
      onCeremonyFailed: vi.fn(),
    });

    const challengePromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'resume',
      deviceId,
      resumeToken: 'A'.repeat(43),
    });
    const challenge = (await challengePromise) as { challenge: string };
    // A connection that drops here leaves the grant for the next attempt.
    expect(resumption.peek).toHaveBeenCalledWith(deviceId, 'A'.repeat(43));
    expect(resumption.consume).not.toHaveBeenCalled();
    const proof = await signDeviceProof(
      deviceKeys.privateKey,
      buildDeviceProof('resume', challenge.challenge, browser.getChannelBinding())
    );
    const authenticatedPromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:resume-response',
      deviceSignature: encodeBase64(proof),
    });

    expect(await authenticatedPromise).toMatchObject({
      type: 'pair:authenticated',
      deviceId,
      resumeToken: 'B'.repeat(43),
    });
    expect(resumption.consume).toHaveBeenCalledWith(deviceId, 'A'.repeat(43));
    // The resumed connection must not extend how long ago the passkey was used.
    expect(resumption.issue).toHaveBeenCalledWith(holder, 1_234);
    expect(completed).toHaveBeenCalledWith('Phone', seed.response.id, 'B'.repeat(43), []);
  });

  it('rejects an expired resume grant before issuing a device challenge', async () => {
    const paired = registry();
    const deviceKeys = await generateDeviceKeyPair();
    const devicePublicKey = await exportDevicePublicKey(deviceKeys.publicKey);
    const deviceId = await deviceIdFromPublicKey(devicePublicKey);
    paired.add({
      deviceId,
      devicePublicKey: encodeBase64(devicePublicKey),
      credentialId: 'credential',
      publicKey: 'public-key',
      signCounter: 0,
      aaguid: null,
      label: 'Phone',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      transports: [],
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const { desktop, browser } = await peers();
    const failed = vi.fn();
    new RemoteControlCeremony({
      peer: desktop,
      endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
      fingerprint: 'f'.repeat(64),
      registerCeremonyTimeoutMs: 5_000,
      authCeremonyTimeoutMs: 5_000,
      passkeyTimeoutMs: 5_000,
      registry: paired,
      resumption: { peek: vi.fn(() => null), consume: vi.fn(), issue: vi.fn() },
      generateChallenge: () => CHALLENGE,
      getPairingOffer: () => null,
      claimPairingOffer: () => false,
      onPairVerifying: vi.fn(),
      onAuthenticating: vi.fn(),
      onPairCompleted: vi.fn(),
      onAuthCompleted: vi.fn(),
      onCeremonyFailed: failed,
    });

    const rejectedPromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'resume',
      deviceId,
      resumeToken: 'A'.repeat(43),
    });
    expect(await rejectedPromise).toMatchObject({
      type: 'pair:rejected',
      reason: 'resume-invalid',
    });
    expect(failed).toHaveBeenCalled();
  });

  it('rejects a resume whose grant another connection redeemed first', async () => {
    const paired = registry();
    const deviceKeys = await generateDeviceKeyPair();
    const devicePublicKey = await exportDevicePublicKey(deviceKeys.publicKey);
    const deviceId = await deviceIdFromPublicKey(devicePublicKey);
    paired.add({
      deviceId,
      devicePublicKey: encodeBase64(devicePublicKey),
      credentialId: 'credential',
      publicKey: 'public-key',
      signCounter: 0,
      aaguid: null,
      label: 'Phone',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      transports: [],
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const { desktop, browser } = await peers();
    const holder = {
      deviceId,
      devicePublicKey: encodeBase64(devicePublicKey),
      credentialId: 'credential',
    };
    const resumption = {
      peek: vi.fn(() => ({ holder, verifiedAt: 1_234 })),
      consume: vi.fn(() => null),
      issue: vi.fn(),
    };
    const completed = vi.fn();
    new RemoteControlCeremony({
      peer: desktop,
      endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
      fingerprint: 'f'.repeat(64),
      registerCeremonyTimeoutMs: 5_000,
      authCeremonyTimeoutMs: 5_000,
      passkeyTimeoutMs: 5_000,
      registry: paired,
      resumption,
      generateChallenge: () => CHALLENGE,
      getPairingOffer: () => null,
      claimPairingOffer: () => false,
      onPairVerifying: vi.fn(),
      onAuthenticating: vi.fn(),
      onPairCompleted: vi.fn(),
      onAuthCompleted: completed,
      onCeremonyFailed: vi.fn(),
    });

    const challengePromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'resume',
      deviceId,
      resumeToken: 'A'.repeat(43),
    });
    const challenge = (await challengePromise) as { challenge: string };
    const proof = await signDeviceProof(
      deviceKeys.privateKey,
      buildDeviceProof('resume', challenge.challenge, browser.getChannelBinding())
    );
    const rejectedPromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:resume-response',
      deviceSignature: encodeBase64(proof),
    });

    expect(await rejectedPromise).toMatchObject({
      type: 'pair:rejected',
      reason: 'resume-invalid',
    });
    expect(resumption.consume).toHaveBeenCalledWith(deviceId, 'A'.repeat(43));
    expect(resumption.issue).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it('leaves the resume grant when the connection drops while the proof is checked', async () => {
    const paired = registry();
    const deviceKeys = await generateDeviceKeyPair();
    const devicePublicKey = await exportDevicePublicKey(deviceKeys.publicKey);
    const deviceId = await deviceIdFromPublicKey(devicePublicKey);
    paired.add({
      deviceId,
      devicePublicKey: encodeBase64(devicePublicKey),
      credentialId: 'credential',
      publicKey: 'public-key',
      signCounter: 0,
      aaguid: null,
      label: 'Phone',
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      transports: [],
      rpId: RP_ID,
      origin: ORIGIN,
    });
    const { desktop, browser } = await peers();
    const holder = {
      deviceId,
      devicePublicKey: encodeBase64(devicePublicKey),
      credentialId: 'credential',
    };
    const resumption = {
      peek: vi.fn(() => ({ holder, verifiedAt: 1_234 })),
      consume: vi.fn(() => ({ holder, verifiedAt: 1_234 })),
      issue: vi.fn(() => ({ token: 'B'.repeat(43), expiresAt: Date.now() + 120_000 })),
    };
    const completed = vi.fn();
    const ceremony = new RemoteControlCeremony({
      peer: desktop,
      endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
      fingerprint: 'f'.repeat(64),
      registerCeremonyTimeoutMs: 5_000,
      authCeremonyTimeoutMs: 5_000,
      passkeyTimeoutMs: 5_000,
      registry: paired,
      resumption,
      generateChallenge: () => CHALLENGE,
      getPairingOffer: () => null,
      claimPairingOffer: () => false,
      onPairVerifying: vi.fn(),
      onAuthenticating: vi.fn(),
      onPairCompleted: vi.fn(),
      onAuthCompleted: completed,
      onCeremonyFailed: vi.fn(),
    });

    const challengePromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'resume',
      deviceId,
      resumeToken: 'A'.repeat(43),
    });
    const challenge = (await challengePromise) as { challenge: string };
    const proof = await signDeviceProof(
      deviceKeys.privateKey,
      buildDeviceProof('resume', challenge.challenge, browser.getChannelBinding())
    );
    // The desktop reads the channel binding just before it checks the proof: drop there.
    const binding = desktop.getChannelBinding.bind(desktop);
    desktop.getChannelBinding = () => {
      ceremony.cancel();
      return binding();
    };
    await browser.sendEncryptedJson({
      type: 'pair:resume-response',
      deviceSignature: encodeBase64(proof),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(resumption.consume).not.toHaveBeenCalled();
    expect(resumption.issue).not.toHaveBeenCalled();
    expect(completed).not.toHaveBeenCalled();
  });

  it('enrolls one browser per pairing offer even when two finish together', async () => {
    const paired = registry();
    let current: ReturnType<typeof offer> | null = offer();
    const browsers: Peer[] = [];
    for (let i = 0; i < 2; i++) {
      const { desktop, browser } = await peers();
      browsers.push(browser);
      new RemoteControlCeremony({
        peer: desktop,
        endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
        fingerprint: 'f'.repeat(64),
        registerCeremonyTimeoutMs: 5_000,
        authCeremonyTimeoutMs: 5_000,
        passkeyTimeoutMs: 5_000,
        registry: paired,
        generateChallenge: () => CHALLENGE,
        getPairingOffer: () => current,
        claimPairingOffer: (pairingSecret) => {
          if (current?.pairingSecret !== pairingSecret) return false;
          current = null;
          return true;
        },
        onPairVerifying: vi.fn(),
        onAuthenticating: vi.fn(),
        onPairCompleted: () => {
          current = null;
        },
        onAuthCompleted: vi.fn(),
        onCeremonyFailed: vi.fn(),
      });
    }

    // Both browsers hold the QR secret and reach the passkey step.
    const responses = await Promise.all(
      browsers.map(async (browser, index) => {
        const deviceKeys = await generateDeviceKeyPair();
        const devicePublicKey = await exportDevicePublicKey(deviceKeys.publicKey);
        const challengePromise = nextJson(browser);
        await browser.sendEncryptedJson({
          type: 'pair:hello',
          protocolVersion: 2,
          mode: 'register',
          pairingSecret: SECRET,
          proposedLabel: `Phone ${index}`,
          devicePublicKey: encodeBase64(devicePublicKey),
        });
        const challenge = (await challengePromise) as {
          challenge: string;
          rpId: string;
          origin: string;
        };
        const passkey = fakeRegister({
          rpId: challenge.rpId,
          origin: challenge.origin,
          challenge: challenge.challenge,
        });
        const proof = await signDeviceProof(
          deviceKeys.privateKey,
          buildDeviceProof('register', challenge.challenge, browser.getChannelBinding())
        );
        return {
          type: 'pair:registration-response',
          attestationResponse: passkey.response,
          deviceSignature: encodeBase64(proof),
        };
      })
    );
    const results = browsers.map((browser) => nextJson(browser));
    await Promise.all(
      browsers.map((browser, index) => browser.sendEncryptedJson(responses[index]))
    );

    const types = ((await Promise.all(results)) as Array<{ type: string }>).map(({ type }) => type);
    expect(types.sort()).toEqual(['pair:registered', 'pair:rejected']);
    expect(paired.records).toHaveLength(1);
  });

  it('rejects a guessed enrollment secret before issuing a passkey challenge', async () => {
    const paired = registry();
    const { desktop, browser } = await peers();
    const deviceKeys = await generateDeviceKeyPair();
    const publicKey = await exportDevicePublicKey(deviceKeys.publicKey);
    const failed = vi.fn();

    new RemoteControlCeremony({
      peer: desktop,
      endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
      fingerprint: 'f'.repeat(64),
      registerCeremonyTimeoutMs: 5_000,
      authCeremonyTimeoutMs: 5_000,
      passkeyTimeoutMs: 5_000,
      registry: paired,
      generateChallenge: () => CHALLENGE,
      getPairingOffer: offer,
      claimPairingOffer: () => true,
      onPairVerifying: vi.fn(),
      onAuthenticating: vi.fn(),
      onPairCompleted: vi.fn(),
      onAuthCompleted: vi.fn(),
      onCeremonyFailed: failed,
    });

    const rejectedPromise = nextJson(browser);
    await browser.sendEncryptedJson({
      type: 'pair:hello',
      protocolVersion: 2,
      mode: 'register',
      pairingSecret: 'B'.repeat(43),
      proposedLabel: 'Attacker',
      devicePublicKey: encodeBase64(publicKey),
    });

    expect(await rejectedPromise).toMatchObject({
      type: 'pair:rejected',
      reason: 'pairing-secret-invalid',
    });
    await vi.waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect(paired.records).toHaveLength(0);
  });

  describe("a browser that isn't paired, signing in with a passkey", () => {
    /** A paired phone's passkey, which another browser may sign in with. */
    async function pairedPasskey() {
      const paired = registry();
      const phoneKeys = await generateDeviceKeyPair();
      const phonePublicKey = await exportDevicePublicKey(phoneKeys.publicKey);
      const seed = fakeRegister({ rpId: RP_ID, origin: ORIGIN, challenge: 'seed' });
      const verifiedSeed = await verifyRegistration({
        attestationResponse: seed.response,
        expectedChallenge: 'seed',
        expectedOrigin: ORIGIN,
        expectedRPID: RP_ID,
      });
      if (!verifiedSeed.ok) throw new Error(verifiedSeed.message);
      paired.add({
        deviceId: await deviceIdFromPublicKey(phonePublicKey),
        devicePublicKey: encodeBase64(phonePublicKey),
        credentialId: seed.response.id,
        publicKey: verifiedSeed.credential.publicKey,
        signCounter: 0,
        aaguid: null,
        label: 'Phone',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        transports: ['internal'],
        rpId: RP_ID,
        origin: ORIGIN,
      });
      return { paired, seed };
    }

    async function signIn(options: {
      paired: ReturnType<typeof registry>;
      passkey: ReturnType<typeof fakeRegister>;
      signWith?: CryptoKey;
      relayedChallenge?: string;
    }) {
      const browserKeys = await generateDeviceKeyPair();
      const browserPublicKey = await exportDevicePublicKey(browserKeys.publicKey);
      const { desktop, browser } = await peers();
      const resumption = {
        peek: vi.fn(),
        consume: vi.fn(),
        issue: vi.fn(() => ({ token: 'B'.repeat(43), expiresAt: Date.now() + 120_000 })),
      };
      const completed = vi.fn();
      new RemoteControlCeremony({
        peer: desktop,
        endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
        fingerprint: 'f'.repeat(64),
        registerCeremonyTimeoutMs: 5_000,
        authCeremonyTimeoutMs: 5_000,
        passkeyTimeoutMs: 5_000,
        registry: options.paired,
        resumption,
        generateChallenge: () => CHALLENGE,
        getPairingOffer: () => null,
        claimPairingOffer: () => false,
        onPairVerifying: vi.fn(),
        onAuthenticating: vi.fn(),
        onPairCompleted: vi.fn(),
        onAuthCompleted: completed,
        onCeremonyFailed: vi.fn(),
      });
      const challengePromise = nextJson(browser);
      await browser.sendEncryptedJson({
        type: 'pair:hello',
        protocolVersion: 2,
        mode: 'passkey',
        devicePublicKey: encodeBase64(browserPublicKey),
      });
      const challenge = (await challengePromise) as Record<string, string>;
      const auth = fakeAuthenticate({
        rpId: RP_ID,
        origin: ORIGIN,
        challenge: options.relayedChallenge ?? (await signedChallenge(challenge.challenge!, browser)),
        signCount: 0,
        credentialId: options.passkey.credentialIdBytes,
        privateKey: options.passkey.privateKey,
      });
      const proof = await signDeviceProof(
        options.signWith ?? browserKeys.privateKey,
        buildDeviceProof('authenticate', challenge.challenge!, browser.getChannelBinding())
      );
      const replyPromise = nextJson(browser);
      await browser.sendEncryptedJson({
        type: 'pair:auth-response',
        authenticationResponse: auth.response,
        deviceSignature: encodeBase64(proof),
      });
      return {
        challenge,
        reply: (await replyPromise) as Record<string, unknown>,
        browserId: await deviceIdFromPublicKey(browserPublicKey),
        browserPublicKey,
        resumption,
        completed,
      };
    }

    it('refuses a passkey signature an SSH host could have passed on from its own session', async () => {
      const { paired, seed } = await pairedPasskey();
      // A host asks a phone to sign this desktop's challenge, as it stands or bound to the host's
      // own session, then answers the desktop with a key of its own.
      for (const relayedChallenge of [
        Buffer.from(CHALLENGE).toString('base64url'),
        Buffer.from(
          await buildPasskeyChallenge(
            Buffer.from(CHALLENGE).toString('base64url'),
            new Uint8Array(32).fill(9)
          )
        ).toString('base64url'),
      ]) {
        const { reply, completed } = await signIn({ paired, passkey: seed, relayedChallenge });

        expect(reply).toMatchObject({ type: 'pair:rejected', reason: 'signature-failed' });
        expect(completed).not.toHaveBeenCalled();
      }
    });

    it("accepts any trusted passkey and ties the browser's grants to its own key", async () => {
      const { paired, seed } = await pairedPasskey();

      const { challenge, reply, browserId, browserPublicKey, resumption, completed } =
        await signIn({ paired, passkey: seed });

      expect(challenge).not.toHaveProperty('credentialId');
      expect(reply).toMatchObject({
        type: 'pair:authenticated',
        deviceId: browserId,
        credentialId: seed.response.id,
        resumeToken: 'B'.repeat(43),
      });
      expect(resumption.issue).toHaveBeenCalledWith(
        {
          deviceId: browserId,
          devicePublicKey: encodeBase64(browserPublicKey),
          credentialId: seed.response.id,
        },
        undefined
      );
      expect(completed).toHaveBeenCalledWith('Phone', seed.response.id, 'B'.repeat(43), []);
    });

    it('refuses a passkey this desktop does not trust', async () => {
      const { paired } = await pairedPasskey();
      const stranger = fakeRegister({ rpId: RP_ID, origin: ORIGIN, challenge: 'other' });

      const { reply, completed } = await signIn({ paired, passkey: stranger });

      expect(reply).toMatchObject({ type: 'pair:rejected', reason: 'unknown-credential' });
      expect(completed).not.toHaveBeenCalled();
    });

    it("refuses a session the browser's key didn't sign", async () => {
      const { paired, seed } = await pairedPasskey();
      const other = await generateDeviceKeyPair();

      const { reply, completed } = await signIn({
        paired,
        passkey: seed,
        signWith: other.privateKey,
      });

      expect(reply).toMatchObject({ type: 'pair:rejected', reason: 'device-signature-failed' });
      expect(completed).not.toHaveBeenCalled();
    });

    it("resumes with the browser's own key, and not once its passkey is removed", async () => {
      const { paired, seed } = await pairedPasskey();
      const browserKeys = await generateDeviceKeyPair();
      const browserPublicKey = await exportDevicePublicKey(browserKeys.publicKey);
      const browserId = await deviceIdFromPublicKey(browserPublicKey);
      const holder = {
        deviceId: browserId,
        devicePublicKey: encodeBase64(browserPublicKey),
        credentialId: seed.response.id,
      };
      const resume = async () => {
        const { desktop, browser } = await peers();
        new RemoteControlCeremony({
          peer: desktop,
          endpoint: { httpOrigin: ORIGIN, rpId: RP_ID },
          fingerprint: 'f'.repeat(64),
          registerCeremonyTimeoutMs: 5_000,
          authCeremonyTimeoutMs: 5_000,
          passkeyTimeoutMs: 5_000,
          registry: paired,
          resumption: {
            peek: vi.fn(() => ({ holder, verifiedAt: 1_234 })),
            consume: vi.fn(() => ({ holder, verifiedAt: 1_234 })),
            issue: vi.fn(() => ({ token: 'C'.repeat(43), expiresAt: Date.now() + 120_000 })),
          },
          generateChallenge: () => CHALLENGE,
          getPairingOffer: () => null,
          claimPairingOffer: () => false,
          onPairVerifying: vi.fn(),
          onAuthenticating: vi.fn(),
          onPairCompleted: vi.fn(),
          onAuthCompleted: vi.fn(),
          onCeremonyFailed: vi.fn(),
        });
        const challengePromise = nextJson(browser);
        await browser.sendEncryptedJson({
          type: 'pair:hello',
          protocolVersion: 2,
          mode: 'resume',
          deviceId: browserId,
          resumeToken: 'A'.repeat(43),
        });
        const challenge = (await challengePromise) as Record<string, string>;
        if (challenge.type !== 'pair:resume-challenge') return challenge;
        const proof = await signDeviceProof(
          browserKeys.privateKey,
          buildDeviceProof('resume', challenge.challenge!, browser.getChannelBinding())
        );
        const replyPromise = nextJson(browser);
        await browser.sendEncryptedJson({
          type: 'pair:resume-response',
          deviceSignature: encodeBase64(proof),
        });
        return (await replyPromise) as Record<string, string>;
      };

      expect(await resume()).toMatchObject({ type: 'pair:authenticated', deviceId: browserId });
      paired.records.length = 0;
      expect(await resume()).toMatchObject({ type: 'pair:rejected', reason: 'unknown-device' });
    });
  });
});
