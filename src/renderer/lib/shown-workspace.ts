import { useWorkspacesStore } from '@/stores/workspaces.store';

/**
 * Tells main which workspace this window shows, so it can refresh the git status of the others,
 * which only their sidebar cards show, less often. Returns the unsubscribe function.
 */
export function reportShownWorkspace(): () => void {
  let reported: string | null | undefined;
  const report = ({
    selectedWorkspaceId,
    showDashboard,
  }: ReturnType<typeof useWorkspacesStore.getState>) => {
    // The overview shows every workspace.
    const shown = showDashboard ? null : selectedWorkspaceId;
    if (shown === reported) return;
    reported = shown;
    window.api.setShownWorkspace(shown);
  };
  report(useWorkspacesStore.getState());
  return useWorkspacesStore.subscribe(report);
}
