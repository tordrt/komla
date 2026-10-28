import { Sparkle, Terminal } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Select } from '@/components/ui/select';
import { isActionAvailableForProject } from '@/lib/action-visibility';
import { cn } from '@/lib/utils';
import { useActionsStore } from '@/stores/actions.store';
import { useConfigStore } from '@/stores/config.store';

import {
  AHEAD_ACTION_DESCRIPTIONS,
  AHEAD_ACTION_LABELS,
  BEHIND_ACTION_DESCRIPTIONS,
  BEHIND_ACTION_LABELS,
  BUILT_IN_AHEAD_ACTIONS,
} from './git-setting-labels';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

import type { AheadChoice, ProjectDraft } from './project-settings-draft';
import type { SimpleAheadAction } from '../../../../shared/types';
import type { BehindTargetAction } from '@/types';

// What the project's choice does, with the app-wide setting in place of 'default'.
function effectiveAheadAction(
  choice: AheadChoice,
  appWide: SimpleAheadAction | undefined,
  builtIn: SimpleAheadAction
): SimpleAheadAction {
  return choice === 'default' ? (appWide ?? builtIn) : choice;
}

function openActionsSettings() {
  window.dispatchEvent(new CustomEvent('open-settings', { detail: 'actions' }));
}

/** Picks a quick command the project can see; without a project, one every project can see. */
export function ActionPicker({
  projectId,
  selectedId,
  onSelect,
  className = 'w-72',
}: {
  projectId?: string;
  selectedId: string;
  onSelect: (id: string) => void;
  className?: string;
}) {
  const { actions } = useActionsStore();
  const availableActions = actions.filter((t) => isActionAvailableForProject(t, projectId));
  const commandActions = availableActions.filter((t) => t.type === 'command');
  const promptOnlyActions = availableActions.filter((t) => t.type !== 'command');
  const selectedAction = availableActions.find((t) => t.id === selectedId);
  const hasCommands = commandActions.length > 0;
  const hasPrompts = promptOnlyActions.length > 0;

  if (availableActions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No quick commands yet.{' '}
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={openActionsSettings}
        >
          Manage Quick Commands
        </button>
      </p>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className={cn(className, 'justify-start gap-2 font-normal')}>
          {selectedAction ? (
            <>
              {selectedAction.type === 'command' ? (
                <Terminal className="size-3.5 text-muted-foreground" />
              ) : (
                <Sparkle className="size-3.5 text-muted-foreground" />
              )}
              <span className="truncate">{selectedAction.title}</span>
            </>
          ) : (
            <span className="text-muted-foreground">Select a quick command...</span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-(--radix-dropdown-menu-trigger-width) min-w-0">
        {hasCommands && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Terminal className="size-3" />
              Terminal Commands
            </DropdownMenuLabel>
            {commandActions.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => onSelect(t.id)}>
                <Terminal />
                {t.title}
              </DropdownMenuItem>
            ))}
          </>
        )}
        {hasCommands && hasPrompts && <DropdownMenuSeparator />}
        {hasPrompts && (
          <>
            <DropdownMenuLabel className="flex items-center gap-1.5">
              <Sparkle className="size-3" />
              Saved Prompts
            </DropdownMenuLabel>
            {promptOnlyActions.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => onSelect(t.id)}>
                <Sparkle />
                {t.title}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={openActionsSettings} className="text-muted-foreground">
          Manage Quick Commands...
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface CommitButtonsCardProps {
  projectId: string;
  draft: ProjectDraft;
  onChange: (changes: Partial<ProjectDraft>) => void;
}

/** What clicking the commits ahead (↑N) and behind (↓N) counts on workspace cards does. */
export function CommitButtonsCard({ projectId, draft, onChange }: CommitButtonsCardProps) {
  const gitDefaults = useConfigStore((s) => s.config?.gitDefaults);
  // Both app-wide ↑N choices are set together. Without them a project asks on first click,
  // unless it sets one choice itself: the other then gets its built-in action.
  const asksFirst =
    !gitDefaults?.aheadMainAction &&
    draft.autoMainAction === 'default' &&
    draft.autoOtherAction === 'default';
  const mainAction = effectiveAheadAction(
    draft.autoMainAction,
    gitDefaults?.aheadMainAction,
    BUILT_IN_AHEAD_ACTIONS.main
  );
  const otherAction = effectiveAheadAction(
    draft.autoOtherAction,
    gitDefaults?.aheadOtherAction,
    BUILT_IN_AHEAD_ACTIONS.other
  );
  const appWidePush = gitDefaults?.autoPushAfterMerge !== false;
  const appWideBehind = gitDefaults?.behindTargetAction ?? 'auto';

  const actionRow = (label: string, selectedId: string, onSelect: (id: string) => void) => (
    <SettingsRow label={label}>
      <ActionPicker projectId={projectId} selectedId={selectedId} onSelect={onSelect} />
    </SettingsRow>
  );
  const aheadRow = (
    label: string,
    target: string,
    choice: AheadChoice,
    effective: SimpleAheadAction,
    options: readonly SimpleAheadAction[],
    onSelect: (choice: AheadChoice) => void
  ) => (
    <SettingsRow
      label={label}
      description={`When the target is ${target}. ${
        choice === 'default' && asksFirst
          ? 'Asks what to do on the first click.'
          : AHEAD_ACTION_DESCRIPTIONS[effective]
      }`}
    >
      <Select
        className="w-72"
        value={choice}
        onChange={(e) => onSelect(e.target.value as AheadChoice)}
      >
        <option value="default">
          Default ({asksFirst ? 'ask on first click' : AHEAD_ACTION_LABELS[effective]})
        </option>
        {options.map((action) => (
          <option key={action} value={action}>
            {AHEAD_ACTION_LABELS[action]}
          </option>
        ))}
      </Select>
    </SettingsRow>
  );

  return (
    <SettingsCard
      title="Commit buttons"
      description="What clicking the commits ahead (↑N) and behind (↓N) counts on workspace cards does. Default follows Settings → Git."
    >
      {aheadRow(
        'Commits ahead (↑N), default branch',
        "main, master or origin's default branch",
        draft.autoMainAction,
        mainAction,
        ['pr', 'merge', 'agent-prompt', 'disabled'],
        (autoMainAction) => onChange({ autoMainAction })
      )}
      {draft.autoMainAction === 'agent-prompt' &&
        actionRow(
          'Quick command to run for the default branch',
          draft.autoMainActionId,
          (autoMainActionId) => onChange({ autoMainActionId })
        )}

      {aheadRow(
        'Commits ahead (↑N), other branches',
        'any other branch',
        draft.autoOtherAction,
        otherAction,
        ['merge', 'pr', 'agent-prompt', 'disabled'],
        (autoOtherAction) => onChange({ autoOtherAction })
      )}
      {draft.autoOtherAction === 'agent-prompt' &&
        actionRow(
          'Quick command to run for other branches',
          draft.autoOtherActionId,
          (autoOtherActionId) => onChange({ autoOtherActionId })
        )}

      {(mainAction === 'merge' || otherAction === 'merge') && (
        <SettingsRow
          label="Push target branch after fast-forward"
          description="Pushes the target branch to its remote after fast-forwarding it."
        >
          <Select
            className="w-72"
            value={
              draft.autoPushAfterMerge === undefined ? 'default' : String(draft.autoPushAfterMerge)
            }
            onChange={(e) =>
              onChange({
                autoPushAfterMerge:
                  e.target.value === 'default' ? undefined : e.target.value === 'true',
              })
            }
          >
            <option value="default">Default ({appWidePush ? 'push' : "don't push"})</option>
            <option value="true">Push</option>
            <option value="false">Don't push</option>
          </Select>
        </SettingsRow>
      )}

      <SettingsRow
        label="Commits behind (↓N)"
        description={
          BEHIND_ACTION_DESCRIPTIONS[
            draft.behindAction === 'default' ? appWideBehind : draft.behindAction
          ]
        }
      >
        <Select
          className="w-72"
          value={draft.behindAction}
          onChange={(e) =>
            onChange({ behindAction: e.target.value as BehindTargetAction | 'default' })
          }
        >
          <option value="default">Default ({BEHIND_ACTION_LABELS[appWideBehind]})</option>
          {(['auto', 'rebase', 'merge'] as const).map((action) => (
            <option key={action} value={action}>
              {BEHIND_ACTION_LABELS[action]}
            </option>
          ))}
        </Select>
      </SettingsRow>
    </SettingsCard>
  );
}
