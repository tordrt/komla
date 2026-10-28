import { usePushConflictStore } from '@/stores/push-conflict.store';

import type { GitOperationType } from '@/stores/git-progress.store';

interface PushWithRecoverOptions {
  workingDir: string;
  operationPrefix: string;
  workspaceKey: string;
  pushFn: (path: string) => Promise<{ success: boolean; message: string; errorCode?: string }>;
  pullFn: (path: string) => Promise<{ success: boolean; message: string }>;
  pullRebaseFn?: (path: string) => Promise<{ success: boolean; message: string }>;
  /**
   * Confirms a successful push with a toast, this message after a recovered one. Only for a
   * push the workspace's branch status doesn't show, such as the target branch's.
   */
  recoverySuccessMessage?: string;
  startOperation: (id: string, op: GitOperationType, repoPath: string) => void;
  endOperation: (id: string) => void;
  addToast: (message: string, type: 'success' | 'error') => void;
}

interface PushWithRecoverResult {
  success: boolean;
}

export async function pushWithAutoRecover(
  opts: PushWithRecoverOptions
): Promise<PushWithRecoverResult> {
  const {
    workingDir,
    operationPrefix,
    workspaceKey,
    pushFn,
    pullFn,
    pullRebaseFn,
    recoverySuccessMessage,
    startOperation,
    endOperation,
    addToast,
  } = opts;

  // Phase 1: initial push
  const pushOpId = `${operationPrefix}-${workspaceKey}-${Date.now()}`;
  startOperation(pushOpId, 'push', workingDir);
  let rejectionMessage: string | undefined;
  try {
    const result = await pushFn(workingDir);

    if (result.success) {
      if (recoverySuccessMessage !== undefined) addToast(result.message, 'success');
      return { success: true };
    }

    if (result.errorCode !== 'rejected') {
      addToast(result.message, 'error');
      return { success: false };
    }

    rejectionMessage = result.message;
  } catch (error) {
    addToast((error as Error).message, 'error');
    return { success: false };
  } finally {
    endOperation(pushOpId);
  }

  // Phase 2: ask user how to resolve the rejection
  const { requestResolution } = usePushConflictStore.getState();
  const resolution = await requestResolution(rejectionMessage ?? 'Remote has new commits', {
    allowRebase: !!pullRebaseFn,
  });

  if (resolution === 'cancel') {
    return { success: false };
  }

  // Phase 3: pull (merge or rebase) to recover from rejection
  if (resolution === 'rebase-and-push' && !pullRebaseFn) {
    addToast('Rebase not available for this operation', 'error');
    return { success: false };
  }
  const pullOpId = `${operationPrefix}-pull-${workspaceKey}-${Date.now()}`;
  const pullOperation = resolution === 'rebase-and-push' ? pullRebaseFn! : pullFn;
  startOperation(pullOpId, 'pull', workingDir);
  try {
    const pullResult = await pullOperation(workingDir);
    if (!pullResult.success) {
      addToast(pullResult.message, 'error');
      return { success: false };
    }
  } catch (error) {
    addToast((error as Error).message, 'error');
    return { success: false };
  } finally {
    endOperation(pullOpId);
  }

  // Phase 4: retry push
  const retryOpId = `${operationPrefix}-retry-${workspaceKey}-${Date.now()}`;
  startOperation(retryOpId, 'push', workingDir);
  try {
    const retryResult = await pushFn(workingDir);
    if (!retryResult.success) addToast(retryResult.message, 'error');
    else if (recoverySuccessMessage !== undefined) addToast(recoverySuccessMessage, 'success');
    return { success: retryResult.success };
  } catch (error) {
    addToast((error as Error).message, 'error');
    return { success: false };
  } finally {
    endOperation(retryOpId);
  }
}
