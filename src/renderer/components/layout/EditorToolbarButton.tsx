import { ArrowSquareOut, CaretDown, FolderOpen } from '@phosphor-icons/react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace } from '@/types';

import { TITLE_BAR_ICON_BUTTON_CLASS } from './title-bar-metrics';

/** The editors and file manager the selected workspace can open in, with the default first choice. */
export function useEditorOptions() {
  const selectedWorkspace = useWorkspacesStore((s) =>
    s.selectedWorkspaceId ? s.workspaces.find((w) => w.id === s.selectedWorkspaceId) : null
  );
  const config = useConfigStore((s) => s.config);
  const [availableEditors, setAvailableEditors] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    window.api
      .getAvailableEditors()
      .then(setAvailableEditors)
      .catch(() => {});
  }, []);

  const finderLabel =
    window.api.platform === 'darwin'
      ? 'Finder'
      : window.api.platform === 'win32'
        ? 'Explorer'
        : 'Files';
  const finderOption = { id: 'finder', name: finderLabel };
  const allOptions = [...availableEditors, finderOption];
  const defaultOption = allOptions.find((e) => e.id === config?.defaultEditor) ?? allOptions[0];
  // SSH workspaces have an ssh:// working directory that local editors and file managers can't open.
  const workspacePath =
    selectedWorkspace && !isSshWorkspace(selectedWorkspace)
      ? selectedWorkspace.workingDirectory
      : undefined;

  const handleOpen = useCallback(
    (optionId?: string) => {
      if (!workspacePath) return;
      const id = optionId ?? defaultOption.id;
      if (id === 'finder') {
        window.api.showItemInFolder(workspacePath);
      } else {
        void window.api.openInEditor(id, workspacePath);
      }
    },
    [workspacePath, defaultOption]
  );

  return { allOptions, defaultOption, workspacePath, handleOpen };
}

export interface EditorOption {
  id: string;
  name: string;
}

interface EditorToolbarButtonProps {
  allOptions: EditorOption[];
  defaultOption: EditorOption;
  noDrag: React.CSSProperties;
  onOpen: (optionId?: string) => void;
  onSetDefault: (id: string) => void;
  /** Overrides the title bar's foreground icon color, e.g. to match muted neighbors. */
  className?: string;
}

export function editorTooltipLabel(option: EditorOption): string {
  if (option.id === 'finder') return `Show in ${option.name}`;
  return `Open in ${option.name}`;
}

export function EditorIcon({
  option,
  className = 'size-4',
}: {
  option: EditorOption;
  className?: string;
}) {
  if (option.id === 'finder') return <FolderOpen className={className} />;
  return <ArrowSquareOut className={className} />;
}

/** Open with each choice, then make another one the default. */
export function EditorMenuItems({
  allOptions,
  defaultOption,
  onOpen,
  onSetDefault,
}: Pick<EditorToolbarButtonProps, 'allOptions' | 'defaultOption' | 'onOpen' | 'onSetDefault'>) {
  return (
    <>
      {allOptions.map((option) => (
        <DropdownMenuItem key={option.id} onClick={() => onOpen(option.id)}>
          {option.name}
          {option.id === defaultOption.id && (
            <span className="ml-auto text-xs text-muted-foreground">default</span>
          )}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      {allOptions
        .filter((e) => e.id !== defaultOption.id)
        .map((option) => (
          <DropdownMenuItem key={`default-${option.id}`} onClick={() => onSetDefault(option.id)}>
            Set {option.name} as default
          </DropdownMenuItem>
        ))}
    </>
  );
}

export function EditorToolbarButton({
  allOptions,
  defaultOption,
  noDrag,
  onOpen,
  onSetDefault,
  className = TITLE_BAR_ICON_BUTTON_CLASS,
}: EditorToolbarButtonProps) {
  const tooltip = editorTooltipLabel(defaultOption);
  if (allOptions.length === 1) {
    return (
      <IconButton
        label={tooltip}
        className={className}
        style={noDrag}
        onClick={(e) => {
          e.preventDefault();
          onOpen();
        }}
      >
        <EditorIcon option={defaultOption} />
      </IconButton>
    );
  }
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="no-drag flex items-center" style={noDrag}>
            <Button
              variant="ghost"
              size="icon"
              className={cn('no-drag size-7 rounded-r-none', className)}
              aria-label={tooltip}
              onClick={(e) => {
                e.preventDefault();
                onOpen();
              }}
            >
              <EditorIcon option={defaultOption} />
            </Button>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Open with"
                className="no-drag flex h-7 w-3 items-center justify-center rounded-r text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <CaretDown className="size-2.5" />
              </button>
            </DropdownMenuTrigger>
          </div>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <EditorMenuItems
          allOptions={allOptions}
          defaultOption={defaultOption}
          onOpen={onOpen}
          onSetDefault={onSetDefault}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
