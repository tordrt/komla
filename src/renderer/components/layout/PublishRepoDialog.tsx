import { GithubLogo, Globe, Lock } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';

type Tab = 'github' | 'url';

interface GhAuthState {
  checked: boolean;
  authenticated: boolean;
  installed: boolean;
  username?: string;
  checkError?: string;
}

interface PublishRepoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoPath: string;
  repoName: string;
  /** Why the project needs a remote; defaults to pushing code from the git menu. */
  description?: string;
  /** The repo has an origin with none of its branches, which publishing replaces. */
  replacesOrigin?: boolean;
  onPublished: () => void;
}

function getGhTabTooltip(ghAuth: GhAuthState): string | undefined {
  if (!ghAuth.checked) return 'Checking...';
  if (ghAuth.checkError) return "Couldn't check the GitHub CLI";
  if (!ghAuth.installed) return 'GitHub CLI not installed';
  if (!ghAuth.authenticated) return 'Not authenticated';
  return undefined;
}

function UrlTabHint({ ghAuth }: { ghAuth: GhAuthState }) {
  if (!ghAuth.checked) return null;
  if (ghAuth.checkError) {
    return (
      <p className="text-xs text-muted-foreground">
        Couldn&apos;t check the GitHub CLI: {ghAuth.checkError}
      </p>
    );
  }
  if (!ghAuth.installed) {
    return (
      <p className="text-xs text-muted-foreground">
        Install the{' '}
        <a
          href="https://cli.github.com"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-foreground"
        >
          GitHub CLI
        </a>{' '}
        to create repos directly from here.
      </p>
    );
  }
  if (!ghAuth.authenticated) {
    return (
      <p className="text-xs text-muted-foreground">
        Run <code className="rounded bg-muted px-1.5 py-0.5 text-xs">gh auth login</code> to create
        repos directly from here.
      </p>
    );
  }
  return null;
}

interface GithubTabPanelProps {
  ghAuth: GhAuthState;
  ghRepoName: string;
  setGhRepoName: (value: string) => void;
  isPrivate: boolean;
  setIsPrivate: (value: boolean) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

function GithubTabPanel({
  ghAuth,
  ghRepoName,
  setGhRepoName,
  isPrivate,
  setIsPrivate,
  onKeyDown,
  inputRef,
}: GithubTabPanelProps) {
  if (!ghAuth.authenticated) return null;
  return (
    <>
      {ghAuth.username && (
        <p className="text-xs text-muted-foreground">
          Signed in as <span className="font-medium text-foreground">{ghAuth.username}</span>
        </p>
      )}
      <div className="space-y-2">
        <label htmlFor="gh-repo-name" className="block text-sm font-medium">
          Repository name
        </label>
        <Input
          ref={inputRef}
          id="gh-repo-name"
          value={ghRepoName}
          onChange={(e) => setGhRepoName(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="my-repo"
          autoComplete="off"
        />
      </div>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {isPrivate ? (
            <Lock className="size-4 text-muted-foreground" />
          ) : (
            <Globe className="size-4 text-muted-foreground" />
          )}
          <span className="text-sm">{isPrivate ? 'Private' : 'Public'}</span>
        </div>
        <button
          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => setIsPrivate(!isPrivate)}
        >
          {isPrivate ? 'Make public' : 'Make private'}
        </button>
      </div>
    </>
  );
}

function CheckingGhStatus() {
  return (
    <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
      <Spinner />
      Checking GitHub CLI&hellip;
    </div>
  );
}

function UrlTabPanel({
  ghAuth,
  remoteUrl,
  setRemoteUrl,
  onKeyDown,
  inputRef,
}: {
  ghAuth: GhAuthState;
  remoteUrl: string;
  setRemoteUrl: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor="remote-url" className="block text-sm font-medium">
        Remote URL
      </label>
      <Input
        ref={inputRef}
        id="remote-url"
        value={remoteUrl}
        onChange={(e) => setRemoteUrl(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="https://github.com/user/repo.git"
        autoComplete="off"
      />
      <p className="text-xs text-muted-foreground">
        Create the repository on your Git host first. Its URL will be added as &quot;origin&quot;,
        and you can then push your branch.
      </p>
      <UrlTabHint ghAuth={ghAuth} />
    </div>
  );
}

export function PublishRepoDialog({
  open,
  onOpenChange,
  repoPath,
  repoName,
  replacesOrigin = false,
  description = replacesOrigin
    ? 'The origin remote has none of these branches, so nothing is published yet. Publishing replaces it.'
    : 'No remote is configured. Add a remote to push your code.',
  onPublished,
}: PublishRepoDialogProps) {
  // null while the gh auth check runs and the user hasn't picked a tab yet.
  const [tab, setTab] = useState<Tab | null>(null);
  const [ghRepoName, setGhRepoName] = useState(repoName);
  const [isPrivate, setIsPrivate] = useState(true);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [ghAuth, setGhAuth] = useState<GhAuthState>({
    checked: false,
    authenticated: false,
    installed: false,
  });

  const inputRef = useRef<HTMLInputElement>(null);

  // Check gh CLI auth on open
  useEffect(() => {
    if (open) {
      setGhRepoName(repoName);
      setRemoteUrl('');
      setError('');
      setIsSubmitting(false);
      setGhAuth({ checked: false, authenticated: false, installed: false });
      setTab(null);

      // Never move the user off a tab they already picked while this ran.
      let cancelled = false;
      window.api
        .checkGhAuth()
        .then((result) => {
          if (cancelled) return;
          setGhAuth({ checked: true, ...result });
          setTab((current) => current ?? (result.authenticated ? 'github' : 'url'));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setGhAuth({
            checked: true,
            authenticated: false,
            installed: false,
            checkError: err instanceof Error ? err.message : String(err),
          });
          setTab((current) => current ?? 'url');
        });

      return () => {
        cancelled = true;
      };
    }
  }, [open, repoName]);

  // Re-focus input when tab changes
  useEffect(() => {
    if (open) {
      const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
      return () => window.clearTimeout(timer);
    }
  }, [tab, open]);

  const handleCreateGithubRepo = async () => {
    if (!ghRepoName.trim()) return;
    setIsSubmitting(true);
    setError('');

    const result = await window.api.createGithubRepo(repoPath, ghRepoName.trim(), isPrivate);
    setIsSubmitting(false);

    if (result.success) {
      onOpenChange(false);
      onPublished();
    } else {
      setError(result.message);
    }
  };

  const handleAddRemoteUrl = async () => {
    if (!remoteUrl.trim()) return;
    setIsSubmitting(true);
    setError('');

    const result = await window.api.addOriginRemote(repoPath, remoteUrl.trim());
    setIsSubmitting(false);

    if (result.success) {
      onOpenChange(false);
      onPublished();
    } else {
      setError(result.message);
    }
  };

  const handleSubmit = () => {
    if (tab === 'github') {
      void handleCreateGithubRepo();
    } else {
      void handleAddRemoteUrl();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  const canSubmit =
    tab === 'github'
      ? ghAuth.authenticated && ghRepoName.trim().length > 0
      : remoteUrl.trim().length > 0;

  const ghAvailable = ghAuth.checked && ghAuth.authenticated;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish Repository</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Tab switcher */}
        <SegmentedControl<Tab | ''>
          aria-label="Publish method"
          size="md"
          fill
          value={tab ?? ''}
          onValueChange={(value) => value && setTab(value)}
          options={[
            {
              value: 'github',
              label: 'GitHub',
              icon: <GithubLogo className="size-4" />,
              disabled: !ghAvailable,
              title: getGhTabTooltip(ghAuth),
            },
            { value: 'url', label: 'Remote URL', icon: <Globe className="size-4" /> },
          ]}
        />

        <div className="space-y-4 py-1">
          {tab === null && <CheckingGhStatus />}
          {tab === 'github' && (
            <GithubTabPanel
              ghAuth={ghAuth}
              ghRepoName={ghRepoName}
              setGhRepoName={setGhRepoName}
              isPrivate={isPrivate}
              setIsPrivate={setIsPrivate}
              onKeyDown={handleKeyDown}
              inputRef={inputRef}
            />
          )}
          {tab === 'url' && (
            <UrlTabPanel
              ghAuth={ghAuth}
              remoteUrl={remoteUrl}
              setRemoteUrl={setRemoteUrl}
              onKeyDown={handleKeyDown}
              inputRef={inputRef}
            />
          )}

          {error && (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit || isSubmitting}>
            {isSubmitting ? (
              <>
                <Spinner className="mr-2" />
                {tab === 'github' ? 'Creating...' : 'Adding...'}
              </>
            ) : tab === 'github' ? (
              'Create & Push'
            ) : (
              'Add Remote'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
