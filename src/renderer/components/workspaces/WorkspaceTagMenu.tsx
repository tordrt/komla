import { Tag } from '@phosphor-icons/react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { tagWorkspaces, useWorkspaceTags, WORKSPACE_TAG_TONE_LABELS } from '@/lib/workspace-tags';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useWorkspaceTagDialogStore } from '@/stores/workspace-tag-dialog.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import {
  findWorkspaceTag,
  MAX_WORKSPACE_TAG_LENGTH,
  MAX_WORKSPACE_TAGS,
  normalizeWorkspaceTagName,
  WORKSPACE_TAG_TONES,
  type WorkspaceTagTone,
} from '../../../shared/lib/workspace-tags';

import { WorkspaceTagBadge } from './WorkspaceTagBadge';

/** The Settings card that lists the tags, which Tag ▸ Edit Tags... opens. */
export const WORKSPACE_TAGS_CARD = 'Workspace tags';

/**
 * Tag ▸ the tags in the list, the one the workspaces share checked, then New Tag..., Remove Tag
 * and Edit Tags...
 */
export function TagSubmenu({
  workspaceIds,
  currentTag,
  anyTagged,
}: {
  workspaceIds: readonly string[];
  /** The tag every one of the workspaces has, if they share one. */
  currentTag: string | undefined;
  /** Some of the workspaces have a tag, so Remove Tag shows. */
  anyTagged: boolean;
}) {
  const tags = useWorkspaceTags();
  const current = currentTag ? findWorkspaceTag(tags, currentTag) : undefined;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Tag />
        Tag
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="max-w-64">
        {tags.map((tag) => (
          <ContextMenuCheckboxItem
            key={tag.name}
            checked={tag === current}
            onClick={() =>
              tag === current
                ? useWorkspacesStore.getState().setTag(workspaceIds, undefined)
                : tagWorkspaces(workspaceIds, tag.name)
            }
          >
            <ToneDot tone={tag.tone} />
            <span className="truncate">{tag.name}</span>
          </ContextMenuCheckboxItem>
        ))}
        {/* A tag missing from the list, such as one an agent set, still shows as checked. */}
        {currentTag && !current && (
          <ContextMenuCheckboxItem
            checked
            onClick={() => useWorkspacesStore.getState().setTag(workspaceIds, undefined)}
          >
            <ToneDot tone="neutral" />
            <span className="truncate">{currentTag}</span>
          </ContextMenuCheckboxItem>
        )}
        {(tags.length > 0 || currentTag) && <ContextMenuSeparator />}
        <ContextMenuItem
          onClick={() => useWorkspaceTagDialogStore.getState().openFor(workspaceIds)}
        >
          New Tag...
        </ContextMenuItem>
        {anyTagged && (
          <ContextMenuItem
            onClick={() => useWorkspacesStore.getState().setTag(workspaceIds, undefined)}
          >
            Remove Tag
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() =>
            useSettingsDialogStore
              .getState()
              .openSettings({ tab: 'general', card: WORKSPACE_TAGS_CARD })
          }
        >
          Edit Tags...
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

/** A tag's color, as a dot before its name in lists. */
export function ToneDot({ tone }: { tone: WorkspaceTagTone }) {
  return (
    <span
      aria-hidden="true"
      className={cn('size-2 shrink-0 rounded-full', WORKSPACE_TAG_TONE_LABELS[tone].dot)}
    />
  );
}

/** Stands in for a tag's dot where filters offer the workspaces without one. */
export function UntaggedDot() {
  return (
    <span
      aria-hidden="true"
      className="size-2 shrink-0 rounded-full border border-muted-foreground"
    />
  );
}

/** The tag colors to pick from, as a row of swatches. */
export function TagToneSwatches({
  value,
  onChange,
  label,
}: {
  value: WorkspaceTagTone;
  onChange: (tone: WorkspaceTagTone) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex items-center gap-1.5">
      {WORKSPACE_TAG_TONES.map((tone) => (
        <button
          key={tone}
          type="button"
          role="radio"
          aria-checked={tone === value}
          aria-label={WORKSPACE_TAG_TONE_LABELS[tone].label}
          title={WORKSPACE_TAG_TONE_LABELS[tone].label}
          onClick={() => onChange(tone)}
          className={cn(
            'flex size-5 items-center justify-center rounded-full ring-offset-background transition-shadow focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden',
            tone === value && 'ring-2 ring-foreground/60 ring-offset-1'
          )}
        >
          <span className={cn('size-3.5 rounded-full', WORKSPACE_TAG_TONE_LABELS[tone].dot)} />
        </button>
      ))}
    </div>
  );
}

/** The New Tag dialog, for every menu's Tag ▸ New Tag... */
export function WorkspaceTagDialogHost() {
  const open = useWorkspaceTagDialogStore((s) => s.open);
  const close = useWorkspaceTagDialogStore((s) => s.close);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="max-w-sm">
        {/* Mounted per opening, so each new tag starts blank. */}
        {open && <NewTagForm onDone={close} />}
      </DialogContent>
    </Dialog>
  );
}

function NewTagForm({ onDone }: { onDone: () => void }) {
  const workspaceIds = useWorkspaceTagDialogStore((s) => s.workspaceIds);
  const tags = useWorkspaceTags();
  const [name, setName] = useState('');
  const [tone, setTone] = useState<WorkspaceTagTone>('neutral');
  const normalized = normalizeWorkspaceTagName(name);
  const existing = normalized ? findWorkspaceTag(tags, normalized) : undefined;
  const full = tags.length >= MAX_WORKSPACE_TAGS;
  const submit = () => {
    if (!normalized) return;
    tagWorkspaces(workspaceIds, normalized, { tone });
    onDone();
  };
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>New Tag</DialogTitle>
        <DialogDescription>
          Says why the workspace waits, such as for a review. It shows on the card while no agent is
          busy there.
        </DialogDescription>
      </DialogHeader>
      <Input
        aria-label="Tag name"
        placeholder="Waiting for design"
        value={name}
        maxLength={MAX_WORKSPACE_TAG_LENGTH}
        onChange={(event) => setName(event.target.value)}
        autoFocus
      />
      {existing ? (
        <p className="text-xs text-muted-foreground">
          Uses the {existing.name} tag you have, with its color.
        </p>
      ) : full ? (
        <p className="text-xs text-muted-foreground">
          You have {MAX_WORKSPACE_TAGS} tags already. Delete one in Settings to add another.
        </p>
      ) : (
        <TagToneSwatches label="Tag color" value={tone} onChange={setTone} />
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!normalized || (!existing && full)}>
          {existing ? 'Tag' : 'Add Tag'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** A workspace's tag, in the attention pill's place while no agent is busy. */
export function WorkspaceTagPill({
  tag,
  fromPullRequest = false,
  tooltip,
  className,
}: {
  tag: string;
  /** Komla put it on from the branch's pull request. */
  fromPullRequest?: boolean;
  /** What a script said about it, shown on hover. */
  tooltip?: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <WorkspaceTagBadge data-workspace-tag tag={tag} className={cn('max-w-32', className)} />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-sm">
        {fromPullRequest ? `${tag}, from the pull request` : `Tagged ${tag}`}
        {tooltip && <span className="text-muted-foreground"> · {tooltip}</span>}
      </TooltipContent>
    </Tooltip>
  );
}
