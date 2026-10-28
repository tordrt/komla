import { useCallback, useEffect, useState } from 'react';

import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { Button } from '@/components/ui/button';
import { formatRelativeTime } from '@/lib/format-time';
import { ipcErrorMessage } from '@/lib/ipc-error-message';
import { useToastStore } from '@/stores/toast.store';

import type {
  SettingsHistoryEntry,
  SettingsHistoryFile,
} from '../../../../shared/types/settings-history';

const FILE_LABELS: Record<SettingsHistoryFile, string> = {
  'theme.json': 'Appearance',
  'terminal.json': 'Terminal',
  'shortcuts.json': 'Shortcuts',
  'actions.json': 'Quick Commands',
  'categories.json': 'Categories',
  'agent-presets.json': 'Agents',
  'projects.json': 'Projects',
  'status-items.json': 'Status bar items',
  'hooks.json': 'Hooks',
};

const COLLAPSED_COUNT = 6;
const SHOWN_KEYS = 3;

function describeChange(entry: SettingsHistoryEntry): string {
  if (entry.revertOf) return 'Reverted an earlier change';
  if (entry.changedKeys.length === 0) return `Changed ${entry.file}`;
  const shown = entry.changedKeys.slice(0, SHOWN_KEYS).join(', ');
  const more = entry.changedKeys.length - SHOWN_KEYS;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

function changedAgo(at: number): string {
  const relative = formatRelativeTime(at);
  return relative === 'now' ? 'just now' : `${relative} ago`;
}

/**
 * Every recorded change to Komla's settings files, made in Komla, by an agent or by hand, with a
 * Revert for each. It is how a user takes back a change an agent made to their settings.
 */
export function SettingsHistoryCard() {
  const [entries, setEntries] = useState<SettingsHistoryEntry[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      void window.api
        .listSettingsHistory()
        .then((list) => {
          if (!cancelled) setEntries(list);
        })
        .catch(() => {});
    load();
    const unsubscribe = window.api.onSettingsHistoryChange(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const revert = useCallback(async (entry: SettingsHistoryEntry) => {
    const { addToast } = useToastStore.getState();
    setReverting(entry.id);
    try {
      const result = await window.api.revertSettingsChange(entry.id);
      addToast(`Reverted the ${FILE_LABELS[entry.file]} change.`, 'success', {
        action: {
          label: 'Undo',
          onClick: () =>
            void window.api
              .revertSettingsChange(result.id)
              .catch((error) => addToast(ipcErrorMessage(error), 'error')),
        },
      });
    } catch (error) {
      addToast(ipcErrorMessage(error), 'error');
    } finally {
      setReverting(null);
    }
  }, []);

  const shown = expanded ? entries : entries.slice(0, COLLAPSED_COUNT);

  return (
    <SettingsCard
      title="Settings history"
      description="Changes to Komla's settings files, whether made here, by an agent or by hand. Revert puts a file back the way it was before a change."
    >
      {entries.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">No changes yet.</p>
      ) : (
        <ul className="-my-1 divide-y divide-border/30" aria-label="Settings changes">
          {shown.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-foreground">
                  {FILE_LABELS[entry.file]}
                  <span className="ml-2 text-xs text-muted-foreground">{changedAgo(entry.at)}</span>
                </div>
                <div
                  className="truncate text-xs text-muted-foreground"
                  title={entry.changedKeys.join(', ')}
                >
                  {describeChange(entry)}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={reverting !== null}
                aria-label={`Revert ${FILE_LABELS[entry.file]} change from ${changedAgo(entry.at)}`}
                title={
                  entry.laterChanges > 0
                    ? `Also undoes ${entry.laterChanges} later ${entry.laterChanges === 1 ? 'change' : 'changes'} to ${FILE_LABELS[entry.file]}`
                    : undefined
                }
                onClick={() => void revert(entry)}
              >
                Revert
              </Button>
            </li>
          ))}
        </ul>
      )}
      {entries.length > COLLAPSED_COUNT && (
        <button
          type="button"
          className="w-full text-left text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Show fewer' : `Show all ${entries.length} changes`}
        </button>
      )}
    </SettingsCard>
  );
}
