import { FolderOpen, GitDiff } from '@phosphor-icons/react';

import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { useConfigStore } from '@/stores/config.store';

export function FilesTab() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  return (
    <div className="space-y-6">
      <SettingsCard title="File tree">
        <SettingsRow
          label="Show file tree by default"
          description="Open the inline file tree panel when creating new workspaces"
        >
          <Switch
            checked={config?.defaultFileTreeOpen === true}
            onCheckedChange={async (checked) => {
              await updateConfig({
                defaultFileTreeOpen: checked,
              });
            }}
          />
        </SettingsRow>
        <SettingsRow label="Default mode" description="Initial file tree mode for new workspaces">
          <SegmentedControl
            aria-label="Default mode"
            size="md"
            value={config?.defaultFileTreeMode === 'browse' ? 'browse' : 'diff'}
            onValueChange={(mode) => updateConfig({ defaultFileTreeMode: mode })}
            options={[
              { value: 'diff', label: 'Diff', icon: <GitDiff className="size-3.5" /> },
              { value: 'browse', label: 'Browse', icon: <FolderOpen className="size-3.5" /> },
            ]}
          />
        </SettingsRow>
        <SettingsRow
          label="Show changes since target branch by default"
          description="Show all changes on the current branch since it diverged from the target branch"
        >
          <Switch
            checked={config?.defaultCompareTargetBranch === true}
            onCheckedChange={async (checked) => {
              await updateConfig({ defaultCompareTargetBranch: checked });
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="Live follow by default"
          description="Auto-navigate to the latest changed file in diff mode"
        >
          <Switch
            checked={config?.defaultLiveFollow === true}
            onCheckedChange={async (checked) => {
              await updateConfig({ defaultLiveFollow: checked });
            }}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Search">
        <SettingsRow
          label="Open search results in"
          description="Where files from the search picker open. Hold Shift for the other view."
        >
          <SegmentedControl
            aria-label="Open search results in"
            size="md"
            value={config?.defaultSearchOpenMode || 'current'}
            onValueChange={(mode) => updateConfig({ defaultSearchOpenMode: mode })}
            options={[
              { value: 'current', label: 'Current view' },
              { value: 'viewer', label: 'Full screen' },
              { value: 'preview', label: 'Workspace view' },
            ]}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Editor">
        <SettingsRow label="Vim mode" description="Use vim keybindings in the file viewer editor">
          <Switch
            checked={config?.vimModeEnabled === true}
            onCheckedChange={async (checked) => {
              await updateConfig({ vimModeEnabled: checked });
            }}
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Browser preview">
        <SettingsRow
          label="Auto reload"
          description="Reload browser previews by default when Komla detects workspace changes"
        >
          <Switch
            checked={config?.defaultDevServerPreviewAutoReload !== false}
            onCheckedChange={async (checked) => {
              await updateConfig({
                defaultDevServerPreviewAutoReload: checked,
              });
            }}
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
