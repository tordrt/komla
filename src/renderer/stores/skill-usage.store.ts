import { create } from 'zustand';

import type { AgentSkillFamily } from '../../shared/types/agent-skill';

const STORAGE_KEY = 'komla.skillLastUsedAt';
/** Enough for every skill someone uses; older ones fall back to their order by name. */
const MAX_REMEMBERED = 200;

/**
 * The key a skill's use is remembered by, which is also its SkillAction's id. Skills of one name
 * share it wherever they're listed, as they're mostly the same skill in the home folder.
 */
export function skillUsageKey(family: AgentSkillFamily, name: string): string {
  return `skill:${family}:${name}`;
}

/**
 * When each skill was last run or pasted from the Quick Commands list, or picked for a new
 * workspace's prompt, by skillUsageKey, so skill lists show recent ones first. Skills aren't
 * saved Actions, so this lives in the renderer's storage, as a convenience: without it they're
 * listed by name.
 */
interface SkillUsageState {
  lastUsed: Record<string, number>;
  recordSkillUse: (id: string) => void;
}

function readStored(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number'
      )
    );
  } catch {
    return {};
  }
}

function store(lastUsed: Record<string, number>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lastUsed));
  } catch {
    // Storage can be unavailable; the order still applies for this session.
  }
}

/** Both windows' uses, each skill's latest, the most recent first. */
function merge(...maps: Record<string, number>[]): Record<string, number> {
  const latest = new Map<string, number>();
  for (const [id, at] of maps.flatMap((map) => Object.entries(map))) {
    latest.set(id, Math.max(at, latest.get(id) ?? at));
  }
  return Object.fromEntries([...latest].sort(([, a], [, b]) => b - a).slice(0, MAX_REMEMBERED));
}

export const useSkillUsageStore = create<SkillUsageState>((set, get) => ({
  lastUsed: readStored(),
  recordSkillUse: (id) => {
    // Read again, as another window may have stored a use since this one last did.
    const lastUsed = merge(get().lastUsed, readStored(), { [id]: Date.now() });
    set({ lastUsed });
    store(lastUsed);
  },
}));

// Another window's use shows here too, without losing one this window couldn't store.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY || event.key === null) {
      useSkillUsageStore.setState((state) => ({ lastUsed: merge(state.lastUsed, readStored()) }));
    }
  });
}
