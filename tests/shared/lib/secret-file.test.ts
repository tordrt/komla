import { describe, expect, it } from 'vitest';

import { secretFileNames, secretFileProblem } from '../../../src/shared/lib/secret-file';

describe('secretFileProblem', () => {
  it.each(['.env', '.env.local', 'apps/web/.env', './.env', 'config/secrets.yml'])(
    'takes %s',
    (file) => expect(secretFileProblem(file)).toBeUndefined()
  );

  it.each([
    [undefined, /Name the file/],
    ['', /Name the file/],
    ['   ', /Name the file/],
    ['/etc/passwd', /inside the workspace/],
    ['C:/Users/me/.env', /inside the workspace/],
    ['c:.env', /inside the workspace/],
    ['../.env', /without \.\./],
    ['apps/../../.ssh/authorized_keys', /without \.\./],
    ['apps\\web\\.env', /Separate folders with \//],
    ['.git/hooks/pre-commit', /inside \.git/],
    ['.GIT/config', /inside \.git/],
    ['sub/.Git/config', /inside \.git/],
    ['.git./config', /inside \.git/],
    ['GIT~1/config', /inside \.git/],
    ['apps/web/', /Name a file/],
    ['.', /Name a file/],
    ['a\0b', /character/],
    ['a'.repeat(1025), /too long/],
  ])('refuses %j', (file, problem) => expect(secretFileProblem(file)).toMatch(problem));
});

describe('secretFileNames', () => {
  it('lists the names a .env file sets, once each, without values or comments', () => {
    expect(
      secretFileNames(
        [
          'API_KEY=sk-123',
          '  export DATABASE_URL = postgres://user:pass@host/db',
          '# COMMENTED=1',
          'API_KEY=again',
          'MULTI="line one',
          'line two"',
          'not a line',
          'dotted.name=1',
        ].join('\r\n')
      )
    ).toEqual(['API_KEY', 'DATABASE_URL', 'MULTI', 'dotted.name']);
  });
});
