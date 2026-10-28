import { useState, useCallback, useRef } from 'react';

import type { BlameHunk } from '@/types';

export type BlameLineMap = Map<number, BlameHunk>;

export interface BlameState {
  blameEnabled: boolean;
  blameAnnotations: BlameHunk[];
  blameLineMap: BlameLineMap;
  blameLoading: boolean;
  toggleBlame: () => void;
  loadBlame: (worktreePath: string, filePath: string) => Promise<void>;
  clearBlame: () => void;
}

export function useBlameState(): BlameState {
  const [blameEnabled, setBlameEnabled] = useState(false);
  const [blameAnnotations, setBlameAnnotations] = useState<BlameHunk[]>([]);
  const [blameLineMap, setBlameLineMap] = useState<BlameLineMap>(new Map());
  const [blameLoading, setBlameLoading] = useState(false);
  const loadIdRef = useRef(0);

  const loadBlame = useCallback(async (worktreePath: string, filePath: string) => {
    const id = ++loadIdRef.current;
    setBlameLoading(true);
    try {
      const hunks = await window.api.getBlame(worktreePath, filePath);
      if (id !== loadIdRef.current) return;
      const map: BlameLineMap = new Map();
      for (const hunk of hunks) {
        for (let l = hunk.startLine; l < hunk.startLine + hunk.lineCount; l++) {
          map.set(l, hunk);
        }
      }
      setBlameAnnotations(hunks);
      setBlameLineMap(map);
    } catch {
      if (id !== loadIdRef.current) return;
      setBlameAnnotations([]);
      setBlameLineMap(new Map());
    } finally {
      if (id === loadIdRef.current) setBlameLoading(false);
    }
  }, []);

  const clearBlame = useCallback(() => {
    loadIdRef.current++;
    setBlameAnnotations([]);
    setBlameLineMap(new Map());
  }, []);

  const toggleBlame = useCallback(() => {
    setBlameEnabled((prev) => !prev);
  }, []);

  return {
    blameEnabled,
    blameAnnotations,
    blameLineMap,
    blameLoading,
    toggleBlame,
    loadBlame,
    clearBlame,
  };
}
