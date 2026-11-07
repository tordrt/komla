import { PencilSimple, Robot, Sparkle, Terminal, Trash } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/icon-button';
import { getActionPreview } from '@/lib/action-menu-order';

import type { Action, AgentPreset } from '@/types';

interface ActionListItemProps {
  action: Action;
  /** Tints the type icon, e.g. with the project's color. */
  iconColor?: string;
  presets: AgentPreset[];
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  deleteDisabled: boolean;
}

export function ActionListItem({
  action,
  iconColor,
  presets,
  onEdit,
  onDelete,
  deleteDisabled,
}: ActionListItemProps) {
  const Icon = action.type === 'command' ? Terminal : Sparkle;
  return (
    <div className="relative flex items-center gap-3 !py-3 transition-colors hover:bg-accent/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-muted-foreground" style={{ color: iconColor }} />
          <p className="truncate text-sm font-medium">{action.title}</p>
          {action.presetId && (
            <PresetBadgeForAction
              presetId={action.presetId}
              launchModeId={action.launchModeId}
              presets={presets}
            />
          )}
        </div>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {getActionPreview(action)}
        </p>
      </div>
      <div className="flex shrink-0 gap-0.5">
        <IconButton label={`Edit ${action.title}`} onClick={() => onEdit(action.id)}>
          <PencilSimple className="size-3.5" />
        </IconButton>
        <IconButton
          label={`Delete ${action.title}`}
          className="hover:text-error"
          onClick={() => onDelete(action.id)}
          disabled={deleteDisabled}
        >
          <Trash className="size-3.5" />
        </IconButton>
      </div>
    </div>
  );
}

function PresetBadgeForAction({
  presetId,
  launchModeId,
  presets,
}: {
  presetId: string;
  launchModeId?: string;
  presets: AgentPreset[];
}) {
  const preset = presets.find((p) => p.id === presetId);
  if (!preset) return null;
  const mode = launchModeId ? preset.launchModes?.find((m) => m.id === launchModeId) : null;
  return (
    <Badge>
      <Robot className="size-2.5" />
      {preset.name}
      {mode ? ` · ${mode.name}` : ''}
    </Badge>
  );
}
