import { useToastStore } from '@/stores/toast.store';

export function copyCommitHash(hash: string): void {
  window.api.copyToClipboard(hash);
  useToastStore.getState().addToast(`Copied commit ${hash.slice(0, 7)}`, 'success');
}
