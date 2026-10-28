import { useEffect } from 'react';
import { create } from 'zustand';

import type { NoteSummary } from '../../shared/types/notes';

const NO_NOTES: NoteSummary[] = [];

interface NotesState {
  /** Each workspace's notes, most recently changed first, once listed. */
  byScope: Record<string, NoteSummary[]>;
  /** Lists a workspace's notes, and keeps the list current as notes change on disk. */
  load: (scopeId: string) => Promise<void>;
  create: (scopeId: string) => Promise<NoteSummary>;
  trash: (scopeId: string, name: string) => Promise<void>;
  /** Shows a note's title as it's typed, ahead of the saved file. */
  setTitle: (scopeId: string, name: string, title: string) => void;
}

// A listing that resolves after a newer one started is stale.
const loadGeneration = new Map<string, number>();
let stopListening: (() => void) | null = null;

export const useNotesStore = create<NotesState>((set, get) => ({
  byScope: {},

  load: async (scopeId) => {
    stopListening ??= window.api.onNotesChanged((changed) => {
      if (get().byScope[changed]) void get().load(changed);
    });
    const generation = (loadGeneration.get(scopeId) ?? 0) + 1;
    loadGeneration.set(scopeId, generation);
    const notes = await window.api.listNotes(scopeId);
    if (loadGeneration.get(scopeId) !== generation) return;
    set((state) => ({ byScope: { ...state.byScope, [scopeId]: notes } }));
  },

  create: async (scopeId) => {
    const note = await window.api.createNote(scopeId);
    set((state) => {
      const notes = state.byScope[scopeId] ?? [];
      if (notes.some((existing) => existing.name === note.name)) return state;
      return { byScope: { ...state.byScope, [scopeId]: [note, ...notes] } };
    });
    return note;
  },

  trash: async (scopeId, name) => {
    await window.api.trashNote(scopeId, name);
    set((state) => ({
      byScope: {
        ...state.byScope,
        [scopeId]: (state.byScope[scopeId] ?? []).filter((note) => note.name !== name),
      },
    }));
  },

  setTitle: (scopeId, name, title) => {
    const notes = get().byScope[scopeId];
    const note = notes?.find((existing) => existing.name === name);
    if (!notes || !note || note.title === title) return;
    set((state) => ({
      byScope: {
        ...state.byScope,
        [scopeId]: notes.map((existing) => (existing === note ? { ...note, title } : existing)),
      },
    }));
  },
}));

/** A workspace's notes, listed on first use. */
export function useNotes(scopeId: string | null): NoteSummary[] {
  const notes = useNotesStore((state) => (scopeId ? state.byScope[scopeId] : undefined));
  const load = useNotesStore((state) => state.load);
  useEffect(() => {
    if (!scopeId) return;
    load(scopeId).catch(() => {});
  }, [load, scopeId]);
  return notes ?? NO_NOTES;
}

/** Stops following note changes; for tests. */
export function resetNotesStore(): void {
  stopListening?.();
  stopListening = null;
  loadGeneration.clear();
  useNotesStore.setState({ byScope: {} });
}
