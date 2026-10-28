import { useConfigStore } from '@/stores/config.store';

import { EditorToolbarButton, useEditorOptions } from './EditorToolbarButton';
import { TargetBranchSelector } from './TargetBranchSelector';
import { UnifiedMenu } from './UnifiedMenu';

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

/**
 * With the status bar turned off, the workspace's branch controls and Open in editor sit at the
 * right of its tab row instead, so push, pull, pull requests and the target branch stay in reach.
 * Open in editor shows even where the bar's menu hid it, since that menu is off screen.
 */
export function TabRowBranchControls() {
  const statusBarHidden = useConfigStore((s) => s.config?.showStatusBar === false);
  return statusBarHidden ? <WorkspaceBranchControls /> : null;
}

/**
 * The selected workspace's branch menus, git progress and Open in editor, for a row that stands in
 * for the status bar.
 */
export function WorkspaceBranchControls() {
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const { allOptions, defaultOption, workspacePath, handleOpen } = useEditorOptions();
  return (
    <div className="flex shrink-0 items-center gap-1 pr-1">
      <UnifiedMenu />
      <TargetBranchSelector />
      {workspacePath && (
        <EditorToolbarButton
          allOptions={allOptions}
          defaultOption={defaultOption}
          noDrag={noDrag}
          onOpen={handleOpen}
          onSetDefault={(id) => void updateConfig({ defaultEditor: id })}
        />
      )}
    </div>
  );
}
