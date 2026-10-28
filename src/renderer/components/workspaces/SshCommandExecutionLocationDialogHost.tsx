import { useState } from 'react';

import { SshCommandExecutionLocationDialog } from '@/components/workspaces/SshCommandExecutionLocationDialog';
import { useSshCommandExecutionLocationStore } from '@/stores/ssh-command-execution-location.store';

export function SshCommandExecutionLocationDialogHost() {
  const { pending, choice, saving, error, setChoice, cancel, confirm } =
    useSshCommandExecutionLocationStore();
  // Keeps the last request's names on screen while the dialog animates closed.
  const [shown, setShown] = useState(pending);
  if (pending !== null && pending !== shown) setShown(pending);

  return (
    <SshCommandExecutionLocationDialog
      open={pending !== null}
      projectName={shown?.projectName ?? 'this project'}
      hostName={shown?.hostName}
      choice={choice}
      saving={saving}
      error={error}
      onChoiceChange={setChoice}
      onCancel={cancel}
      onConfirm={() => void confirm()}
    />
  );
}
