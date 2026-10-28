import { CaretDown, CaretUp, Copy } from '@phosphor-icons/react';
import { useLayoutEffect, useRef, useState } from 'react';

import { rowRefs, type CommitGraphRefRoles } from '@/components/commit-graph/commit-graph-layout';
import { splitCommitMessage } from '@/components/commit-graph/commit-message';
import { CommitRefPill } from '@/components/commit-graph/CommitRefPill';
import { copyCommitHash } from '@/components/commit-graph/copy-commit-hash';
import { cn } from '@/lib/utils';

import { DiffStatsPills } from './DiffStatsPills';

import type { CommitGraphCommit } from '../../../../shared/types/commit-graph';
import type { CommitDiff } from '@/types';

interface CommitDetailsPanelProps {
  /** The commit as the list read it; a commit opened from beyond the loaded list has only its diff's. */
  commit: CommitGraphCommit | undefined;
  commitDiff: CommitDiff | null;
  roles: CommitGraphRefRoles;
  onSelectCommit: (hash: string) => void;
}

/**
 * A commit's body, folded to its first paragraph and at most three lines of it while it has more,
 * so the diff stays in view.
 */
function CommitBody({ body }: { body: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [leadOverflows, setLeadOverflows] = useState(false);
  const lead = body.split('\n\n')[0];

  // Measured folded only: unfolded, the body always fits.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setLeadOverflows(element.scrollHeight > element.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);
  const folds = leadOverflows || lead !== body;

  return (
    <div className="mt-2.5 max-w-3xl">
      <p
        ref={ref}
        className={cn(
          'text-xs leading-5 break-words whitespace-pre-line text-foreground/80',
          !expanded && 'line-clamp-3'
        )}
      >
        {expanded ? body : lead}
      </p>
      {folds && (
        <button
          type="button"
          aria-expanded={expanded}
          className="mt-1 flex items-center gap-1 rounded-sm text-2xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Show less' : 'Show more'}
          {expanded ? (
            <CaretUp aria-hidden="true" className="size-2.5" />
          ) : (
            <CaretDown aria-hidden="true" className="size-2.5" />
          )}
        </button>
      )}
    </div>
  );
}

/** The selected commit in History: its message, who made it when, its hash and parents, and what it changed. */
export function CommitDetailsPanel({
  commit,
  commitDiff,
  roles,
  onSelectCommit,
}: CommitDetailsPanelProps) {
  const shown: CommitGraphCommit | null = commit ?? commitDiff?.commit ?? null;
  if (!shown) return null;
  const { title, body } = splitCommitMessage(shown.message);
  const refs = rowRefs(shown, roles);
  const summary = commitDiff?.commit.hash === shown.hash ? commitDiff.summary : null;

  return (
    <section
      aria-label="Commit"
      className="thin-scrollbar max-h-[40vh] shrink-0 overflow-y-auto border-b px-4 py-3 select-text"
    >
      <div className="flex items-start gap-3">
        <h2 className="min-w-0 flex-1 text-sm leading-5 font-medium break-words">
          {title || '(no message)'}
        </h2>
        {summary && (
          <span className="flex shrink-0 items-center gap-1 text-xs leading-5 text-muted-foreground">
            {summary.filesChanged === 1 ? '1 file' : `${summary.filesChanged} files`}
            <DiffStatsPills additions={summary.additions} deletions={summary.deletions} />
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
        <span>{shown.author}</span>
        <span aria-hidden="true">·</span>
        <span>
          {new Date(shown.timestamp * 1000).toLocaleString(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
          })}
        </span>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          aria-label={`Copy commit hash ${shown.hash}`}
          title="Copy hash"
          className="flex items-center gap-1 rounded-sm font-mono hover:text-foreground"
          onClick={() => copyCommitHash(shown.hash)}
        >
          {shown.hash.slice(0, 7)}
          <Copy aria-hidden="true" className="size-3" />
        </button>
        {shown.parentHashes.length > 0 && (
          <>
            <span aria-hidden="true">·</span>
            {/* A merge's changes are shown against its first parent. */}
            <span>{shown.parentHashes.length > 1 ? 'Parents' : 'Parent'}</span>
            {shown.parentHashes.map((parent) => (
              <button
                key={parent}
                type="button"
                title="Show this commit"
                className="rounded-sm font-mono underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => onSelectCommit(parent)}
              >
                {parent.slice(0, 7)}
              </button>
            ))}
          </>
        )}
        {refs.map((gitRef) => (
          <CommitRefPill
            key={`${gitRef.kind}:${gitRef.name}`}
            gitRef={gitRef}
            className="ml-0.5 max-w-48"
          />
        ))}
      </div>
      {/* Keyed, so each commit starts folded. */}
      {body && <CommitBody key={shown.hash} body={body} />}
    </section>
  );
}
