import { describe, expect, it } from 'vitest';

import { RemoteSessionResumptionStore } from '../../../src/main/lib/remote-session-resumption';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const holder = (deviceId: string) => ({
  deviceId,
  devicePublicKey: `key-${deviceId}`,
  credentialId: 'cred-1',
});

function store(now: () => number, tokenByte = () => 0x41, windowMs = () => 2 * MINUTE) {
  return new RemoteSessionResumptionStore({
    generateToken: () => new Uint8Array(32).fill(tokenByte()),
    now,
    ttlMs: windowMs,
    maxAgeMs: 8 * HOUR,
  });
}

describe('RemoteSessionResumptionStore', () => {
  it('issues single-use grants and consumes them for only the bound device', () => {
    const grants = store(() => 1_000);

    const grant = grants.issue(holder('device-a'));
    grants.release(grant.token);
    expect(grant.token).toHaveLength(43);
    expect(grant.expiresAt).toBe(1_000 + 8 * HOUR);
    expect(grants.consume('device-b', grant.token)).toBeNull();
    expect(grants.consume('device-a', grant.token)?.verifiedAt).toBe(1_000);
    expect(grants.consume('device-a', grant.token)).toBeNull();
  });

  it('peeks at a grant without using it up', () => {
    const grants = store(() => 1_000);
    const grant = grants.issue(holder('device-a'));
    grants.release(grant.token);

    expect(grants.peek('device-b', grant.token)).toBeNull();
    expect(grants.peek('device-a', grant.token)?.verifiedAt).toBe(1_000);
    expect(grants.peek('device-a', grant.token)?.verifiedAt).toBe(1_000);
    expect(grants.consume('device-a', grant.token)?.verifiedAt).toBe(1_000);
    expect(grants.peek('device-a', grant.token)).toBeNull();
  });

  it('applies a changed window to grants already handed out', () => {
    let now = 1_000;
    let windowMs = 2 * MINUTE;
    const grants = store(
      () => now,
      () => 0x41,
      () => windowMs
    );
    const grant = grants.issue(holder('device-a'));
    grants.release(grant.token);

    now += 10 * MINUTE;
    windowMs = 15 * MINUTE;
    expect(grants.peek('device-a', grant.token)?.verifiedAt).toBe(1_000);
    windowMs = 5 * MINUTE;
    expect(grants.peek('device-a', grant.token)).toBeNull();
  });

  it('keeps a grant usable for two minutes after its connection ends, however long it lasted', () => {
    let now = 1_000;
    const grants = store(() => now);
    const grant = grants.issue(holder('device-a'));

    now += 45 * MINUTE;
    grants.release(grant.token);
    now += 2 * MINUTE - 1;

    expect(grants.consume('device-a', grant.token)?.verifiedAt).toBe(1_000);
  });

  it('rejects and removes grants two minutes after their connection ends', () => {
    let now = 1_000;
    const grants = store(() => now);
    const grant = grants.issue(holder('device-a'));
    grants.release(grant.token);

    now += 2 * MINUTE;
    expect(grants.consume('device-a', grant.token)).toBeNull();
    now = 1_000;
    expect(grants.consume('device-a', grant.token)).toBeNull();
  });

  it('redeems a grant whose connection has not noticed it dropped, once', () => {
    // The desktop ends that connection when it promotes the one that redeemed the grant.
    const grants = store(() => 1_000);
    const grant = grants.issue(holder('device-a'));

    expect(grants.consume('device-a', grant.token)?.verifiedAt).toBe(1_000);
    grants.release(grant.token);
    expect(grants.consume('device-a', grant.token)).toBeNull();
  });

  it('ends silent resumption eight hours after the last passkey verification', () => {
    let now = 1_000;
    const grants = store(() => now);
    const first = grants.issue(holder('device-a'));
    now += 8 * HOUR - 5 * MINUTE;
    grants.release(first.token);
    now += MINUTE;
    const verifiedAt = grants.consume('device-a', first.token)?.verifiedAt;
    expect(verifiedAt).toBe(1_000);

    // A resumed connection carries the original verification time forward.
    const second = grants.issue(holder('device-a'), verifiedAt!);
    expect(second.expiresAt).toBe(1_000 + 8 * HOUR);
    now += 3 * MINUTE;
    grants.release(second.token);
    now += MINUTE;
    expect(grants.consume('device-a', second.token)).toBeNull();
  });

  it("hands back the grant's holder, so the resume checks that browser's key", () => {
    const grants = store(() => 1_000);
    const grant = grants.issue(holder('device-a'));

    expect(grants.peek('device-a', grant.token)).toEqual({
      holder: holder('device-a'),
      verifiedAt: 1_000,
    });
  });

  it('revokes the grants of every browser signed in with a removed passkey', () => {
    let tokenByte = 1;
    const grants = store(
      () => 1_000,
      () => tokenByte++
    );
    const first = grants.issue(holder('device-a'));
    const second = grants.issue(holder('device-b'));
    const other = grants.issue({ ...holder('device-c'), credentialId: 'cred-2' });
    grants.release(first.token);
    grants.release(second.token);

    grants.revokeCredential('cred-1');
    expect(grants.consume('device-a', first.token)).toBeNull();
    expect(grants.consume('device-b', second.token)).toBeNull();
    expect(grants.consume('device-c', other.token)?.verifiedAt).toBe(1_000);
  });
});
