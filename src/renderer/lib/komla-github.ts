import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { useToastStore } from '@/stores/toast.store';

import { KOMLA_GITHUB_URL } from '../../shared/constants/komla-github';

export function openKomlaGitHub(): void {
  window.api.openExternal(KOMLA_GITHUB_URL).catch((error: unknown) => {
    useToastStore
      .getState()
      .addToast(`Couldn't open ${KOMLA_GITHUB_URL}: ${ipcErrorMessage(error)}`, 'error');
  });
}
