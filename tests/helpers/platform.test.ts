import { describe, expect, it } from 'vitest';

import { onPlatform, pinPlatform } from './platform';

const host = process.platform;
// A platform no CI runner is, so a pin that sticks can't pass for the host's.
const other: NodeJS.Platform = host === 'aix' ? 'sunos' : 'aix';

describe('pinPlatform', () => {
  it('pins the platform for the rest of the test', () => {
    pinPlatform(other);
    expect(process.platform).toBe(other);
  });

  it("finds the host's platform back in the next test", () => {
    expect(process.platform).toBe(host);
  });
});

describe('onPlatform', () => {
  it('pins the platform while it runs, then puts it back', () => {
    expect(onPlatform(other, () => process.platform)).toBe(other);
    expect(process.platform).toBe(host);
  });

  it('keeps the pin past an await, until the promise settles', async () => {
    const seen = onPlatform(other, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return process.platform;
    });
    expect(process.platform).toBe(other);

    await expect(seen).resolves.toBe(other);
    expect(process.platform).toBe(host);
  });

  it('puts the platform back when it throws or rejects', async () => {
    expect(() =>
      onPlatform(other, () => {
        throw new Error('failed');
      })
    ).toThrow('failed');
    expect(process.platform).toBe(host);

    await expect(onPlatform(other, () => Promise.reject(new Error('rejected')))).rejects.toThrow(
      'rejected'
    );
    expect(process.platform).toBe(host);
  });

  it('leaves a pin made while its promise was pending', async () => {
    let finish!: () => void;
    const pending = onPlatform(other, () => new Promise<void>((resolve) => (finish = resolve)));
    pinPlatform('win32');
    finish();
    await pending;

    expect(process.platform).toBe('win32');
  });

  it('leaves a later pin of the same platform alone', async () => {
    let finish!: () => void;
    const pending = onPlatform(other, () => new Promise<void>((resolve) => (finish = resolve)));
    pinPlatform('win32');
    pinPlatform(other);
    finish();
    await pending;

    expect(process.platform).toBe(other);
  });

  it('keeps the pin past an await for any promise-like result', async () => {
    const thenable = {
      then(resolve: (value: NodeJS.Platform) => void) {
        setTimeout(() => resolve(process.platform), 0);
      },
    };
    const seen = onPlatform(other, () => thenable);
    expect(process.platform).toBe(other);

    await expect(seen).resolves.toBe(other);
    expect(process.platform).toBe(host);
  });

  it('puts back an outer pin, not the host', () => {
    pinPlatform('win32');
    onPlatform('linux', () => undefined);
    expect(process.platform).toBe('win32');
  });
});
