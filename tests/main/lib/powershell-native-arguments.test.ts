import { describe, expect, it } from 'vitest';

import {
  escapeNativeArgument,
  escapePowerShellDoubleQuoted,
  escapePowerShellSingleQuoted,
  isPowerShellDoubleQuote,
  isPowerShellSingleQuote,
  powerShellCommandArgs,
  powerShellSingleQuote,
  withLegacyNativeArguments,
} from '../../../src/main/lib/powershell-native-arguments';

describe('PowerShell quoting', () => {
  it('treats typographic quotes as the quotes PowerShell reads them as', () => {
    expect([..."'‘’‚‛"].every(isPowerShellSingleQuote)).toBe(true);
    expect([...'"“”„'].every(isPowerShellDoubleQuote)).toBe(true);
    expect([...'`‹›«»'].some((c) => isPowerShellSingleQuote(c) || isPowerShellDoubleQuote(c))).toBe(
      false
    );
  });

  it('doubles every single quote, typographic ones included', () => {
    expect(escapePowerShellSingleQuoted("it's O’Brien‘s ‚x‛")).toBe("it''s O’’Brien‘‘s ‚‚x‛‛");
    expect(powerShellSingleQuote('C:/Users/O’Brien/komla')).toBe("'C:/Users/O’’Brien/komla'");
  });

  it('backtick-escapes double quotes, typographic ones included, dollars and backticks', () => {
    expect(escapePowerShellDoubleQuoted('say “hi” "$name" `x„')).toBe(
      'say `“hi`” `"`$name`" ``x`„'
    );
  });
});

describe('escapeNativeArgument', () => {
  it('escapes double quotes and the backslashes before them for the C runtime', () => {
    expect(escapeNativeArgument('say "hi"')).toBe(String.raw`say \"hi\"`);
    expect(escapeNativeArgument(String.raw`x a\"b c\\"`)).toBe(String.raw`x a\\\"b c\\\\\"`);
  });

  it('leaves other backslashes alone', () => {
    expect(escapeNativeArgument(String.raw`C:\Users\me`)).toBe(String.raw`C:\Users\me`);
    expect(escapeNativeArgument(String.raw`C:\dir\ `)).toBe(String.raw`C:\dir\ `);
  });

  it('puts whitespace before the first quote so every PowerShell version wraps the argument', () => {
    expect(escapeNativeArgument('"fix it"')).toBe(String.raw` \"fix it\"`);
    expect(escapeNativeArgument('"fixit"')).toBe(String.raw`\"fixit\"`);
  });

  it('keeps a trailing backslash out of the closing quote PowerShell adds', () => {
    expect(escapeNativeArgument('look in C:\\dir\\')).toBe('look in C:\\dir\\ ');
    expect(escapeNativeArgument('C:\\dir\\')).toBe('C:\\dir\\');
  });
});

describe('withLegacyNativeArguments', () => {
  it('pins Legacy argument passing for one command', () => {
    expect(withLegacyNativeArguments('claude "hi"')).toBe(
      `& { $PSNativeCommandArgumentPassing = 'Legacy'; claude "hi" }`
    );
  });
});

describe('powerShellCommandArgs', () => {
  it('passes the script to PowerShell after its shell arguments', () => {
    expect(powerShellCommandArgs('pwsh.exe', ['-NoLogo'], 'claude "hi"')).toEqual([
      '-NoLogo',
      '-Command',
      'claude "hi"',
    ]);
  });

  it('returns null when the command line would exceed the Windows limit', () => {
    expect(powerShellCommandArgs('pwsh.exe', [], 'x'.repeat(32_000))).not.toBeNull();
    expect(powerShellCommandArgs('pwsh.exe', [], 'x'.repeat(33_000))).toBeNull();
  });

  it('counts the escapes node-pty adds for double quotes and backslashes', () => {
    expect(powerShellCommandArgs('pwsh.exe', [], '"'.repeat(17_000))).toBeNull();
    expect(powerShellCommandArgs('pwsh.exe', [], '\\"'.repeat(9_000))).toBeNull();
  });
});
