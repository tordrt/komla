import { Warning } from '@phosphor-icons/react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { BranchCleanupDialog } from '@/components/projects/BranchCleanupDialog';
import { ProjectIconPicker } from '@/components/projects/ProjectIconPicker';
import { BranchSelect } from '@/components/ui/branch-select';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { ColorPicker } from '@/components/ui/color-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { useDetectedMainBranch } from '@/hooks/useDetectedMainBranch';
import { useIconColors } from '@/hooks/useIconColors';
import { useProjectIconCandidates } from '@/hooks/useProjectIconCandidates';
import { getProjectColor, PROJECT_COLORS } from '@/lib/project-colors';
import { useActionsStore } from '@/stores/actions.store';
import { useAgentPresetsStore } from '@/stores/agent-presets.store';
import { useConfigStore } from '@/stores/config.store';
import { useProjectsStore } from '@/stores/projects.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useToastStore } from '@/stores/toast.store';
import { useWorkspacesStore } from '@/stores/workspaces.store';

import { projectRepoPath } from '../../../../shared/lib/project-repo-path';

import { CommitButtonsCard } from './CommitButtonsCard';
import {
  draftToUpdates,
  isDraftChanged,
  projectToDraft,
  type ProjectDraft,
} from './project-settings-draft';
import { ProjectSetupSkillButton } from './ProjectSetupSkillButton';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';
import { SettingsSaveBar } from './SettingsSaveBar';
import { TrashCleanupCard } from './TrashCleanupCard';
import { WorkspaceSetupSection } from './WorkspaceSetupSection';

import type { ProjectSection } from './project-settings-sections';
import type { Project, SshWorkspaceMode } from '@/types';

function DeleteProjectWarning({ project }: { project: Project }) {
  const count = useWorkspacesStore(
    (s) => s.workspaces.filter((w) => w.projectId === project.id).length
  );

  if (count === 0) {
    return <>This project has no workspaces.</>;
  }
  if (project.kind === 'directory') {
    return (
      <>
        This will also delete {count} workspace{count !== 1 ? 's' : ''}. The folder on disk will not
        be deleted.
      </>
    );
  }
  return (
    <>
      This will also delete {count} workspace{count !== 1 ? 's' : ''} and their worktrees.
    </>
  );
}

const SSH_MODE_DESCRIPTIONS: Record<SshWorkspaceMode | 'inherit', string> = {
  inherit:
    'Komla asks the first time you run one in an SSH workspace, with Remote machine preselected.',
  remote:
    'They run on the remote machine. You can still open a local terminal when rsync is available on both machines.',
  'local-mirror-actions':
    'Source syncs one way from each SSH workspace when Komla detects changes, and Terminal Commands run in a disposable local copy.',
};

function SshCommandsCard({
  mode,
  onChange,
}: {
  mode: SshWorkspaceMode | 'inherit';
  onChange: (mode: SshWorkspaceMode) => void;
}) {
  return (
    <SettingsCard
      title="SSH workspaces"
      description="Remote suits web, backend, CLI and library work, with port forwarding from the Browser pane. This computer suits desktop, mobile and other apps you test by hand."
    >
      <SettingsRow
        label="Run Terminal Commands on"
        description={`${SSH_MODE_DESCRIPTIONS[mode]} Agents and Git always run on the remote machine.`}
      >
        <SegmentedControl
          aria-label="Run Terminal Commands on"
          size="md"
          // An unset mode asks on first use with Remote machine preselected, so show that as selected.
          value={mode === 'inherit' ? 'remote' : mode}
          onValueChange={onChange}
          options={[
            { value: 'remote', label: 'Remote machine' },
            { value: 'local-mirror-actions', label: 'This computer' },
          ]}
        />
      </SettingsRow>
      {mode === 'local-mirror-actions' && (
        <div>
          <Callout tone="warning" className="leading-relaxed">
            Local copies require <code className="font-mono">rsync</code> on this computer and the
            SSH host. Native Windows is not currently supported.
          </Callout>
        </div>
      )}
    </SettingsCard>
  );
}

/**
 * The icon's colors, after a saved color from an icon, which stays first so it holds its place
 * while the icon is read and stays a choice once another icon is picked.
 */
function suggestedColors(savedColor: string, iconColors: string[]): string[] {
  return savedColor && !PROJECT_COLORS.includes(savedColor)
    ? [savedColor, ...iconColors.filter((color) => color !== savedColor)]
    : iconColors;
}

interface ProjectSettingsPageProps {
  project: Project;
  onDirtyChange?: (isDirty: boolean) => void;
  /** The part of a git project's settings to show; directory projects show everything. */
  section?: ProjectSection;
}

/**
 * Everything about one project. Git projects split it into sections the Settings nav lists under
 * the project: General (name, color, SSH workspaces), Git (branches, commit buttons) and Setup
 * (setup steps, trash cleanup). One save bar covers every section, so switching keeps edits.
 */
export function ProjectSettingsPage({
  project,
  onDirtyChange,
  section = 'general',
}: ProjectSettingsPageProps) {
  const { updateProject, deleteProject } = useProjectsStore();
  const addToast = useToastStore((s) => s.addToast);
  const { actions } = useActionsStore();
  const { presets, loadPresets } = useAgentPresetsStore();
  const hasSshHosts = useSshHostsStore((state) => !state.hasLoaded || state.hosts.length > 0);
  const isDirectory = project.kind === 'directory';
  const detectedMainBranch = useDetectedMainBranch(project, !isDirectory);
  const appWidePrefix = useConfigStore((s) => s.config?.gitDefaults?.branchPrefix);

  const latest = useMemo(() => projectToDraft(project), [project]);
  // The saved values the edits started from, and the edits.
  const [saved, setSaved] = useState(latest);
  const [draft, setDraft] = useState(latest);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [branchCleanupOpen, setBranchCleanupOpen] = useState(false);
  const isDirty = isDraftChanged(draft, saved);
  // Take up changes made elsewhere, such as by an agent over MCP, while nothing is edited.
  if (latest !== saved && !isDirty) {
    setSaved(latest);
    setDraft(latest);
  }

  useEffect(() => {
    void loadPresets();
  }, [loadPresets]);

  const iconCandidates = useProjectIconCandidates({ projectId: project.id });
  // The saved icon stays a choice after its file moved or changed.
  const iconOptions =
    saved.icon && !iconCandidates.some((candidate) => candidate.dataUrl === saved.icon)
      ? [{ path: 'Current icon', dataUrl: saved.icon }, ...iconCandidates]
      : iconCandidates;
  const iconColors = useIconColors(draft.icon);

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  // A project deleted while it has edits takes them along.
  const onDirtyChangeRef = useRef(onDirtyChange);
  useLayoutEffect(() => {
    onDirtyChangeRef.current = onDirtyChange;
  });
  useEffect(() => () => onDirtyChangeRef.current?.(false), []);

  const update = (changes: Partial<ProjectDraft>) => setDraft((prev) => ({ ...prev, ...changes }));

  const handleSave = async () => {
    if (!draft.name.trim()) {
      addToast('Project name is required', 'error');
      return;
    }
    const updates = draftToUpdates(draft, saved, project.kind);
    setIsSaving(true);
    try {
      await updateProject(project.id, updates);
      // The saved project then replaces these values, normalized.
      setSaved(draft);
      addToast('Project updated', 'success');
    } catch (err) {
      addToast((err as Error).message, 'error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    await deleteProject(project.id);
    addToast('Project deleted', 'success');
    setDeleteDialogOpen(false);
  };

  const generalCard = (
    <SettingsCard
      title="General"
      description={
        isDirectory
          ? 'Directory projects group workspaces around this folder, without git worktrees, branches, or merge shortcuts.'
          : undefined
      }
    >
      <SettingsRow label="Name">
        <Input
          className="w-64"
          value={draft.name}
          onChange={(e) => update({ name: e.target.value })}
          placeholder="Project name"
        />
      </SettingsRow>
      <SettingsRow label="Color" description="Shown on this project's workspaces and terminals.">
        <ColorPicker
          value={draft.color}
          onChange={(color) => update({ color })}
          colors={PROJECT_COLORS}
          suggestedColors={suggestedColors(saved.color, iconColors)}
          suggestedLabel="Icon color"
          allowDeselect
        />
      </SettingsRow>
      <SettingsRow
        label="Icon"
        description="An image from the project's files, or one you upload, shown instead of the color dot."
      >
        <ProjectIconPicker
          value={draft.icon}
          onChange={(icon) =>
            // A color picked from the icon being replaced goes back to the saved one.
            update(
              iconColors.includes(draft.color) && draft.color !== saved.color
                ? { icon, color: saved.color }
                : { icon }
            )
          }
          candidates={iconOptions}
          color={draft.color || getProjectColor(project.name)}
        />
      </SettingsRow>
    </SettingsCard>
  );

  const dangerZone = (
    <SettingsCard title="Danger zone">
      <SettingsRow
        label="Delete project"
        description="Removes the project and its workspaces from Komla."
      >
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => setDeleteDialogOpen(true)}
        >
          Delete project
        </Button>
      </SettingsRow>
    </SettingsCard>
  );

  return (
    <div className="space-y-8">
      {isDirectory ? (
        <>
          {generalCard}
          {dangerZone}
        </>
      ) : (
        // Hidden sections stay mounted, so their cards keep their state while another shows.
        <>
          <div hidden={section !== 'general'} className="space-y-8">
            {generalCard}
            {(hasSshHosts || saved.sshWorkspaceMode !== 'inherit') && (
              <SshCommandsCard
                mode={draft.sshWorkspaceMode}
                onChange={(sshWorkspaceMode) => update({ sshWorkspaceMode })}
              />
            )}
            {dangerZone}
          </div>

          <div hidden={section !== 'git'} className="space-y-8">
            <SettingsCard title="Branches">
              <SettingsRow
                label="Branch prefix"
                description="Starts the name of each new workspace branch. Empty uses the one in Settings → Git."
              >
                <Input
                  className="w-64"
                  value={draft.branchPrefix}
                  onChange={(e) => update({ branchPrefix: e.target.value })}
                  placeholder={appWidePrefix ? `${appWidePrefix} (default)` : 'e.g. komla/'}
                />
              </SettingsRow>
              <SettingsRow
                label="Target branch"
                description={`Used for diffs, PRs and the commit buttons, and as the default base for new workspaces.${project.managed ? ' All branches, including main, are available.' : ''}`}
              >
                <div className="w-64">
                  <BranchSelect
                    value={draft.baseBranch}
                    onChange={(baseBranch) => update({ baseBranch })}
                    repoPath={projectRepoPath(project)}
                    projectId={project.id}
                    placeholder={
                      detectedMainBranch ? `${detectedMainBranch} (default)` : 'Default branch'
                    }
                  />
                </div>
              </SettingsRow>
              <SettingsRow
                label="Leftover branches"
                description={
                  draft.baseBranch !== saved.baseBranch
                    ? 'Save the target branch first: cleanup keeps it and compares branches with it.'
                    : 'Delete branches no workspace uses, such as those of deleted workspaces.'
                }
              >
                <Button
                  variant="outline"
                  size="sm"
                  disabled={draft.baseBranch !== saved.baseBranch}
                  onClick={() => setBranchCleanupOpen(true)}
                >
                  Clean up…
                </Button>
              </SettingsRow>
            </SettingsCard>
            <BranchCleanupDialog
              projectId={project.id}
              open={branchCleanupOpen}
              onOpenChange={setBranchCleanupOpen}
            />

            <CommitButtonsCard projectId={project.id} draft={draft} onChange={update} />
          </div>

          <div hidden={section !== 'setup'} className="space-y-8">
            <WorkspaceSetupSection
              steps={draft.setupSteps}
              agentPlacement={draft.agentPlacement}
              agentLayoutOrder={draft.agentLayoutOrder}
              actions={actions.filter(
                (a) => !a.projectIds?.length || a.projectIds.includes(project.id)
              )}
              presets={presets}
              onStepsChange={(setupSteps) => update({ setupSteps })}
              onAgentPlacementChange={(agentPlacement) => update({ agentPlacement })}
              onAgentLayoutOrderChange={(agentLayoutOrder) => update({ agentLayoutOrder })}
              action={<ProjectSetupSkillButton />}
            />

            <TrashCleanupCard
              script={draft.trashCleanupScript}
              onScriptChange={(trashCleanupScript) => update({ trashCleanupScript })}
            />
          </div>
        </>
      )}

      <SettingsSaveBar
        isDirty={isDirty}
        isSaving={isSaving}
        onSave={handleSave}
        onDiscard={() => setDraft(saved)}
      />

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Warning className="size-4 text-destructive" />
              Delete project
            </DialogTitle>
            <DialogDescription>
              Delete "{project.name}"? <DeleteProjectWarning project={project} />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
