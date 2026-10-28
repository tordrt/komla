export type ProjectCreationMode = 'local' | 'remote' | 'directory';

export interface ValidateProjectCreationArgs {
  mode: ProjectCreationMode;
  isNewRepo: boolean;
  newProjectName: string;
  projectPath: string;
  remoteUrl: string;
  isCheckingOriginRemote: boolean;
}

export function validateProjectCreation(args: ValidateProjectCreationArgs): string | null {
  if (args.mode === 'directory') {
    if (!args.projectPath.trim()) return 'Directory path is required';
    return null;
  }

  if (args.mode === 'local' && args.isNewRepo) {
    if (!args.newProjectName.trim()) return 'Project name is required';
    return null;
  }

  if (args.mode === 'local') {
    if (!args.projectPath.trim()) return 'Folder path is required';
    if (args.isCheckingOriginRemote) {
      return 'Checking repository remotes. Try again in a moment.';
    }
    return null;
  }

  if (!args.remoteUrl.trim()) return 'Remote URL is required';
  if (!/^(https?:\/\/|git@)/.test(args.remoteUrl.trim())) {
    return 'Enter a valid Git URL (https:// or git@)';
  }
  return null;
}
