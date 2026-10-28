import { MagnifyingGlass, PencilSimple, X } from '@phosphor-icons/react';
import { Fragment, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { shortcutEntries, groupOrder } from '@/constants/shortcut-entries';
import { cn } from '@/lib/utils';
import { formatShortcutKeys, useShortcutsStore, type ShortcutKeys } from '@/stores/shortcuts.store';

interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenShortcutsSettings?: () => void;
}

const essentialShortcuts = [
  { action: 'commandCenter.open', label: 'Command center' },
  { action: 'workspace.new', label: 'New workspace' },
  { action: 'workspace.next', label: 'Next workspace' },
  { action: 'workspace.previous', label: 'Previous workspace' },
  { action: 'tab.newAgent', label: 'New agent tab' },
  { action: 'terminal.new', label: 'New terminal tab' },
  { action: 'voice.record', label: 'Voice dictation' },
  { action: 'app.newWindow', label: 'New window', fixedShortcut: getNewWindowShortcut() },
] as const;

export function ShortcutsDialog({
  open,
  onOpenChange,
  onOpenShortcutsSettings,
}: ShortcutsDialogProps) {
  const { getDisplayKeys, config } = useShortcutsStore();
  const [query, setQuery] = useState('');
  const searching = query.trim() !== '';

  // Unbound actions are left out before filtering, so a group with nothing left to show
  // drops its heading and an empty search result says so.
  const filteredGroups = useMemo(() => {
    if (!config) return [];
    const q = query.trim().toLowerCase();
    return groupOrder
      .map((group) => ({
        group,
        rows: shortcutEntries
          .filter((e) => e.group === group && (!q || e.label.toLowerCase().includes(q)))
          .flatMap((entry) => {
            const keys = getDisplayKeys(entry.rangeActions?.first ?? entry.action);
            const last = entry.rangeActions ? getDisplayKeys(entry.rangeActions.last) : undefined;
            if (!keys || last === null) return [];
            return [{ action: entry.action, label: entry.label, keys, last }];
          }),
      }))
      .filter((g) => g.rows.length > 0);
  }, [config, getDisplayKeys, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Anchored at the top so the dialog shrinks upward while a search narrows the list.
        className="top-[max(2rem,calc(50dvh-360px))] flex max-h-[min(720px,calc(100dvh-4rem))] w-[800px] max-w-[92vw] translate-y-0 flex-col gap-0 overflow-hidden p-0"
        showCloseButton={false}
        onOpenAutoFocus={() => setQuery('')}
        // The first Escape clears a search, as in Settings, and the next one closes.
        onEscapeKeyDown={(event) => {
          if (!query) return;
          event.preventDefault();
          setQuery('');
        }}
      >
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-foreground/10 pr-2 pl-4">
          <DialogTitle className="text-sm">Keyboard Shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            Browse and search keyboard shortcuts
          </DialogDescription>
          <div className="relative ml-auto w-56">
            <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search shortcuts"
              aria-label="Search keyboard shortcuts"
              className="h-7 w-full rounded-md border border-foreground/10 bg-foreground/[0.04] pr-2 pl-8 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground/25 focus:outline-hidden"
            />
          </div>
          <DialogClose className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden">
            <X className="size-4" />
            <span className="sr-only">Close</span>
          </DialogClose>
        </div>

        <div className="min-h-0 flex-1 scroll-fade-bottom overflow-y-auto px-4 pt-4 pb-5">
          {searching && filteredGroups.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">
              No shortcuts match “{query.trim()}”
            </p>
          ) : (
            <>
              {!searching && config && (
                <section aria-labelledby="shortcuts-essentials" className="mb-6">
                  <SectionLabel id="shortcuts-essentials">Essentials</SectionLabel>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {essentialShortcuts.map((entry) => {
                      const keys =
                        'fixedShortcut' in entry
                          ? entry.fixedShortcut
                          : getDisplayKeys(entry.action);
                      if (!keys) return null;
                      return (
                        <div
                          key={entry.action}
                          className="flex flex-col items-start gap-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.03] px-3 py-2"
                        >
                          <KeyCaps shortcut={keys} />
                          <span className="text-xs text-muted-foreground">{entry.label}</span>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <div className="gap-8 sm:columns-2">
                {filteredGroups.map(({ group, rows }) => (
                  <section
                    key={group}
                    aria-labelledby={`shortcuts-${group}`}
                    className="mb-5 break-inside-avoid"
                  >
                    <SectionLabel id={`shortcuts-${group}`}>{group}</SectionLabel>
                    <div>
                      {rows.map((row) => (
                        <ShortcutRow key={row.action} label={row.label}>
                          {row.last ? (
                            <KeyRange first={row.keys} last={row.last} />
                          ) : (
                            <KeyCaps shortcut={row.keys} />
                          )}
                        </ShortcutRow>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex h-10 shrink-0 items-center gap-4 border-t border-foreground/10 px-4 text-xs text-muted-foreground">
          <span>
            <Kbd>Esc</Kbd> Close
          </span>
          {onOpenShortcutsSettings && (
            <Button
              variant="ghost"
              size="sm"
              className="-mr-2 ml-auto h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={() => {
                onOpenChange(false);
                onOpenShortcutsSettings();
              }}
            >
              <PencilSimple className="size-3.5" />
              Customize shortcuts
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionLabel({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3
      id={id}
      className="mb-1.5 px-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase"
    >
      {children}
    </h3>
  );
}

function ShortcutRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between gap-3 rounded-md px-2 text-[13px] transition-colors hover:bg-foreground/[0.04]">
      <span className="truncate" title={label}>
        {label}
      </span>
      <span className="flex shrink-0 items-center gap-1">{children}</span>
    </div>
  );
}

/** One keycap per key, with "+" between them where the display form has one. */
function KeyCaps({ shortcut: { keys, separator } }: { shortcut: ShortcutKeys }) {
  return (
    <span className="inline-flex items-center gap-1">
      {keys.map((key, index) => (
        // The keys up to this one, since a double tap repeats a key.
        <Fragment key={keys.slice(0, index + 1).join(' ')}>
          {index > 0 && separator === '+' && (
            <span className="text-2xs text-muted-foreground/60">+</span>
          )}
          <KeyCap>{key}</KeyCap>
        </Fragment>
      ))}
    </span>
  );
}

/** "⌘1 … ⌘9" as ⌘ 1–9 when both ends share their modifiers. */
function KeyRange({ first, last }: { first: ShortcutKeys; last: ShortcutKeys }) {
  if (first.keys.slice(0, -1).join() !== last.keys.slice(0, -1).join()) {
    return (
      <>
        <KeyCaps shortcut={first} />
        <span className="text-xs text-muted-foreground/60">&hellip;</span>
        <KeyCaps shortcut={last} />
      </>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <KeyCaps shortcut={first} />
      <span className="text-xs text-muted-foreground/60">–</span>
      <KeyCap>{last.keys.at(-1)}</KeyCap>
    </span>
  );
}

function KeyCap({ children }: { children: React.ReactNode }) {
  return (
    <Kbd
      className={cn(
        'h-5 min-w-5 rounded-[5px] border-foreground/10 bg-foreground/[0.06] px-1.5 text-xs text-foreground/80',
        'shadow-[inset_0_-1px_0_rgb(0_0_0/0.25)]'
      )}
    >
      {children}
    </Kbd>
  );
}

function getNewWindowShortcut(): ShortcutKeys {
  // Matches the CmdOrCtrl+Shift+N menu accelerator in the main process.
  return formatShortcutKeys('Cmd+Shift+N');
}
