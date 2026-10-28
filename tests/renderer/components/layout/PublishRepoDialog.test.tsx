/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PublishRepoDialog } from '../../../../src/renderer/components/layout/PublishRepoDialog';

type GhAuth = { authenticated: boolean; installed: boolean; username?: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const checkGhAuth = vi.fn<[], Promise<GhAuth>>();

function renderDialog() {
  return render(
    <PublishRepoDialog
      open
      onOpenChange={vi.fn()}
      repoPath="/repo"
      repoName="repo"
      onPublished={vi.fn()}
    />
  );
}

describe('PublishRepoDialog', () => {
  beforeEach(() => {
    checkGhAuth.mockReset();
    window.api = {
      ...window.api,
      checkGhAuth,
      createGithubRepo: vi.fn(),
      addOriginRemote: vi.fn(),
    } as typeof window.api;
  });

  it('shows a loading state while the GitHub CLI check runs', () => {
    checkGhAuth.mockReturnValue(new Promise(() => {}));
    renderDialog();

    expect(screen.getByText(/checking github cli/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Remote URL')).not.toBeInTheDocument();
  });

  it('falls back to Remote URL with a hint when the check fails', async () => {
    const check = deferred<GhAuth>();
    checkGhAuth.mockReturnValue(check.promise);
    renderDialog();

    await act(async () => {
      check.reject(new Error('spawn gh ENOENT'));
      await check.promise.catch(() => {});
    });

    expect(screen.queryByText(/checking github cli/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Remote URL')).toBeInTheDocument();
    expect(screen.getByText(/couldn't check the github cli/i)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /github/i })).not.toHaveAttribute(
      'title',
      'Checking...'
    );
  });

  it('switches to GitHub when authenticated and the user has not chosen a tab', async () => {
    const check = deferred<GhAuth>();
    checkGhAuth.mockReturnValue(check.promise);
    renderDialog();

    await act(async () => {
      check.resolve({ authenticated: true, installed: true, username: 'octo' });
      await check.promise;
    });

    expect(screen.getByLabelText('Repository name')).toBeInTheDocument();
  });

  it('switches the publish method with the arrow keys', async () => {
    checkGhAuth.mockResolvedValue({ authenticated: true, installed: true, username: 'octo' });
    renderDialog();

    // The radio renders before the auth check resolves, so wait for it to become checked.
    const github = await screen.findByRole('radio', { name: /github/i, checked: true });

    fireEvent.keyDown(github, { key: 'ArrowRight' });

    expect(screen.getByRole('radio', { name: /remote url/i })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByLabelText('Remote URL')).toBeInTheDocument();
  });

  it('does not switch tabs after the user picked Remote URL during the check', async () => {
    const check = deferred<GhAuth>();
    checkGhAuth.mockReturnValue(check.promise);
    renderDialog();

    fireEvent.click(screen.getByRole('radio', { name: /remote url/i }));
    fireEvent.change(screen.getByLabelText('Remote URL'), {
      target: { value: 'git@github.com:me/repo.git' },
    });

    await act(async () => {
      check.resolve({ authenticated: true, installed: true, username: 'octo' });
      await check.promise;
    });

    expect(screen.getByLabelText('Remote URL')).toHaveValue('git@github.com:me/repo.git');
    expect(screen.queryByLabelText('Repository name')).not.toBeInTheDocument();
  });

  it('shows submit errors in an error callout', async () => {
    checkGhAuth.mockResolvedValue({ authenticated: false, installed: true });
    vi.mocked(window.api.addOriginRemote).mockResolvedValue({
      success: false,
      message: 'remote origin already exists',
    });
    renderDialog();

    fireEvent.change(await screen.findByLabelText('Remote URL'), {
      target: { value: 'https://example.com/repo.git' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add Remote' }));
    });

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('remote origin already exists');
    expect(error.className).toContain('bg-error/10');
    expect(error.className).not.toMatch(/red-\d/);
  });
});
