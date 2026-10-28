import { describe, expect, it } from 'vitest';

import { mayPromptWithoutTap, passkeyErrorMessage, signInRejection } from '../passkey-sign-in';

describe('mayPromptWithoutTap', () => {
  it('asks on its own only right after a tap on a page in front', () => {
    const tapped = {
      visibilityState: 'visible',
      hasFocus: true,
      userActivationActive: true,
    } as const;
    expect(mayPromptWithoutTap(tapped)).toBe(true);
    expect(mayPromptWithoutTap({ ...tapped, userActivationActive: false })).toBe(false);
    // A browser that can't say whether there was a tap gets the Unlock button.
    expect(mayPromptWithoutTap({ ...tapped, userActivationActive: undefined })).toBe(false);
    expect(mayPromptWithoutTap({ ...tapped, hasFocus: false })).toBe(false);
    expect(mayPromptWithoutTap({ ...tapped, visibilityState: 'hidden' })).toBe(false);
  });
});

describe('passkeyErrorMessage', () => {
  it('explains the browser errors a passkey request ends with', () => {
    const named = (name: string) => Object.assign(new Error('raw'), { name });
    expect(passkeyErrorMessage(named('NotAllowedError'))).toMatch(/cancelled or timed out/);
    expect(passkeyErrorMessage(named('AbortError'))).toMatch(/cancelled or timed out/);
    expect(passkeyErrorMessage(named('SecurityError'))).toMatch(/link you paired with/);
    expect(passkeyErrorMessage(named('InvalidStateError'))).toMatch(/couldn't use the passkey/);
    expect(passkeyErrorMessage(new Error('Send failed'))).toBe('Send failed');
    expect(passkeyErrorMessage('nope')).toBe('The passkey request failed.');
  });
});

describe('signInRejection', () => {
  it('offers another try unless the device must pair again', () => {
    expect(signInRejection('internal', 'ceremony timeout')).toEqual({
      message: 'Komla stopped waiting for your passkey.',
      retry: true,
    });
    expect(signInRejection('signature-failed', 'bad signature')).toMatchObject({ retry: true });
    expect(signInRejection('busy', 'another device is using remote control')).toEqual({
      message: 'Another device is using remote control.',
      retry: true,
    });
    expect(signInRejection('unknown-device', 'this browser installation is not paired')).toEqual({
      message: 'This browser installation is not paired.',
      retry: false,
    });
  });
});
