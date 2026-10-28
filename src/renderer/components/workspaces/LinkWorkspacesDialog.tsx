import { CaretDown, CaretRight, CheckSquare, Link, Square } from '@phosphor-icons/react';
import { useEffect, useMemo, useState } from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getProjectColor } from '@/lib/project-colors';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/projects.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { isSshWorkspace, showsRunning, type Workspace } from '@/types';

import { getLinkWorkspacePeers } from './link-workspaces-dialog-utils';

interface PeerGroup {
  key: string;
  label: string;
  color: string;
  icon?: string;
  order: number;
  isDirectoryProject: boolean;
  peers: Workspace[];
}

function getGroupForPeer(
  peer: Workspace,
  projectMap: Map<
    string,
    { name: string; color?: string | null; icon?: string; order: number; kind?: string }
  >
): Omit<PeerGroup, 'peers'> {
  if (peer.projectId) {
    const project = projectMap.get(peer.projectId);
    if (project) {
      return {
        key: `project:${peer.projectId}`,
        label: project.name,
        color: project.color || getProjectColor(project.name),
        icon: project.icon,
        order: project.order,
        isDirectoryProject: project.kind === 'directory',
      };
    }
  }
  if (peer.repoName) {
    return {
      key: `repo:${peer.repoName}`,
      label: peer.repoName,
      color: getProjectColor(peer.repoName),
      order: Number.MAX_SAFE_INTEGER,
      isDirectoryProject: false,
    };
  }
  if (!peer.isWorktree && peer.workingDirectory) {
    const segments = peer.workingDirectory.split(/[\\/]/).filter(Boolean);
    const dirName = segments.pop() || peer.workingDirectory;
    return {
      key: `dir:${dirName}`,
      label: dirName,
      color: peer.color || getProjectColor(dirName),
      order: Number.MAX_SAFE_INTEGER,
      isDirectoryProject: false,
    };
  }
  return {
    key: 'other',
    label: 'Other',
    color: getProjectColor('other'),
    order: Number.MAX_SAFE_INTEGER,
    isDirectoryProject: false,
  };
}

interface LinkWorkspacesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspace: Workspace;
}

export function LinkWorkspacesDialog({ open, onOpenChange, workspace }: LinkWorkspacesDialogProps) {
  const allWorkspaces = useWorkspacesStore((s) => s.workspaces);
  const linkWorkspaces = useWorkspacesStore((s) => s.linkWorkspaces);
  const unlinkWorkspace = useWorkspacesStore((s) => s.unlinkWorkspace);

  const projects = useProjectsStore((s) => s.projects);

  // Keyed by the ids, not the array: every workspaces reload brings a new array, and a new
  // set would reset the selection below while the user is still picking.
  const linkedIdsKey = (workspace.linkedWorkspaceIds ?? []).join('\n');
  const initialLinkedIds = useMemo(
    () => new Set(linkedIdsKey ? linkedIdsKey.split('\n') : []),
    [linkedIdsKey]
  );

  const [selectedIds, setSelectedIds] = useState<Set<string>>(initialLinkedIds);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset selection whenever the dialog re-opens or the workspace changes.
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(initialLinkedIds));
      setCollapsedGroups(new Set());
      setSaveError(null);
    }
  }, [open, initialLinkedIds]);

  const toggleGroupCollapsed = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Group peers by project, mirroring the sidebar's manual order.
  const groups = useMemo<PeerGroup[]>(() => {
    const projectMap = new Map(
      projects.map((p) => [
        p.id,
        { name: p.name, color: p.color, icon: p.icon, order: p.order ?? 0, kind: p.kind },
      ])
    );
    const peers = getLinkWorkspacePeers(allWorkspaces, workspace.id, initialLinkedIds);
    const byKey = new Map<string, PeerGroup>();
    for (const peer of peers) {
      const g = getGroupForPeer(peer, projectMap);
      const existing = byKey.get(g.key);
      if (existing) {
        existing.peers.push(peer);
      } else {
        byKey.set(g.key, {
          key: g.key,
          label: g.label,
          color: g.color,
          icon: g.icon,
          order: g.order,
          isDirectoryProject: g.isDirectoryProject,
          peers: [peer],
        });
      }
    }
    const result = [...byKey.values()];
    for (const group of result) {
      if (group.order === Number.MAX_SAFE_INTEGER) {
        group.order = Math.min(...group.peers.map((peer) => peer.order ?? 0));
      }
    }
    result.sort((a, b) => a.order - b.order);
    for (const group of result) {
      group.peers.sort((a, b) => {
        return (a.order ?? 0) - (b.order ?? 0);
      });
    }
    return result;
  }, [allWorkspaces, workspace.id, projects, initialLinkedIds]);

  const totalCandidates = groups.reduce((sum, g) => sum + g.peers.length, 0);

  const toggle = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleGroup = (ids: string[]): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const shouldSelect = ids.some((id) => !next.has(id));
      for (const id of ids) {
        if (shouldSelect) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  };

  const hasChanges = useMemo(() => {
    if (selectedIds.size !== initialLinkedIds.size) return true;
    for (const id of selectedIds) if (!initialLinkedIds.has(id)) return true;
    return false;
  }, [selectedIds, initialLinkedIds]);

  const selectedCount = selectedIds.size;
  const workspaceLabel = workspace.customName || workspace.name;

  const handleSave = async (): Promise<void> => {
    if (!hasChanges || submitting) return;
    setSubmitting(true);
    setSaveError(null);
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const id of selectedIds) {
      if (!initialLinkedIds.has(id)) toAdd.push(id);
    }
    for (const id of initialLinkedIds) {
      if (!selectedIds.has(id)) toRemove.push(id);
    }
    try {
      for (const id of toRemove) {
        await unlinkWorkspace(workspace.id, id);
      }
      if (toAdd.length > 0) {
        await linkWorkspaces(workspace.id, toAdd);
      }
      onOpenChange(false);
    } catch (error) {
      // Removals may have already applied before the failure. Re-sync the
      // selection from server-side state so the dialog reflects reality and
      // the user can retry without resending operations that already succeeded.
      const message = error instanceof Error ? error.message : 'Failed to update links';
      setSaveError(message);
      const refreshed = await window.api.getWorkspaces();
      const current = refreshed.find((w) => w.id === workspace.id);
      if (current) setSelectedIds(new Set(current.linkedWorkspaceIds ?? []));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 [&>*]:min-w-0">
        <DialogHeader className="border-b border-border px-4 pt-4 pr-12 pb-3">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Link className="h-4 w-4 text-muted-foreground" weight="bold" />
            <span>Link Workspaces</span>
          </DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            Link workspaces so agents can read and edit across them. Komla adds bidirectional
            symlinks {isSshWorkspace(workspace) ? 'on the SSH host ' : ''}under{' '}
            <code className="font-mono text-foreground/80">linked-workspaces/</code>; recursive
            tools that follow symlinks may need this folder excluded.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5 px-4 py-3">
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="shrink-0">From</span>
            <span className="truncate font-medium text-foreground">{workspaceLabel}</span>
            {totalCandidates > 0 && (
              <span className="ml-auto shrink-0">
                {selectedCount} of {totalCandidates} selected
              </span>
            )}
          </div>

          {totalCandidates === 0 ? (
            <p className="py-5 text-center text-xs text-muted-foreground">
              No other active workspaces available to link.
            </p>
          ) : (
            <div className="-mx-2.5 max-h-72 overflow-y-auto overscroll-contain">
              {groups.map((group, idx) => (
                <PeerGroupList
                  key={group.key}
                  label={group.label}
                  color={group.color}
                  icon={group.icon}
                  peers={group.peers}
                  selectedIds={selectedIds}
                  onToggle={toggle}
                  onToggleGroup={toggleGroup}
                  borderTop={idx > 0}
                  collapsed={collapsedGroups.has(group.key)}
                  onToggleCollapsed={() => toggleGroupCollapsed(group.key)}
                  isDirectoryProject={group.isDirectoryProject}
                />
              ))}
            </div>
          )}

          {saveError && (
            <Callout tone="error" size="sm" role="alert">
              {saveError}
            </Callout>
          )}
        </div>

        <DialogFooter className="border-t border-border px-4 py-2.5">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={!hasChanges || submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PeerGroupListProps {
  label: string;
  color: string;
  icon?: string;
  peers: Workspace[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleGroup: (ids: string[]) => void;
  borderTop?: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  isDirectoryProject: boolean;
}

function PeerGroupList({
  label,
  color,
  icon,
  peers,
  selectedIds,
  onToggle,
  onToggleGroup,
  borderTop,
  collapsed,
  onToggleCollapsed,
  isDirectoryProject,
}: PeerGroupListProps) {
  if (peers.length === 0) return null;
  const selectedInGroup = peers.reduce((n, p) => (selectedIds.has(p.id) ? n + 1 : n), 0);
  if (isDirectoryProject) {
    const checked = selectedInGroup === peers.length;
    return (
      <div className={cn(borderTop && 'border-t border-border')}>
        <button
          type="button"
          onClick={() => onToggleGroup(peers.map((peer) => peer.id))}
          className={cn(
            'light-darken flex w-full items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-muted/50',
            selectedInGroup > 0 && 'bg-accent/20'
          )}
          style={{ color }}
        >
          {checked ? (
            <CheckSquare className="h-3.5 w-3.5 shrink-0 text-foreground" weight="fill" />
          ) : (
            <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <ProjectMark project={{ color, icon }} dotClassName="size-1.5" iconClassName="size-3" />
          <span className="min-w-0 flex-1 truncate text-left font-medium">{label}</span>
          <span className="flex shrink-0 items-center gap-1 text-2xs font-normal text-muted-foreground">
            {selectedInGroup > 0 && <Link className="h-3 w-3" weight="bold" />}
            {selectedInGroup > 0 ? `${selectedInGroup}/${peers.length}` : peers.length}
          </span>
        </button>
      </div>
    );
  }
  return (
    <div className={cn(borderTop && 'border-t border-border')}>
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-expanded={!collapsed}
        className="light-darken flex w-full items-center gap-1.5 px-2.5 py-1 text-ui font-medium hover:bg-muted/50"
        style={{ color }}
      >
        {collapsed ? (
          <CaretRight className="h-3 w-3 shrink-0 opacity-70" weight="bold" />
        ) : (
          <CaretDown className="h-3 w-3 shrink-0 opacity-70" weight="bold" />
        )}
        <ProjectMark project={{ color, icon }} dotClassName="size-1.5" iconClassName="size-3" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <span className="text-2xs font-normal text-muted-foreground">
          {selectedInGroup > 0 ? `${selectedInGroup}/${peers.length}` : peers.length}
        </span>
      </button>
      {collapsed ? null : (
        <ul className="divide-y divide-border">
          {peers.map((peer) => {
            const checked = selectedIds.has(peer.id);
            const displayName = peer.customName || peer.name;
            const isRunning = showsRunning(peer);
            return (
              <li key={peer.id}>
                <button
                  type="button"
                  onClick={() => onToggle(peer.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent/50',
                    checked && 'bg-accent/20'
                  )}
                >
                  {checked ? (
                    <CheckSquare className="h-3.5 w-3.5 shrink-0 text-foreground" weight="fill" />
                  ) : (
                    <Square className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span
                    aria-label={isRunning ? 'Running' : 'Stopped'}
                    className={cn(
                      'h-1.5 w-1.5 shrink-0 rounded-full',
                      isRunning ? 'bg-success' : 'bg-muted-foreground/35'
                    )}
                    title={isRunning ? 'Running' : 'Stopped'}
                  />
                  <span className="min-w-0 flex-1 truncate">{displayName}</span>
                  {peer.branchName && (
                    <span className="max-w-[45%] min-w-0 shrink truncate text-ui text-muted-foreground">
                      {peer.branchName}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
