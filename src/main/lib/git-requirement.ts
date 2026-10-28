import { app, dialog, shell } from 'electron';

import { isGitInstalled } from '../services/git/git-exec';

const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

/**
 * Komla needs git for nearly everything. Returns false after offering the download page
 * and quitting when git is missing, in which case startup should stop.
 */
export async function checkGitInstalled(): Promise<boolean> {
  if (await isGitInstalled()) return true;

  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Git Required',
    message: 'Git is not installed',
    detail: 'Komla requires Git to work. Please install Git and restart the app.',
    buttons: ['Download Git', 'Quit'],
    defaultId: 0,
  });
  if (response === 0) {
    void shell.openExternal(GIT_DOWNLOAD_URL);
  }
  app.quit();
  return false;
}
