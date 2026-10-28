import { describe, it, expect } from 'vitest';

import {
  sanitizeBranchSuffix,
  sanitizeBranchName,
  sanitizeWorktreeProjectSegment,
  generateBranchSuffix,
  branchSuffixToName,
} from '../../../src/shared/lib/random-names';

describe('sanitizeBranchSuffix', () => {
  it('should convert to lowercase and hyphenate', () => {
    expect(sanitizeBranchSuffix('Add OAuth Login')).toBe('add-oauth-login');
  });

  it('should replace special characters with hyphens', () => {
    expect(sanitizeBranchSuffix('fix: crash on nav!')).toBe('fix-crash-on-nav');
  });

  it('should collapse multiple hyphens', () => {
    expect(sanitizeBranchSuffix('fix---multiple---hyphens')).toBe('fix-multiple-hyphens');
  });

  it('should trim leading and trailing hyphens', () => {
    expect(sanitizeBranchSuffix('-leading-and-trailing-')).toBe('leading-and-trailing');
  });

  it('should truncate to 50 characters', () => {
    const long = 'a'.repeat(60);
    expect(sanitizeBranchSuffix(long).length).toBe(50);
  });

  it('should return empty string for whitespace-only input', () => {
    expect(sanitizeBranchSuffix('   ')).toBe('');
  });

  it('should return empty string for empty input', () => {
    expect(sanitizeBranchSuffix('')).toBe('');
  });

  it('should handle mixed case and numbers', () => {
    expect(sanitizeBranchSuffix('Add OAuth2 Support')).toBe('add-oauth2-support');
  });
});

describe('generateBranchSuffix', () => {
  it('should return a string with adjective-noun format', () => {
    const suffix = generateBranchSuffix();
    expect(suffix).toMatch(/^[a-z]+-[a-z]+$/);
  });
});

describe('sanitizeWorktreeProjectSegment', () => {
  it('replaces whitespace runs with a single hyphen', () => {
    expect(sanitizeWorktreeProjectSegment('My Cool Project')).toBe('My-Cool-Project');
    expect(sanitizeWorktreeProjectSegment('My  Cool   Project')).toBe('My-Cool-Project');
  });

  it('preserves Unicode characters and original casing', () => {
    expect(sanitizeWorktreeProjectSegment('Müller App')).toBe('Müller-App');
    expect(sanitizeWorktreeProjectSegment('日本語 プロジェクト')).toBe('日本語-プロジェクト');
  });

  it('replaces path separators and Windows-invalid characters with hyphens', () => {
    expect(sanitizeWorktreeProjectSegment('foo/bar')).toBe('foo-bar');
    expect(sanitizeWorktreeProjectSegment('foo\\bar')).toBe('foo-bar');
    expect(sanitizeWorktreeProjectSegment('a:b*c?d|e<f>g"h')).toBe('a-b-c-d-e-f-g-h');
  });

  it('strips null bytes and control characters', () => {
    expect(sanitizeWorktreeProjectSegment('foo\u0000bar\u0007')).toBe('foobar');
  });

  it('trims leading/trailing dots and hyphens', () => {
    expect(sanitizeWorktreeProjectSegment('.hidden')).toBe('hidden');
    expect(sanitizeWorktreeProjectSegment('--name--')).toBe('name');
    expect(sanitizeWorktreeProjectSegment('.. dots ..')).toBe('dots');
  });

  it('falls back to "project" when sanitization empties the string', () => {
    expect(sanitizeWorktreeProjectSegment('')).toBe('project');
    expect(sanitizeWorktreeProjectSegment('   ')).toBe('project');
    expect(sanitizeWorktreeProjectSegment('..')).toBe('project');
    expect(sanitizeWorktreeProjectSegment('///')).toBe('project');
  });

  it('prefixes Windows-reserved device names so they remain creatable', () => {
    expect(sanitizeWorktreeProjectSegment('CON')).toBe('_CON');
    expect(sanitizeWorktreeProjectSegment('nul')).toBe('_nul');
    expect(sanitizeWorktreeProjectSegment('COM1')).toBe('_COM1');
    expect(sanitizeWorktreeProjectSegment('LPT9')).toBe('_LPT9');
    // Reserved names with extensions are also blocked on Windows
    expect(sanitizeWorktreeProjectSegment('con.txt')).toBe('_con.txt');
    expect(sanitizeWorktreeProjectSegment('AUX.log.bak')).toBe('_AUX.log.bak');
  });

  it('does not prefix names that merely start with a reserved word', () => {
    expect(sanitizeWorktreeProjectSegment('console')).toBe('console');
    expect(sanitizeWorktreeProjectSegment('com10')).toBe('com10');
    expect(sanitizeWorktreeProjectSegment('LPT-server')).toBe('LPT-server');
  });
});

describe('sanitizeBranchName', () => {
  it('should replace spaces with hyphens', () => {
    expect(sanitizeBranchName('is this a branch name?')).toBe('is-this-a-branch-name');
  });

  it('should preserve slashes for namespaced branches', () => {
    expect(sanitizeBranchName('feature/my-branch')).toBe('feature/my-branch');
  });

  it('should handle prefix-style names', () => {
    expect(sanitizeBranchName('komla/fix login bug')).toBe('komla/fix-login-bug');
  });

  it('should collapse consecutive dots', () => {
    expect(sanitizeBranchName('feature..name')).toBe('feature.name');
  });

  it('should strip trailing .lock from final component', () => {
    expect(sanitizeBranchName('branch.lock')).toBe('branch');
  });

  it('should strip .lock from intermediate path components', () => {
    expect(sanitizeBranchName('foo.lock/bar')).toBe('foo/bar');
  });

  it('should remove leading/trailing dots and hyphens from path components', () => {
    expect(sanitizeBranchName('.hidden/-branch')).toBe('hidden/branch');
  });

  it('should collapse consecutive slashes', () => {
    expect(sanitizeBranchName('feature//name')).toBe('feature/name');
  });

  it('should handle special characters', () => {
    expect(sanitizeBranchName('fix~bug^ref:test')).toBe('fix-bug-ref-test');
  });

  it('should return empty string for all-invalid input', () => {
    expect(sanitizeBranchName('???')).toBe('');
  });

  it('should preserve case', () => {
    expect(sanitizeBranchName('Feature/MyBranch')).toBe('Feature/MyBranch');
  });

  it('should preserve lone @ in branch names', () => {
    expect(sanitizeBranchName('release@2.0')).toBe('release@2.0');
  });

  it('should strip the @{ sequence', () => {
    expect(sanitizeBranchName('branch@{0}')).toBe('branch-0');
  });
});

describe('branchSuffixToName', () => {
  it('should convert hyphenated suffix to title case', () => {
    expect(branchSuffixToName('swift-fox')).toBe('Swift Fox');
  });
});
