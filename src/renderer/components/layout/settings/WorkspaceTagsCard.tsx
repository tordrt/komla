import { ImageSquare, Trash, X } from '@phosphor-icons/react';
import { useRef, useState } from 'react';

import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ActivitySpinner, StillActivityGlyph } from '@/components/workspaces/activity-spinners';
import { TagGlyph } from '@/components/workspaces/WorkspaceTagBadge';
import { TagToneSwatches, WORKSPACE_TAGS_CARD } from '@/components/workspaces/WorkspaceTagMenu';
import { cn } from '@/lib/utils';
import {
  deleteWorkspaceTag,
  PULL_REQUEST_TAG_STATE_LABELS,
  pullRequestTaggingDescription,
  saveWorkspaceTags,
  updateWorkspaceTag,
  useWorkspaceTags,
} from '@/lib/workspace-tags';
import { useConfigStore } from '@/stores/config.store';
import { useToastStore } from '@/stores/toast.store';

import {
  findWorkspaceTag,
  isWorkspaceTagIcon,
  MAX_WORKSPACE_TAG_LENGTH,
  MAX_WORKSPACE_TAGS,
  normalizeWorkspaceTagName,
  withWorkspaceTag,
  type WorkspaceTagDefinition,
} from '../../../../shared/lib/workspace-tags';
import { MAX_STATUS_ICON_BYTES } from '../../../../shared/types/status-items';

/** The tags a workspace's Tag menu offers: their names, colors, and whether a prompt ends them. */
export function WorkspaceTagsCard() {
  const tags = useWorkspaceTags();
  const tagsFromPullRequests = useConfigStore((s) => s.config?.tagsFromPullRequests === true);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const [newName, setNewName] = useState('');
  const normalized = normalizeWorkspaceTagName(newName);
  const canAdd =
    !!normalized && !findWorkspaceTag(tags, normalized) && tags.length < MAX_WORKSPACE_TAGS;
  return (
    <SettingsCard
      title={WORKSPACE_TAGS_CARD}
      description="Tag a workspace from its menu to say why it waits, such as for a review. The tag shows on its card while no agent is busy there."
    >
      {tags.map((tag) => (
        <TagRow key={tag.name} tag={tag} />
      ))}
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canAdd) return;
          saveWorkspaceTags(withWorkspaceTag(tags, normalized));
          setNewName('');
        }}
      >
        <Input
          aria-label="New tag name"
          placeholder="New tag"
          value={newName}
          maxLength={MAX_WORKSPACE_TAG_LENGTH}
          onChange={(event) => setNewName(event.target.value)}
          className="h-8 max-w-60"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!canAdd}>
          Add Tag
        </Button>
      </form>
      <SettingsRow label="Tag from pull requests" description={pullRequestTaggingDescription(tags)}>
        <Switch
          checked={tagsFromPullRequests}
          onCheckedChange={(checked) => void updateConfig({ tagsFromPullRequests: checked })}
        />
      </SettingsRow>
    </SettingsCard>
  );
}

function TagRow({ tag }: { tag: WorkspaceTagDefinition }) {
  const [name, setName] = useState(tag.name);
  const rename = () => {
    if (normalizeWorkspaceTagName(name) === tag.name) return;
    const { error } = updateWorkspaceTag(tag.name, { name });
    if (error) {
      useToastStore.getState().addToast(error, 'error');
      setName(tag.name);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex max-w-60 min-w-40 flex-1 flex-col gap-1">
        <Input
          aria-label="Tag name"
          value={name}
          maxLength={MAX_WORKSPACE_TAG_LENGTH}
          onChange={(event) => setName(event.target.value)}
          onBlur={rename}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') setName(tag.name);
          }}
          className="h-8"
        />
        {tag.pullRequestState && (
          <span className="pl-1 text-2xs text-muted-foreground">
            {PULL_REQUEST_TAG_STATE_LABELS[tag.pullRequestState]}
          </span>
        )}
      </div>
      <TagToneSwatches
        label={`${tag.name} color`}
        value={tag.tone}
        onChange={(tone) => updateWorkspaceTag(tag.name, { tone })}
      />
      <TagLookButtons tag={tag} />
      <IconButton
        label={`Delete ${tag.name}`}
        className="ml-auto"
        onClick={() => deleteWorkspaceTag(tag.name)}
      >
        <Trash />
      </IconButton>
    </div>
  );
}

const ICON_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

/** An image file as the base64 data URL a tag keeps, or why it can't be one. */
async function tagIconFromFile(file: File): Promise<{ icon?: string; error?: string }> {
  const type = ICON_TYPES[file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()];
  if (!type || file.size === 0 || file.size > MAX_STATUS_ICON_BYTES) {
    return {
      error: `Tag icons are SVG, PNG, WebP, GIF or JPEG files of at most ${MAX_STATUS_ICON_BYTES / 1024} KB.`,
    };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const icon = `data:${type};base64,${btoa(binary)}`;
  return isWorkspaceTagIcon(icon) ? { icon } : { error: "Couldn't read that icon." };
}

/** The icon and spinner a tag shows in place of the tag glyph. */
function TagLookButtons({ tag }: { tag: WorkspaceTagDefinition }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-0.5">
      <input
        ref={input}
        type="file"
        accept=".svg,.png,.webp,.gif,.jpg,.jpeg"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          void tagIconFromFile(file).then(({ icon, error }) => {
            if (error) useToastStore.getState().addToast(error, 'error');
            else updateWorkspaceTag(tag.name, { icon });
          });
        }}
      />
      <IconButton
        label={tag.icon ? `Change ${tag.name} icon` : `Choose an icon for ${tag.name}`}
        onClick={() => input.current?.click()}
      >
        {tag.icon ? <TagGlyph tag={{ icon: tag.icon }} className="size-4" /> : <ImageSquare />}
      </IconButton>
      {tag.icon && (
        <IconButton
          label={`Remove ${tag.name} icon`}
          size="xs"
          onClick={() => updateWorkspaceTag(tag.name, { icon: undefined })}
        >
          <X />
        </IconButton>
      )}
      <IconButton
        label={tag.spinner ? `Stop ${tag.name} spinning` : `Show a spinner on ${tag.name}`}
        aria-pressed={tag.spinner === true}
        className={cn(!tag.spinner && 'text-muted-foreground')}
        onClick={() => updateWorkspaceTag(tag.name, { spinner: tag.spinner ? undefined : true })}
      >
        {/* Still while off, so the button doesn't read as loading. */}
        {tag.spinner ? (
          <ActivitySpinner className="size-4" />
        ) : (
          <StillActivityGlyph className="size-4" />
        )}
      </IconButton>
    </div>
  );
}
