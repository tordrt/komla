import { join } from 'path';

import { keychainCipher } from '../lib/secure-storage';

import { getKomlaBasePath } from './paths';
import { projectService } from './project.service';
import { SecretFileStore } from './secret-file-store';

/** The contents of projects' Secret file steps, encrypted by the OS keychain. */
export const secretFileStore = new SecretFileStore(
  join(getKomlaBasePath(), 'settings', 'secret-files.json'),
  keychainCipher
);

/** Forgets a Secret file's contents once its step or project is gone. */
export function forgetRemovedSecretFiles(): () => void {
  return projectService.onSecretFileStepsChange((projectId, stepIds) =>
    secretFileStore.retain(projectId, stepIds)
  );
}
