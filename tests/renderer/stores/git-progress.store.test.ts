import { beforeEach, describe, expect, it } from 'vitest';

import {
  latestGitOperation,
  useGitProgressStore,
} from '../../../src/renderer/stores/git-progress.store';

function resetStore(): void {
  useGitProgressStore.setState(useGitProgressStore.getInitialState(), true);
}

describe('git-progress.store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('has empty initial state', () => {
    const state = useGitProgressStore.getState();
    expect(state.operations.size).toBe(0);
  });

  it('starts an operation', () => {
    useGitProgressStore.getState().startOperation('op-1', 'fetch', '/repo');
    const op = useGitProgressStore.getState().operations.get('op-1');
    expect(op).toBeDefined();
    expect(op!.operation).toBe('fetch');
    expect(op!.repoPath).toBe('/repo');
    expect(op!.percent).toBe(0);
    expect(op!.stage).toBe('');
    expect(op!.startedAt).toBeGreaterThan(0);
  });

  it('updates progress by repoPath', () => {
    useGitProgressStore.getState().startOperation('op-1', 'push', '/repo');
    useGitProgressStore.getState().updateProgress('/repo', 50, 'Compressing');
    const op = useGitProgressStore.getState().operations.get('op-1');
    expect(op!.percent).toBe(50);
    expect(op!.stage).toBe('Compressing');
  });

  it('updates the newest operation when two run in one repo', () => {
    useGitProgressStore.setState({
      operations: new Map([
        [
          'op-1',
          {
            id: 'op-1',
            operation: 'fetch' as const,
            repoPath: '/repo',
            percent: 0,
            stage: '',
            startedAt: 1000,
          },
        ],
        [
          'op-2',
          {
            id: 'op-2',
            operation: 'push' as const,
            repoPath: '/repo',
            percent: 0,
            stage: '',
            startedAt: 2000,
          },
        ],
      ]),
    });
    useGitProgressStore.getState().updateProgress('/repo', 40, 'Writing objects');
    const { operations } = useGitProgressStore.getState();
    expect(operations.get('op-2')!.stage).toBe('Writing objects');
    expect(operations.get('op-1')!.stage).toBe('');
  });

  it('updateProgress does nothing if repoPath not found', () => {
    useGitProgressStore.getState().startOperation('op-1', 'push', '/repo');
    useGitProgressStore.getState().updateProgress('/other', 50, 'stage');
    const op = useGitProgressStore.getState().operations.get('op-1');
    expect(op!.percent).toBe(0);
  });

  it('ends an operation', () => {
    useGitProgressStore.getState().startOperation('op-1', 'pull', '/repo');
    useGitProgressStore.getState().endOperation('op-1');
    expect(useGitProgressStore.getState().operations.size).toBe(0);
  });

  it('finds the most recently started operation, in one repo when given', () => {
    const operation = (id: string, repoPath: string, startedAt: number) => ({
      id,
      operation: 'fetch' as const,
      repoPath,
      percent: 0,
      stage: '',
      startedAt,
    });
    const operations = new Map([
      ['op-1', operation('op-1', '/repo1', 1000)],
      ['op-2', operation('op-2', '/repo2', 2000)],
      ['op-3', operation('op-3', '/repo1', 1500)],
    ]);

    expect(latestGitOperation(operations)?.id).toBe('op-2');
    expect(latestGitOperation(operations, '/repo1')?.id).toBe('op-3');
    expect(latestGitOperation(operations, '/other')).toBeUndefined();
  });

  it('handles multiple operations independently', () => {
    const state = useGitProgressStore.getState();
    state.startOperation('op-1', 'fetch', '/repo1');
    state.startOperation('op-2', 'clone', '/repo2');
    expect(useGitProgressStore.getState().operations.size).toBe(2);

    useGitProgressStore.getState().endOperation('op-1');
    expect(useGitProgressStore.getState().operations.size).toBe(1);
    expect(useGitProgressStore.getState().operations.has('op-2')).toBe(true);
  });
});
