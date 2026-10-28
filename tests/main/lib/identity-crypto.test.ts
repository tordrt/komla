// This file deliberately does NOT mock 'electron'. Its purpose is to lock in
// that src/main/lib/identity-crypto.ts is a pure-Node module with zero
// Electron coupling — see the verifier reusability claim in the service. If a
// future edit accidentally adds an Electron import to that file, either the
// runtime tests below will break (no electronMock to intercept) or the
// source-level guard at the bottom will fail.

import { generateKeyPairSync, sign as cryptoSign } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { describe, expect, it } from 'vitest';

import { isP256Key, verifySignature } from '../../../src/main/lib/identity-crypto';

describe('identity-crypto (pure-Node module)', () => {
  it('verifies a real P-256 sign/verify round trip with no Electron context', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('out-of-band payload');
    const signature = cryptoSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' });

    expect(verifySignature(data, signature, publicKeyDer)).toBe(true);
  });

  it('rejects a signature made with a different P-256 keypair', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { publicKey: otherPub } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('payload');
    const signature = cryptoSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const otherPubDer = otherPub.export({ format: 'der', type: 'spki' });

    expect(verifySignature(data, signature, otherPubDer)).toBe(false);
  });

  it('rejects garbage SPKI bytes without throwing', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const data = Buffer.from('payload');
    const signature = cryptoSign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' });

    expect(verifySignature(data, signature, Buffer.from('not-a-key'))).toBe(false);
  });

  it('isP256Key returns true for P-256 and false for other algorithms/curves', () => {
    const { publicKey: p256 } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { publicKey: p384 } = generateKeyPairSync('ec', { namedCurve: 'P-384' });
    const { publicKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });

    expect(isP256Key(p256)).toBe(true);
    expect(isP256Key(p384)).toBe(false);
    expect(isP256Key(rsa)).toBe(false);
  });

  it('module source contains no Electron imports (purity contract)', () => {
    // Vitest runs with cwd at the repo root, so a project-relative path is
    // stable across machines without needing __dirname / import.meta gymnastics.
    const source = readFileSync(resolve('src/main/lib/identity-crypto.ts'), 'utf8');

    expect(source).not.toMatch(/from\s+['"]electron['"]/);
    expect(source).not.toMatch(/require\s*\(\s*['"]electron['"]\s*\)/);
    // Dynamic import — closes the most realistic accidental-coupling vector
    // beyond the static import/require forms above.
    expect(source).not.toMatch(/import\s*\(\s*['"]electron['"]\s*\)/);
  });
});
