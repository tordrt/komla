import { describe, expect, it } from 'vitest';

import { validateProjectCreation } from '../../../../src/renderer/components/projects/validate-project-creation';

const baseArgs = {
  mode: 'local' as const,
  isNewRepo: false,
  newProjectName: '',
  projectPath: '',
  remoteUrl: '',
  isCheckingOriginRemote: false,
};

describe('validateProjectCreation', () => {
  describe('local + new repo', () => {
    it('requires a project name', () => {
      expect(validateProjectCreation({ ...baseArgs, isNewRepo: true, newProjectName: '   ' })).toBe(
        'Project name is required'
      );
    });

    it('accepts a non-empty trimmed name', () => {
      expect(
        validateProjectCreation({ ...baseArgs, isNewRepo: true, newProjectName: '  my-project  ' })
      ).toBeNull();
    });
  });

  describe('local folder', () => {
    it('requires a folder path', () => {
      expect(validateProjectCreation({ ...baseArgs, projectPath: '   ' })).toBe(
        'Folder path is required'
      );
    });

    it('blocks submission while origin remote check is in flight', () => {
      expect(
        validateProjectCreation({
          ...baseArgs,
          projectPath: '/repo',
          isCheckingOriginRemote: true,
        })
      ).toBe('Checking repository remotes. Try again in a moment.');
    });

    it('accepts a valid path once the remote check has resolved', () => {
      expect(validateProjectCreation({ ...baseArgs, projectPath: '/repo' })).toBeNull();
    });
  });

  describe('remote clone', () => {
    it('requires a remote URL', () => {
      expect(validateProjectCreation({ ...baseArgs, mode: 'remote', remoteUrl: '   ' })).toBe(
        'Remote URL is required'
      );
    });

    it('rejects a URL that is neither http(s) nor ssh', () => {
      expect(
        validateProjectCreation({ ...baseArgs, mode: 'remote', remoteUrl: 'ftp://foo/bar.git' })
      ).toBe('Enter a valid Git URL (https:// or git@)');
    });

    it('accepts https URLs', () => {
      expect(
        validateProjectCreation({
          ...baseArgs,
          mode: 'remote',
          remoteUrl: 'https://github.com/u/r.git',
        })
      ).toBeNull();
    });

    it('accepts ssh URLs', () => {
      expect(
        validateProjectCreation({
          ...baseArgs,
          mode: 'remote',
          remoteUrl: 'git@github.com:u/r.git',
        })
      ).toBeNull();
    });
  });
});
