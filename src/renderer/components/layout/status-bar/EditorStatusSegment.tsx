import { CaretDown } from '@phosphor-icons/react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useConfigStore } from '@/stores/config.store';

import {
  EditorIcon,
  EditorMenuItems,
  editorTooltipLabel,
  useEditorOptions,
} from '../EditorToolbarButton';

import { StatusBarButton } from './StatusBarButton';

/** Opens the workspace in the default editor or file manager; the caret picks another. */
export function EditorStatusSegment() {
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const { allOptions, defaultOption, workspacePath, handleOpen } = useEditorOptions();
  if (!workspacePath) return null;
  const label = editorTooltipLabel(defaultOption);
  const hasChoices = allOptions.length > 1;

  return (
    <div className="flex shrink-0 items-center">
      <StatusBarButton
        aria-label={label}
        tooltip={label}
        className={hasChoices ? 'rounded-r-none pr-1' : undefined}
        onClick={() => handleOpen()}
      >
        <EditorIcon option={defaultOption} className="size-3.5" />
      </StatusBarButton>
      {hasChoices && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <StatusBarButton
              aria-label="Open with"
              tooltip="Open with"
              className="rounded-l-none px-0.5"
            >
              <CaretDown className="size-2.5" />
            </StatusBarButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start">
            <EditorMenuItems
              allOptions={allOptions}
              defaultOption={defaultOption}
              onOpen={handleOpen}
              onSetDefault={(id) => void updateConfig({ defaultEditor: id })}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
