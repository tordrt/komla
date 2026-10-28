import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dismissLaunchUndo,
  holdLaunchUndo,
  LAUNCH_UNDO_MS,
  offerLaunchUndo,
  registerLaunchUndoRow,
  takeLaunchUndo,
  useLaunchUndoStore,
} from '../../../src/renderer/stores/launch-undo.store';

const offer = () => useLaunchUndoStore.getState().offer;

describe('launch-undo.store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    dismissLaunchUndo();
    vi.useRealTimers();
  });

  it('falls back when no row mounts for the offer', () => {
    const fallback = vi.fn();
    offerLaunchUndo(['ws-1'], vi.fn(), fallback);

    vi.advanceTimersByTime(0);

    expect(fallback).toHaveBeenCalledOnce();
    expect(offer()).toBeNull();
  });

  it('waits for a mounted row to say whether it is in sight, however long that takes', () => {
    const fallback = vi.fn();
    offerLaunchUndo(['ws-1'], vi.fn(), fallback);
    const row = registerLaunchUndoRow();

    vi.advanceTimersByTime(5000);
    expect(fallback).not.toHaveBeenCalled();

    row.setVisible(false);
    expect(fallback).toHaveBeenCalledOnce();
    expect(offer()).toBeNull();
  });

  it('stays on a row in sight, and lapses after its time', () => {
    const fallback = vi.fn();
    offerLaunchUndo(['ws-1'], vi.fn(), fallback);
    registerLaunchUndoRow().setVisible(true);

    vi.advanceTimersByTime(LAUNCH_UNDO_MS - 1);
    expect(fallback).not.toHaveBeenCalled();
    expect(offer()?.workspaceIds).toEqual(['ws-1']);

    vi.advanceTimersByTime(1);
    expect(offer()).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('moves to the fallback once the last row in sight leaves it', () => {
    const fallback = vi.fn();
    offerLaunchUndo(['ws-1', 'ws-2'], vi.fn(), fallback);
    const first = registerLaunchUndoRow();
    const second = registerLaunchUndoRow();
    first.setVisible(true);
    second.setVisible(false);
    vi.advanceTimersByTime(1000);

    second.setVisible(true);
    first.release();
    expect(fallback).not.toHaveBeenCalled();

    second.setVisible(false);
    expect(fallback).toHaveBeenCalledOnce();
    expect(offer()).toBeNull();
  });

  it('pauses while held and resumes with the time that was left', () => {
    offerLaunchUndo(['ws-1'], vi.fn(), vi.fn());
    registerLaunchUndoRow().setVisible(true);
    vi.advanceTimersByTime(LAUNCH_UNDO_MS - 1000);

    const release = holdLaunchUndo();
    vi.advanceTimersByTime(60_000);
    expect(offer()).not.toBeNull();

    release();
    release();
    vi.advanceTimersByTime(999);
    expect(offer()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(offer()).toBeNull();
  });

  it('runs the undo once when taken, without falling back as its rows go', () => {
    const undo = vi.fn();
    const fallback = vi.fn();
    offerLaunchUndo(['ws-1', 'ws-2'], undo, fallback);
    const row = registerLaunchUndoRow();
    row.setVisible(true);

    takeLaunchUndo();
    takeLaunchUndo();
    row.release();
    vi.advanceTimersByTime(0);

    expect(undo).toHaveBeenCalledOnce();
    expect(fallback).not.toHaveBeenCalled();
    expect(offer()).toBeNull();
  });

  it('lets a newer launch replace the offer without the older rows touching it', () => {
    const firstUndo = vi.fn();
    const firstFallback = vi.fn();
    offerLaunchUndo(['ws-1'], firstUndo, firstFallback);
    const oldRow = registerLaunchUndoRow();
    oldRow.setVisible(true);
    const releaseHold = holdLaunchUndo();

    const fallback = vi.fn();
    offerLaunchUndo(['ws-2'], vi.fn(), fallback);
    registerLaunchUndoRow().setVisible(true);
    oldRow.setVisible(false);
    oldRow.release();
    releaseHold();
    vi.advanceTimersByTime(0);

    expect(fallback).not.toHaveBeenCalled();
    expect(firstFallback).not.toHaveBeenCalled();
    expect(offer()?.workspaceIds).toEqual(['ws-2']);
    vi.advanceTimersByTime(LAUNCH_UNDO_MS);
    expect(offer()).toBeNull();
    expect(firstUndo).not.toHaveBeenCalled();
  });
});
