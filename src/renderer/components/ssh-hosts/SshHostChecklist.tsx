import { CheckCircle, Warning, XCircle } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';

import { getLocalMirrorDisabledReason, tmuxUpgradeRecommended } from './ssh-host-draft';

import type { SshHostSetupResult } from '@/types';
import type { ReactNode } from 'react';

type Tone = 'ok' | 'warning' | 'error';

interface CheckItem {
  label: string;
  tone: Tone;
  detail: ReactNode;
}

function installHint(pkg: string) {
  return (
    <>
      Install it with the host&apos;s package manager, for example{' '}
      <code className="font-mono">sudo apt install {pkg}</code>,{' '}
      <code className="font-mono">sudo dnf install {pkg}</code> or{' '}
      <code className="font-mono">brew install {pkg}</code>.
    </>
  );
}

function checkItems(result: SshHostSetupResult): CheckItem[] {
  const items: CheckItem[] = [];

  items.push(
    result.git.status === 'available'
      ? { label: 'Git', tone: 'ok', detail: `${result.git.version ?? 'Git'} is installed.` }
      : {
          label: 'Git',
          tone: 'error',
          detail: <>Git is required and is not installed. {installHint('git')}</>,
        }
  );

  if (result.tmux.status === 'available') {
    items.push(
      tmuxUpgradeRecommended(result.tmux.version)
        ? {
            label: 'tmux',
            tone: 'warning',
            detail: `${result.tmux.version ?? 'tmux'} works, but 3.4 or later is recommended. Older versions drop the file links agents print, so a long path may not open when clicked.`,
          }
        : {
            label: 'tmux',
            tone: 'ok',
            detail: `${result.tmux.version ?? 'tmux'} keeps remote terminals running when you disconnect.`,
          }
    );
  } else {
    items.push({
      label: 'tmux',
      tone: 'error',
      detail:
        result.tmux.status === 'unusable' ? (
          `${result.tmux.version ?? 'tmux'} is installed but is not working. tmux is required; repair it, then check again.`
        ) : (
          <>
            tmux is required and is not installed. It keeps agents running when you disconnect.{' '}
            {installHint('tmux')}
          </>
        ),
    });
  }

  if (result.monitoring) {
    items.push(
      result.monitoring.status === 'available'
        ? { label: 'Utilities', tone: 'ok', detail: 'The tools Komla runs on the host are there.' }
        : {
            label: 'Utilities',
            tone: 'error',
            detail: (
              <>
                Missing{' '}
                <code className="font-mono">
                  {result.monitoring.missingRequirements.join(', ')}
                </code>
                . Install them with the host&apos;s package manager, then check again.
              </>
            ),
          }
    );
  }

  if (result.localMirror.platform === 'supported') {
    const reason = getLocalMirrorDisabledReason(result);
    items.push(
      reason
        ? {
            label: 'Local copies',
            tone: 'warning',
            detail: (
              <>
                Optional: {reason} Install it wherever it is missing to use local copies, for
                example <code className="font-mono">sudo apt install rsync</code> or{' '}
                <code className="font-mono">brew install rsync</code>.
              </>
            ),
          }
        : { label: 'Local copies', tone: 'ok', detail: 'rsync is on both computers.' }
    );
  }

  if (result.gitIdentity && !result.gitIdentity.configured) {
    items.push({
      label: 'Git identity',
      tone: 'warning',
      detail: result.localGitIdentity?.configured ? (
        <>
          Not set on the host. Setup sets it to{' '}
          <code className="font-mono">
            {result.localGitIdentity.userName} &lt;{result.localGitIdentity.userEmail}&gt;
          </code>
          .
        </>
      ) : (
        <>
          Not set on the host. Set <code className="font-mono">git config --global user.name</code>{' '}
          and <code className="font-mono">user.email</code> there before committing.
        </>
      ),
    });
  }

  return items;
}

const TONE_ICONS: Record<Tone, ReactNode> = {
  ok: <CheckCircle weight="fill" className="size-4 text-success" />,
  warning: <Warning weight="fill" className="size-4 text-warning" />,
  error: <XCircle weight="fill" className="size-4 text-error" />,
};

const TONE_NAMES: Record<Tone, string> = { ok: 'Ready', warning: 'Note', error: 'Needs fixing' };

/** What a check found on an SSH host, one row per requirement. */
export function SshHostChecklist({ result }: { result: SshHostSetupResult }) {
  return (
    <ul aria-label="Check results" className="divide-y divide-border/60 rounded-lg border">
      {checkItems(result).map((item) => (
        <li key={item.label} className="flex gap-2.5 px-3 py-2">
          <span className="mt-px shrink-0" role="img" aria-label={TONE_NAMES[item.tone]}>
            {TONE_ICONS[item.tone]}
          </span>
          <div className="min-w-0 text-xs leading-relaxed">
            <span className="font-medium text-foreground">{item.label}</span>
            <p
              className={cn('text-muted-foreground', item.tone === 'error' && 'text-foreground/90')}
            >
              {item.detail}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
