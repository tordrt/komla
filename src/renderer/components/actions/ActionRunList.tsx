import {
  Check,
  Copy,
  GearSix,
  MagnifyingGlass,
  Plus,
  Sparkle,
  Terminal,
} from '@phosphor-icons/react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

import { menuLabelClass } from '@/components/ui/menu-styles';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  filterActionMenuGroups,
  getActionPreview,
  type ActionMenuGroup,
} from '@/lib/action-menu-order';

import type { Action, AgentPreset } from '@/types';

export interface ActionRunListProps {
  groups: ActionMenuGroup[];
  presets: AgentPreset[];
  /** Highlighted until the user moves or types; the run button's Action. */
  initialActiveId: string | null;
  onRun: (action: Action) => void;
  onNew: () => void;
  onManage: () => void;
}

type ActionType = ActionMenuGroup['type'];

const TABS: { type: ActionType; label: string; Icon: typeof Sparkle }[] = [
  { type: 'prompt', label: 'Prompts', Icon: Sparkle },
  { type: 'command', label: 'Commands', Icon: Terminal },
];

/**
 * For the popover or menu holding the list: Escape clears a search box that still has
 * text instead of closing, like Settings search.
 */
export function keepEscapeForActionSearch(event: globalThis.KeyboardEvent) {
  const target = event.target;
  if (
    target instanceof HTMLInputElement &&
    target.dataset.clearsOnEscape !== undefined &&
    target.value !== ''
  ) {
    event.preventDefault();
  }
}

/**
 * The list inside a menu's submenu. Keys typed in it stay there: the menu would take
 * letters for typeahead, trap Tab and close the submenu on ArrowLeft, even with Cmd or
 * Ctrl, which move the caret. Other Cmd and Ctrl shortcuts reach the app.
 */
export function ActionRunMenuList(props: ActionRunListProps) {
  return (
    <div
      onKeyDown={(event) => {
        if (
          event.key === 'ArrowLeft' ||
          (event.key !== 'Escape' && !event.metaKey && !event.ctrlKey)
        ) {
          event.stopPropagation();
        }
      }}
    >
      <ActionRunList {...props} />
    </div>
  );
}

/**
 * The Actions available in a workspace, as a searchable list: type to filter, arrow keys
 * move, Enter runs the highlighted one. With both prompts and commands, tabs show one type
 * at a time, starting on the run button Action's type; the left and right arrows switch
 * them while the search is empty, and a search with no matches in the tab shows the other.
 * Each row shows its title and, for a prompt, its agent; hovering shows what it runs, which
 * the search also matches, and offers copy. Editing and deleting live in Settings.
 */
export function ActionRunList({
  groups,
  presets,
  initialActiveId,
  onRun,
  onNew,
  onManage,
}: ActionRunListProps) {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(initialActiveId);
  const [tab, setTab] = useState<ActionType>(
    () =>
      groups.find((group) => group.actions.some((action) => action.id === initialActiveId))?.type ??
      'prompt'
  );
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const optionId = (id: string) => `${listboxId}-${id}`;

  const total = groups.reduce((count, group) => count + group.actions.length, 0);
  const showSearch = total > 1;
  const showTabs = groups.length > 1;
  const matchingGroups = filterActionMenuGroups(groups, query);
  const tabGroup = matchingGroups.find((group) => group.type === tab) ?? matchingGroups[0];
  const filteredGroups = showTabs ? (tabGroup ? [tabGroup] : []) : matchingGroups;
  const shownTab = tabGroup?.type ?? tab;
  const filtered = filteredGroups.flatMap((group) => group.actions);
  const active = filtered.find((action) => action.id === activeId) ?? filtered[0] ?? null;

  const activeOptionId = active ? optionId(active.id) : undefined;

  useEffect(() => {
    if (activeOptionId) {
      document.getElementById(activeOptionId)?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [activeOptionId]);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    []
  );

  // Ready for typing or arrow keys as soon as it opens. A menu leaves a submenu opened
  // by pointer unfocused, and with no menu items in it the keys would go nowhere. A frame
  // later, so the parent menu has stopped trapping focus and won't take it back.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      (searchRef.current ?? listboxRef.current)?.focus({ preventScroll: true })
    );
    return () => cancelAnimationFrame(frame);
  }, []);

  const copy = (action: Action) => {
    window.api.copyToClipboard(action.content);
    setCopiedId(action.id);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedId(null), 1500);
  };

  const showTab = (type: ActionType) => {
    setTab(type);
    // Its first row, unless it holds the run button Action.
    setActiveId(initialActiveId);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // Enter and the arrows belong to an input method while it composes text.
    if (event.nativeEvent.isComposing) return;
    // The row buttons (copy, split, insert) keep their own keys.
    if (event.target instanceof HTMLButtonElement) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        if (filtered.length === 0) return;
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        const index = active ? filtered.indexOf(active) : -1;
        setActiveId(filtered[(index + step + filtered.length) % filtered.length].id);
        break;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
        // With text in the search box, the arrows move its caret.
        if (!showTabs || query) return;
        event.preventDefault();
        showTab(event.key === 'ArrowLeft' ? TABS[0].type : TABS[1].type);
        break;
      case 'Enter':
        if (!active) return;
        event.preventDefault();
        onRun(active);
        break;
      case 'Escape':
        // The popover leaves Escape to a search box that still has text (see ActionTabButton).
        if (query) {
          setQuery('');
          setActiveId(initialActiveId);
        }
        break;
    }
  };

  const presetName = (presetId: string | undefined) =>
    presetId ? presets.find((preset) => preset.id === presetId)?.name : undefined;

  return (
    <div onKeyDown={handleKeyDown}>
      {showSearch && (
        <div className="relative border-b border-foreground/10">
          <MagnifyingGlass className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground/60" />
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-label="Search quick commands"
            aria-expanded="true"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-activedescendant={activeOptionId}
            data-clears-on-escape=""
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveId(null);
            }}
            placeholder="Search quick commands…"
            spellCheck={false}
            className="h-9 w-full bg-transparent pr-3 pl-8 text-xs text-foreground outline-hidden placeholder:text-muted-foreground/60"
          />
        </div>
      )}
      {showTabs && (
        <SegmentedControl
          aria-label="Quick command type"
          fill
          value={shownTab}
          onValueChange={(type) => {
            showTab(type);
            searchRef.current?.focus({ preventScroll: true });
          }}
          options={TABS.map(({ type, label, Icon }) => {
            const count = matchingGroups.find((group) => group.type === type)?.actions.length ?? 0;
            return {
              value: type,
              ariaLabel: label,
              icon: <Icon className="size-3" />,
              label: (
                <>
                  {label}
                  <span className="font-normal text-muted-foreground tabular-nums">{count}</span>
                </>
              ),
              disabled: count === 0,
            };
          })}
          className="mx-1.5 mt-1.5"
        />
      )}
      <div
        ref={listboxRef}
        id={listboxId}
        role="listbox"
        aria-label="Quick commands"
        // Without a search box the list takes focus itself, so the keys above still work.
        tabIndex={showSearch ? undefined : 0}
        aria-activedescendant={showSearch ? undefined : activeOptionId}
        className="max-h-80 overflow-y-auto p-1 outline-hidden"
      >
        {filteredGroups.map((group) => (
          <div key={group.label} role="group" aria-label={group.label}>
            {!showTabs && (
              <div role="presentation" className={menuLabelClass}>
                {group.label}
              </div>
            )}
            {group.actions.map((action) => {
              const Icon = action.type === 'command' ? Terminal : Sparkle;
              const preset = action.type === 'command' ? undefined : presetName(action.presetId);
              return (
                <div
                  key={action.id}
                  id={optionId(action.id)}
                  role="option"
                  aria-selected={action.id === active?.id}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActiveId(action.id)}
                  onClick={() => onRun(action)}
                  title={getActionPreview(action)}
                  className="group/action-row flex cursor-default items-center gap-2 rounded-md px-2 py-1 aria-selected:bg-foreground/8"
                >
                  <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-foreground">
                    {action.title}
                  </span>
                  {preset && (
                    <span className="max-w-28 shrink-0 truncate text-[11px] leading-4 text-muted-foreground">
                      {preset}
                    </span>
                  )}
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/action-row:opacity-100 group-aria-selected/action-row:opacity-100 focus-within:opacity-100">
                    <RowButton
                      label={copiedId === action.id ? 'Copied' : `Copy ${action.title}`}
                      onClick={() => copy(action)}
                    >
                      {copiedId === action.id ? (
                        <Check className="size-3 text-success" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                    </RowButton>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {filtered.length === 0 && (
          <p className="px-2 py-4 text-center text-xs text-muted-foreground">
            {total === 0 ? 'No quick commands yet' : 'No quick commands match'}
          </p>
        )}
      </div>
      <div className="flex items-center justify-between gap-1 border-t border-foreground/10 p-1">
        <FooterButton onClick={onNew}>
          <Plus className="size-3.5" />
          New quick command
        </FooterButton>
        <FooterButton onClick={onManage}>
          <GearSix className="size-3.5" />
          Manage
        </FooterButton>
      </div>
    </div>
  );
}

function RowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  // The row runs its Action on click; these buttons must not also run it.
  const stop = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={stop}
      onClick={(event) => {
        stop(event);
        onClick();
      }}
      className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
    >
      {children}
    </button>
  );
}

function FooterButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] leading-[18px] text-muted-foreground hover:bg-foreground/8 hover:text-foreground focus-visible:bg-foreground/8 focus-visible:outline-hidden"
    >
      {children}
    </button>
  );
}
