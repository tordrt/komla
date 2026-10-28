import { describe, it, expect, beforeEach } from 'vitest';
import { usePushConflictStore } from '../../../src/renderer/stores/push-conflict.store';

describe('push-conflict.store', () => {
  beforeEach(() => {
    usePushConflictStore.setState({ conflict: null });
  });

  it('sets conflict state when resolution is requested', () => {
    usePushConflictStore.getState().requestResolution('Remote has new commits');

    const { conflict } = usePushConflictStore.getState();
    expect(conflict).not.toBeNull();
    expect(conflict!.message).toBe('Remote has new commits');
    expect(conflict!.options).toEqual({});
  });

  it('stores options when provided to requestResolution', () => {
    usePushConflictStore.getState().requestResolution('rejected', { allowRebase: true });

    const { conflict } = usePushConflictStore.getState();
    expect(conflict!.options).toEqual({ allowRebase: true });
  });

  it('resolves promise with pull-and-push when user confirms', async () => {
    const promise = usePushConflictStore.getState().requestResolution('rejected');

    usePushConflictStore.getState().resolve('pull-and-push');

    await expect(promise).resolves.toBe('pull-and-push');
  });

  it('resolves promise with rebase-and-push', async () => {
    const promise = usePushConflictStore.getState().requestResolution('rejected');

    usePushConflictStore.getState().resolve('rebase-and-push');

    await expect(promise).resolves.toBe('rebase-and-push');
  });

  it('resolves promise with cancel when user cancels', async () => {
    const promise = usePushConflictStore.getState().requestResolution('rejected');

    usePushConflictStore.getState().resolve('cancel');

    await expect(promise).resolves.toBe('cancel');
  });

  it('clears conflict state after resolving', () => {
    usePushConflictStore.getState().requestResolution('rejected');

    usePushConflictStore.getState().resolve('pull-and-push');

    expect(usePushConflictStore.getState().conflict).toBeNull();
  });

  it('is a no-op to resolve when no conflict is pending', () => {
    // Should not throw
    usePushConflictStore.getState().resolve('pull-and-push');

    expect(usePushConflictStore.getState().conflict).toBeNull();
  });

  it('cancels previous pending resolution when a new one is requested', async () => {
    const first = usePushConflictStore.getState().requestResolution('first rejection');
    const second = usePushConflictStore.getState().requestResolution('second rejection');

    // First promise should have been auto-cancelled
    await expect(first).resolves.toBe('cancel');

    // Second is still pending until resolved via the store
    usePushConflictStore.getState().resolve('pull-and-push');
    await expect(second).resolves.toBe('pull-and-push');
  });
});
