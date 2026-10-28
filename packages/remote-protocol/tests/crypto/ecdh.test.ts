import { describe, it, expect } from 'vitest';

import {
  deriveSessionKey,
  generateEphemeralKeyPair,
  importPeerPublicKey,
} from '../../src/crypto/ecdh';
import { decrypt, DIRECTION_DESKTOP_TO_CLIENT, encrypt } from '../../src/crypto/aead';

describe('ECDH + HKDF', () => {
  it('both peers derive identical session keys from matching ephemerals', async () => {
    const client = await generateEphemeralKeyPair();
    const desktop = await generateEphemeralKeyPair();

    const clientImportedPeer = await importPeerPublicKey(desktop.publicKey);
    const desktopImportedPeer = await importPeerPublicKey(client.publicKey);

    const clientKey = await deriveSessionKey({
      myPrivateKey: client.privateKey,
      peerPublicKey: clientImportedPeer,
      clientEphemPubKey: client.publicKey,
      desktopEphemPubKey: desktop.publicKey,
    });
    const desktopKey = await deriveSessionKey({
      myPrivateKey: desktop.privateKey,
      peerPublicKey: desktopImportedPeer,
      clientEphemPubKey: client.publicKey,
      desktopEphemPubKey: desktop.publicKey,
    });

    // Round-trip a frame to prove the keys are byte-identical without
    // exporting them (they're non-extractable by design).
    const plaintext = new TextEncoder().encode('hello');
    const { nonce, ciphertext } = await encrypt(
      clientKey,
      DIRECTION_DESKTOP_TO_CLIENT,
      0,
      plaintext
    );
    const decrypted = await decrypt(desktopKey, nonce, ciphertext);
    expect(new TextDecoder().decode(decrypted)).toBe('hello');
  });

  it('different salt order produces different session keys', async () => {
    // The HKDF salt is `clientEphem ‖ desktopEphem` — the same byte order the
    // desktop signs in `e2e:answer`. If a side computed `desktop ‖ client`
    // instead, the keys would differ. This test pins that contract: a swap
    // breaks decryption.
    const client = await generateEphemeralKeyPair();
    const desktop = await generateEphemeralKeyPair();
    const peerOnClient = await importPeerPublicKey(desktop.publicKey);
    const peerOnDesktop = await importPeerPublicKey(client.publicKey);

    const correctKey = await deriveSessionKey({
      myPrivateKey: client.privateKey,
      peerPublicKey: peerOnClient,
      clientEphemPubKey: client.publicKey,
      desktopEphemPubKey: desktop.publicKey,
    });
    const swappedKey = await deriveSessionKey({
      myPrivateKey: desktop.privateKey,
      peerPublicKey: peerOnDesktop,
      clientEphemPubKey: desktop.publicKey, // swapped
      desktopEphemPubKey: client.publicKey, // swapped
    });

    const { nonce, ciphertext } = await encrypt(
      correctKey,
      DIRECTION_DESKTOP_TO_CLIENT,
      0,
      new TextEncoder().encode('hi')
    );
    await expect(decrypt(swappedKey, nonce, ciphertext)).rejects.toThrow();
  });

  it('exported ephemeral public key is the fixed P-256 SPKI shape (91 bytes)', async () => {
    // Lock in the assumption the brief's "plain concat, no length prefix"
    // depends on. If WebCrypto in some runtime ever returns a variable length
    // here, this test catches it before the signed-material byte layout
    // becomes ambiguous.
    const pair = await generateEphemeralKeyPair();
    expect(pair.publicKey.length).toBe(91);
  });
});
