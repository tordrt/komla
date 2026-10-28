import { describe, expect, it } from 'vitest';

import { validateGitIdentity } from '../../../src/shared/lib/git-identity';

describe('validateGitIdentity', () => {
  it('accepts a name and email, ignoring surrounding whitespace', () => {
    expect(validateGitIdentity(' Ada Lovelace ', ' ada@example.com ')).toBeNull();
    expect(validateGitIdentity('Ada', '123+ada@users.noreply.github.com')).toBeNull();
  });

  it.each([
    ['', 'ada@example.com', 'Enter your name for git commits'],
    ['   ', 'ada@example.com', 'Enter your name for git commits'],
    ['Ada', '', 'Enter your email for git commits'],
    ['Ada <ada>', 'ada@example.com', 'Name and email cannot contain <, > or line breaks'],
    ['Ada', 'ada@example.com>', 'Name and email cannot contain <, > or line breaks'],
    ['Ada\nEvil', 'ada@example.com', 'Name and email cannot contain <, > or line breaks'],
    ['a'.repeat(257), 'ada@example.com', 'Name and email must be at most 256 characters'],
    ['Ada', 'ada', 'Enter an email address like you@example.com'],
    ['Ada', 'ada @example.com', 'Enter an email address like you@example.com'],
    ['Ada', '@example.com', 'Enter an email address like you@example.com'],
  ])('rejects name %j with email %j', (name, email, message) => {
    expect(validateGitIdentity(name, email)).toBe(message);
  });
});
