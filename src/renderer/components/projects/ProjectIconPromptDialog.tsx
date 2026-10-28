import { type ReactNode, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ColorPicker } from '@/components/ui/color-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { GroupHeaderIcon } from '@/components/workspaces/GroupHeaderIcon';
import { PROJECT_PANEL_CLASS } from '@/components/workspaces/project-panel';
import { useIconColors } from '@/hooks/useIconColors';
import { getProjectColor, resolvePickedColor } from '@/lib/project-colors';
import { cn } from '@/lib/utils';
import { useAgentSetupNudgeStore } from '@/stores/agent-setup-nudge.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useToastStore } from '@/stores/toast.store';
import { useWindowStore } from '@/stores/window.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';
import { canPromptForProjectIcon } from '@/types';

import { ProjectIconPicker } from './ProjectIconPicker';

import type { Project, ProjectIconCandidate } from '@/types';

interface IconPrompt {
  project: Project;
  candidates: ProjectIconCandidate[];
}

/**
 * A project without an icon, such as a clone that had no files to look in when it was added,
 * offers the icons found in its files at its next new workspace, once. `blocked` holds
 * it back while another dialog, such as New Workspace, is still open.
 */
export function ProjectIconPromptDialog({ blocked = false }: { blocked?: boolean }) {
  const [prompts, setPrompts] = useState<IconPrompt[]>([]);
  const [icon, setIcon] = useState<string | null>(null);
  const [pickedColor, setPickedColor] = useState('');
  const saveRef = useRef<HTMLButtonElement>(null);
  const nudgeOpen = useAgentSetupNudgeStore((s) => s.open);
  const updateProject = useProjectsStore((s) => s.updateProject);
  const addToast = useToastStore((s) => s.addToast);
  const prompt = prompts[0];
  const selectedIcon = prompt ? (icon ?? prompt.candidates[0].dataUrl) : '';
  const iconColors = useIconColors(selectedIcon);
  // The project as it is now, since its color may have changed while the prompt waited.
  const liveProject = useProjectsStore((s) => s.projects.find((p) => p.id === prompt?.project.id));

  useEffect(() => {
    // Main clears a project's flag for the first window that asks, so each asks once.
    const asked = new Set<string>();
    const check = () => {
      const pending = useProjectsStore
        .getState()
        .projects.filter((project) => project.iconPromptWorkspaceId && !asked.has(project.id));
      if (pending.length === 0) return;
      const { workspaces } = useWorkspacesStore.getState();
      const { windowId } = useWindowStore.getState();
      for (const project of pending) {
        // The window showing the workspace asks, not one in the background.
        const workspace = workspaces.find(
          (candidate) =>
            candidate.windowId === windowId && canPromptForProjectIcon(project, candidate)
        );
        if (!workspace) continue;
        asked.add(project.id);
        void window.api
          .takeProjectIconPrompt(workspace.id)
          .then((candidates) => {
            if (candidates.length > 0) {
              setPrompts((current) => [...current, { project, candidates }]);
            } else {
              // Main may have kept the flag, so a later change asks again; once main clears
              // it, the project is no longer pending.
              asked.delete(project.id);
            }
          })
          .catch((err) => {
            asked.delete(project.id);
            console.error('Failed to look for project icons:', err);
          });
      }
    };
    check();
    const unsubscribeWorkspaces = useWorkspacesStore.subscribe(check);
    const unsubscribeProjects = useProjectsStore.subscribe(check);
    return () => {
      unsubscribeWorkspaces();
      unsubscribeProjects();
    };
  }, []);

  if (!prompt) return null;
  const { candidates } = prompt;
  const project = liveProject ?? prompt.project;
  const currentColor = project.color || getProjectColor(project.name);
  // The icon's main color until the current one or another of the icon's is picked.
  const color = resolvePickedColor(
    pickedColor,
    [currentColor, ...iconColors],
    iconColors[0] ?? currentColor
  );

  // Projects cloned together ask one after another.
  const close = () => {
    setIcon(null);
    setPickedColor('');
    setPrompts((current) => current.slice(1));
  };

  const save = async () => {
    close();
    if (!selectedIcon) return;
    try {
      await updateProject(
        project.id,
        color === currentColor ? { icon: selectedIcon } : { icon: selectedIcon, color }
      );
    } catch (err) {
      addToast(`Couldn't set the project icon: ${(err as Error).message}`, 'error');
    }
  };

  return (
    <Dialog
      open={!blocked && !nudgeOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        // Focus on the first choice would read as picking the color dot.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          saveRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Pick an icon for {project.name}</DialogTitle>
          <DialogDescription>
            Komla found {candidates.length === 1 ? 'this image' : 'these images'} in the
            project&rsquo;s files. The icon shows instead of the color dot in the sidebar and menus;
            you can change it later in Project Settings.
          </DialogDescription>
        </DialogHeader>
        <IconPreview project={project} color={color} icon={selectedIcon} />
        <ProjectIconPicker
          value={selectedIcon}
          onChange={setIcon}
          candidates={candidates}
          color={color}
          size="lg"
        />
        {iconColors.length > 0 && (
          <ColorPicker
            label="Project color"
            value={color}
            onChange={setPickedColor}
            colors={iconColors.includes(currentColor) ? [] : [currentColor]}
            suggestedColors={iconColors}
            suggestedLabel="Icon color"
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Not now
          </Button>
          <Button ref={saveRef} onClick={() => void save()}>
            {selectedIcon ? 'Use icon' : 'Keep color dot'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A slice of the window: the project's sidebar group with the icon picked, above the next
 * projects' groups for comparison, beside a terminal.
 */
function IconPreview({ project, color, icon }: { project: Project; color: string; icon: string }) {
  const projects = useProjectsStore((s) => s.projects);
  const neighbours = projects.filter((other) => other.id !== project.id).slice(0, 2);
  return (
    <div
      aria-hidden="true"
      className="flex h-40 overflow-hidden rounded-lg border bg-background select-none"
    >
      <div className="sidebar-surface flex w-52 shrink-0 flex-col gap-2 border-r p-1.5">
        <GroupPanel>
          <GroupRow project={{ ...project, color, icon }} />
          <SkeletonCard selected />
          <SkeletonCard />
        </GroupPanel>
        {neighbours.map((other) => (
          <GroupPanel key={other.id}>
            <GroupRow project={{ ...other, color: other.color || getProjectColor(other.name) }} />
          </GroupPanel>
        ))}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <span className="h-1.5 w-3/4 rounded-full bg-foreground/10" />
        <span className="h-1.5 w-1/2 rounded-full bg-foreground/10" />
        <span className="h-1.5 w-2/3 rounded-full bg-foreground/10" />
      </div>
    </div>
  );
}

// The panel each project sits on in the sidebar.
function GroupPanel({ children }: { children: ReactNode }) {
  return <div className={cn('flex shrink-0 flex-col gap-1', PROJECT_PANEL_CLASS)}>{children}</div>;
}

// Sized like the sidebar's group header.
function GroupRow({ project }: { project: Project & { color: string } }) {
  return (
    <div className="flex shrink-0 items-center gap-2 py-1.5 pl-1.5 text-[13px]">
      <GroupHeaderIcon
        isDirectory={project.kind === 'directory'}
        expanded
        color={project.color}
        icon={project.icon}
      />
      <span className="truncate font-semibold text-foreground">{project.name}</span>
    </div>
  );
}

function SkeletonCard({ selected }: { selected?: boolean }) {
  return (
    <div
      className={cn(
        'flex shrink-0 flex-col gap-1.5 rounded-md px-2.5 py-2',
        selected && 'bg-accent'
      )}
    >
      <span className="h-1.5 w-28 rounded-full bg-foreground/25" />
      <span className="h-1.5 w-16 rounded-full bg-foreground/10" />
    </div>
  );
}
