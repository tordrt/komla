import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { shortcutEntries, groupOrder, type ShortcutEntry } from '@/constants/shortcut-entries';
import {
  keyEventToConfigFormat,
  findConflict,
  isModifierOnly,
  extractRangeModifier,
  DoubleTapRecorder,
} from '@/lib/shortcut-recorder';
import { useShortcutsStore } from '@/stores/shortcuts.store';
import { useToastStore } from '@/stores/toast.store';

import { isNewWorkspaceDialogShortcut } from '../../../../shared/constants/shortcut-scopes';

import { ResetToDefaultsButton } from './ResetToDefaultsButton';

interface ShortcutsTabProps {
  onDirtyChange: (isDirty: boolean) => void;
}

const platform = typeof window !== 'undefined' ? (window.api?.platform ?? 'darwin') : 'darwin';

/** Build a map of action → label from shortcutEntries for conflict messages */
const actionLabels: Record<string, string> = Object.fromEntries(
  shortcutEntries.map((e) => [e.action, e.label])
);

interface Conflict {
  action: string;
  label: string;
  /** Takes the keys from the other action, which is then left unbound */
  canReplace: boolean;
  /** Gives the other action the keys the recorded one had */
  canSwap: boolean;
}

// Go to workspace 1–9 changes only as a range.
const isRangeAction = (action: string) => action.startsWith('workspace.select.');

export function ShortcutsTab({ onDirtyChange }: ShortcutsTabProps) {
  const { config, getDisplayShortcut, updateShortcuts, resetShortcuts } = useShortcutsStore();
  const addToast = useToastStore((s) => s.addToast);
  const [searchQuery, setSearchQuery] = useState('');
  const [recordingAction, setRecordingAction] = useState<string | null>(null);
  const [recordedCombo, setRecordedCombo] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [resetDialogOpen, setResetDialogOpen] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const doubleTapRecorderRef = useRef<DoubleTapRecorder | null>(null);

  // Track dirty state — dirty when recording is active
  useEffect(() => {
    onDirtyChange(recordingAction !== null);
  }, [recordingAction, onDirtyChange]);

  // Helper to attempt saving a combo (regular or DoubleTap)
  const tryAcceptCombo = useCallback(
    (combo: string) => {
      if (!config || !recordingAction) return;

      // For range rows, extract modifier and check all 9 combos
      const entry = shortcutEntries.find((en) => en.action === recordingAction);
      if (entry?.rangeActions) {
        const modifier = extractRangeModifier(combo);
        if (!modifier) return;
        for (let i = 1; i <= 9; i++) {
          const digitCombo = `${modifier}+${i}`;
          const conflictResult = findConflict(
            digitCombo,
            `workspace.select.${i}`,
            config.shortcuts,
            actionLabels
          );
          if (conflictResult) {
            setRecordedCombo(combo);
            setConflict({ ...conflictResult, canReplace: false, canSwap: false });
            return;
          }
        }
        const updates: Record<string, string> = {};
        for (let i = 1; i <= 9; i++) {
          updates[`workspace.select.${i}`] = `${modifier}+${i}`;
        }
        void updateShortcuts({ shortcuts: updates });
        setRecordingAction(null);
        setRecordedCombo(null);
        setConflict(null);
        return;
      }

      // Regular or DoubleTap shortcut — check conflict
      const conflictResult = findConflict(combo, recordingAction, config.shortcuts, actionLabels);
      if (conflictResult) {
        // Keys pass between actions pressed in the same places, such as two dialog actions,
        // so the new workspace dialog never takes New workspace's keys app-wide.
        const canReplace =
          !isRangeAction(conflictResult.action) &&
          isNewWorkspaceDialogShortcut(recordingAction) ===
            isNewWorkspaceDialogShortcut(conflictResult.action);
        const previous = config.shortcuts[recordingAction];
        const canSwap =
          canReplace &&
          Boolean(previous) &&
          !findConflict(
            previous,
            conflictResult.action,
            { ...config.shortcuts, [recordingAction]: combo },
            actionLabels
          );
        setRecordedCombo(combo);
        setConflict({ ...conflictResult, canReplace, canSwap });
        return;
      }

      // No conflict — save immediately
      void updateShortcuts({ shortcuts: { [recordingAction]: combo } });
      setRecordingAction(null);
      setRecordedCombo(null);
      setConflict(null);
    },
    [config, recordingAction, updateShortcuts]
  );

  // Keydown + keyup listeners for recording mode (supports both regular combos and double-tap)
  useEffect(() => {
    if (!recordingAction || !config) return;

    // Fresh double-tap recorder for each recording session
    const dtRecorder = new DoubleTapRecorder();
    doubleTapRecorderRef.current = dtRecorder;
    // The new workspace dialog takes Shift+Tab but not double taps.
    const inDialog = isNewWorkspaceDialogShortcut(recordingAction);

    const handleKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Escape cancels recording
      if (e.key === 'Escape') {
        setRecordingAction(null);
        setRecordedCombo(null);
        setConflict(null);
        return;
      }

      // Feed to double-tap recorder (tracks modifier-only keydowns)
      dtRecorder.handleKeyDown(e);

      // If it's a modifier-only press, wait for keyup (potential double-tap)
      if (isModifierOnly(e.key)) return;

      // Require at least one modifier (Cmd/Ctrl/Alt) for regular combos
      const isShiftTab = e.key === 'Tab' && e.shiftKey;
      if (!e.metaKey && !e.ctrlKey && !e.altKey && !(inDialog && isShiftTab)) return;

      // Regular combo detected — reset double-tap state and accept
      dtRecorder.reset();
      const combo = keyEventToConfigFormat(e, platform);
      tryAcceptCombo(combo);
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Feed to double-tap recorder — returns config string if double-tap completed
      const doubleTapCombo = dtRecorder.handleKeyUp(e);
      if (doubleTapCombo && !inDialog) {
        tryAcceptCombo(doubleTapCombo);
      }
    };

    document.addEventListener('keydown', handleKeyDown, { capture: true });
    document.addEventListener('keyup', handleKeyUp, { capture: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
      document.removeEventListener('keyup', handleKeyUp, { capture: true });
      doubleTapRecorderRef.current = null;
    };
  }, [recordingAction, config, tryAcceptCombo]);

  const startRecording = useCallback((action: string) => {
    setRecordingAction(action);
    setRecordedCombo(null);
    setConflict(null);
  }, []);

  const resolveConflict = useCallback(
    (mode: 'replace' | 'swap') => {
      if (!config || !recordingAction || !recordedCombo || !conflict) return;
      const previous = mode === 'swap' ? config.shortcuts[recordingAction] : '';
      void updateShortcuts({
        shortcuts: { [recordingAction]: recordedCombo, [conflict.action]: previous },
      });
      setRecordingAction(null);
      setRecordedCombo(null);
      setConflict(null);
    },
    [config, recordingAction, recordedCombo, conflict, updateShortcuts]
  );

  const clearShortcut = useCallback(
    (action: string) => void updateShortcuts({ shortcuts: { [action]: '' } }),
    [updateShortcuts]
  );

  const handleReset = useCallback(async () => {
    setIsResetting(true);
    try {
      await resetShortcuts();
      addToast('Keyboard shortcuts reset to defaults', 'success');
    } catch {
      addToast('Failed to reset keyboard shortcuts', 'error');
    } finally {
      setIsResetting(false);
      setResetDialogOpen(false);
    }
  }, [resetShortcuts, addToast]);

  // Filter entries by search query
  const filteredGroups = useMemo(() => {
    const query = searchQuery.toLowerCase();
    return groupOrder
      .map((group) => ({
        group,
        entries: shortcutEntries.filter(
          (e) => e.group === group && (!query || e.label.toLowerCase().includes(query))
        ),
      }))
      .filter((g) => g.entries.length > 0);
  }, [searchQuery]);

  if (!config) return null;

  return (
    <>
      <div className="space-y-6">
        {/* Search */}
        <div>
          <div className="relative">
            <MagnifyingGlass className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
            <input
              type="text"
              aria-label="Search shortcuts"
              // Escape clears the search first; Settings stays open while it has text.
              data-clears-on-escape=""
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && searchQuery) setSearchQuery('');
              }}
              placeholder="Search shortcuts..."
              className="h-8 w-full rounded-md border border-border/60 bg-muted/40 pr-3 pl-8 text-xs text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-hidden"
            />
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Click a shortcut to record a new one. Esc cancels. New workspace dialog shortcuts only
            act in that dialog, so they can reuse keys from elsewhere.
          </p>
        </div>

        {/* Grouped shortcut list */}
        {filteredGroups.map(({ group, entries }) => (
          <SettingsCard key={group} title={group}>
            {entries.map((entry) => (
              <ShortcutRow
                key={entry.action}
                entry={entry}
                getDisplayShortcut={getDisplayShortcut}
                isRecording={recordingAction === entry.action}
                recordedCombo={recordingAction === entry.action ? recordedCombo : null}
                conflict={recordingAction === entry.action ? conflict : null}
                onStartRecording={startRecording}
                onResolveConflict={resolveConflict}
                onClear={clearShortcut}
              />
            ))}
          </SettingsCard>
        ))}

        {filteredGroups.length === 0 && (
          <p className="py-8 text-center text-[13px] text-muted-foreground">
            No shortcuts match “{searchQuery}”.
          </p>
        )}

        <ResetToDefaultsButton
          label="Reset all shortcuts"
          isResetting={isResetting}
          onClick={() => setResetDialogOpen(true)}
        />
      </div>

      {/* Reset Confirmation Dialog */}
      <Dialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset keyboard shortcuts</DialogTitle>
            <DialogDescription>
              This will reset all keyboard shortcuts to their default bindings.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResetDialogOpen(false)}
              disabled={isResetting}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleReset()} disabled={isResetting}>
              {isResetting ? (
                <>
                  <Spinner className="mr-2" />
                  Resetting...
                </>
              ) : (
                'Reset'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const SHORTCUT_CHIP_BUTTON_CLASS =
  'group rounded focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring';
const SHORTCUT_CHIP_CLASS =
  'h-6 cursor-pointer px-2 text-xs transition-colors group-hover:border-primary/50 group-hover:text-foreground';
const CONFLICT_BUTTON_CLASS =
  'rounded-sm text-2xs text-muted-foreground underline hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden';

/** Individual shortcut row — normal, recording, or conflict state */
function ShortcutRow({
  entry,
  getDisplayShortcut,
  isRecording,
  recordedCombo,
  conflict,
  onStartRecording,
  onResolveConflict,
  onClear,
}: {
  entry: ShortcutEntry;
  getDisplayShortcut: (action: string) => string;
  isRecording: boolean;
  recordedCombo: string | null;
  conflict: Conflict | null;
  onStartRecording: (action: string) => void;
  onResolveConflict: (mode: 'replace' | 'swap') => void;
  onClear: (action: string) => void;
}) {
  const isRange = !!entry.rangeActions;

  // Recording state with conflict
  if (isRecording && conflict) {
    return (
      <div className="!py-2.5 shadow-[inset_2px_0_0_0_var(--color-error)]">
        <div className="flex items-center justify-between">
          <span className="text-sm">{entry.label}</span>
          <div className="flex items-center gap-2">
            <Kbd className="h-6 border-error/30 bg-error/15 px-2 text-xs text-error">
              {recordedCombo}
            </Kbd>
            {conflict.canSwap && (
              <button
                type="button"
                className={CONFLICT_BUTTON_CLASS}
                title={`Give “${conflict.label}” the keys ${entry.label} had`}
                onClick={() => onResolveConflict('swap')}
              >
                Swap
              </button>
            )}
            {conflict.canReplace && (
              <button
                type="button"
                className={CONFLICT_BUTTON_CLASS}
                title={`Leave “${conflict.label}” without a shortcut`}
                onClick={() => onResolveConflict('replace')}
              >
                Replace
              </button>
            )}
            <button
              type="button"
              className={CONFLICT_BUTTON_CLASS}
              onClick={() => onStartRecording(entry.action)}
            >
              Retry
            </button>
          </div>
        </div>
        <div className="pt-1 text-xs text-error">
          Already used by &ldquo;{conflict.label}&rdquo;
        </div>
      </div>
    );
  }

  // Recording state — waiting for input
  if (isRecording) {
    return (
      <div className="flex items-center justify-between bg-primary/5 !py-2.5 shadow-[inset_2px_0_0_0_var(--color-primary)]">
        <span className="text-sm">{entry.label}</span>
        <div className="flex items-center gap-2">
          <span className="animate-pulse text-xs text-primary/80">
            {isNewWorkspaceDialogShortcut(entry.action)
              ? 'Press keys...'
              : 'Press keys or double-tap a modifier...'}
          </span>
          <span className="text-2xs text-muted-foreground/50">Esc to cancel</span>
        </div>
      </div>
    );
  }

  // Range row (e.g., workspace 1–9)
  if (isRange && entry.rangeActions) {
    const first = getDisplayShortcut(entry.rangeActions.first);
    const last = getDisplayShortcut(entry.rangeActions.last);
    if (!first || !last) return null;

    return (
      <div className="flex items-center justify-between !py-2.5 transition-colors hover:bg-accent/50">
        <span className="text-sm">{entry.label}</span>
        <button
          type="button"
          aria-label={`Change shortcut for ${entry.label} (${first} to ${last})`}
          onClick={() => onStartRecording(entry.action)}
          className={`${SHORTCUT_CHIP_BUTTON_CLASS} flex items-center gap-1`}
        >
          <Kbd className={SHORTCUT_CHIP_CLASS}>{first}</Kbd>
          <span className="text-xs text-muted-foreground/50">&hellip;</span>
          <Kbd className={SHORTCUT_CHIP_CLASS}>{last}</Kbd>
        </button>
      </div>
    );
  }

  // Normal row (including DoubleTap shortcuts — all are editable), or one not set yet
  const display = getDisplayShortcut(entry.action);

  return (
    <div className="group/row flex items-center justify-between !py-2.5 transition-colors hover:bg-accent/50">
      <span className="text-sm">{entry.label}</span>
      <div className="flex items-center gap-1">
        {display && (
          <IconButton
            label={`Remove shortcut for ${entry.label}`}
            size="xs"
            className="text-muted-foreground opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
            onClick={() => onClear(entry.action)}
          >
            <X className="size-3" />
          </IconButton>
        )}
        <button
          type="button"
          aria-label={`Change shortcut for ${entry.label} (${display || 'not set'})`}
          onClick={() => onStartRecording(entry.action)}
          className={SHORTCUT_CHIP_BUTTON_CLASS}
        >
          {display ? (
            <Kbd className={SHORTCUT_CHIP_CLASS}>{display}</Kbd>
          ) : (
            <Kbd
              className={`${SHORTCUT_CHIP_CLASS} border-dashed bg-transparent text-muted-foreground/60`}
            >
              Not set
            </Kbd>
          )}
        </button>
      </div>
    </div>
  );
}
