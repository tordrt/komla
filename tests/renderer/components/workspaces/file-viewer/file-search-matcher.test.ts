import { describe, expect, it } from 'vitest';

import { matchFilePath } from '../../../../../src/renderer/components/workspaces/file-viewer/file-search-matcher';

describe('file-search-matcher', () => {
  it('matches shorthand subsequence queries like pservice', () => {
    const result = matchFilePath('project.service.ts', 'pservice');
    expect(result).not.toBeNull();
    expect(result?.fileNameMatches.length).toBeGreaterThan(0);
  });

  it('is case-insensitive', () => {
    const lower = matchFilePath('project.service.ts', 'project');
    const mixed = matchFilePath('project.service.ts', 'ProJect');

    expect(lower).not.toBeNull();
    expect(mixed).not.toBeNull();
    expect(mixed?.fileNameMatches).toEqual(lower?.fileNameMatches);
  });

  it('scores basename-heavy matches above path-only matches', () => {
    const basenameHit = matchFilePath('src/main/services/project.service.ts', 'pservice');
    const pathOnlyHit = matchFilePath('services/src/main/project.ts', 'sms');

    expect(basenameHit).not.toBeNull();
    expect(pathOnlyHit).not.toBeNull();
    expect(basenameHit?.score ?? 0).toBeGreaterThan(pathOnlyHit?.score ?? 0);
  });

  it('returns path highlight ranges when match is in directory path', () => {
    const result = matchFilePath('src/main/services/project.service.ts', 'sms');
    expect(result).not.toBeNull();
    expect(result?.pathMatches.length).toBeGreaterThan(0);
  });

  it('prefers basename matching so first query chars highlight in filename', () => {
    const result = matchFilePath('src/project.service.ts', 'ps');
    expect(result).not.toBeNull();
    expect(result?.fileNameMatches.length).toBeGreaterThan(0);
    expect(result?.fileNameMatches[0]?.[0]).toBe(0);
  });

  it('returns null when query cannot be matched in order', () => {
    expect(matchFilePath('project.service.ts', 'zqx')).toBeNull();
  });
});
