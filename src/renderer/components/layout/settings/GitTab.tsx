import { useEffect, useEffectEvent, useState } from 'react';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { findPrDraftAction, isActionAvailableForProject } from '@/lib/action-visibility';
import { useActionsStore } from '@/stores/actions.store';
import { useConfigStore } from '@/stores/config.store';

import { ActionPicker } from './CommitButtonsCard';
import {
  AHEAD_ACTION_DESCRIPTIONS,
  AHEAD_ACTION_LABELS,
  BEHIND_ACTION_DESCRIPTIONS,
  BEHIND_ACTION_LABELS,
  BUILT_IN_AHEAD_ACTIONS,
} from './git-setting-labels';
import { SettingsCard } from './SettingsCard';
import { SettingsRow } from './SettingsRow';

import type { BehindTargetAction, GitDefaults, SimpleAheadAction } from '@/types';

const AHEAD_OPTIONS: Record<'main' | 'other', readonly SimpleAheadAction[]> = {
  main: ['agent-prompt', 'pr', 'merge', 'disabled'],
  other: ['merge', 'pr', 'agent-prompt', 'disabled'],
};

// Saved when the field loses focus or Settings closes, so a half-typed prefix never names a branch.
function BranchPrefixInput({
  id,
  describedBy,
  value,
  onCommit,
}: {
  id: string;
  describedBy: string | undefined;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editedFrom, setEditedFrom] = useState(value);
  if (editedFrom !== value) {
    setEditedFrom(value);
    setDraft(value);
  }
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  // Closing Settings removes the field without a blur.
  const commitOnClose = useEffectEvent(commit);
  useEffect(() => () => commitOnClose(), []);
  return (
    <Input
      id={id}
      aria-describedby={describedBy}
      className="w-64"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      placeholder="e.g. komla/"
    />
  );
}

/** Git settings every project follows unless it sets its own in its project settings. */
export function GitTab() {
  const gitDefaults = useConfigStore((s) => s.config?.gitDefaults);
  const backgroundFetch = useConfigStore((s) => s.config?.gitBackgroundFetch !== false);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const actions = useActionsStore((s) => s.actions);
  const update = (changes: Partial<GitDefaults>) =>
    updateConfig({ gitDefaults: { ...gitDefaults, ...changes } });

  // Both ↑N choices are set together: picking one fills in the other, asking clears both.
  const asksFirst = !gitDefaults?.aheadMainAction || !gitDefaults.aheadOtherAction;
  const setAhead = (kind: 'main' | 'other', value: string) => {
    if (value === 'ask') {
      void update({
        aheadMainAction: undefined,
        aheadOtherAction: undefined,
        aheadMainActionId: undefined,
        aheadOtherActionId: undefined,
      });
      return;
    }
    const action = value as SimpleAheadAction;
    const main =
      kind === 'main' ? action : (gitDefaults?.aheadMainAction ?? BUILT_IN_AHEAD_ACTIONS.main);
    const other =
      kind === 'other' ? action : (gitDefaults?.aheadOtherAction ?? BUILT_IN_AHEAD_ACTIONS.other);
    // A new quick command choice starts on the PR draft command every project can see. The
    // other row keeps its own, even one the loaded quick commands don't show.
    const actionId = (
      rowKind: 'main' | 'other',
      choice: SimpleAheadAction,
      current: string | undefined
    ) => {
      if (choice !== 'agent-prompt') return undefined;
      if (rowKind !== kind) return current;
      const kept = actions.find((a) => a.id === current && isActionAvailableForProject(a));
      return kept?.id ?? findPrDraftAction(actions)?.id;
    };
    void update({
      aheadMainAction: main,
      aheadOtherAction: other,
      aheadMainActionId: actionId('main', main, gitDefaults?.aheadMainActionId),
      aheadOtherActionId: actionId('other', other, gitDefaults?.aheadOtherActionId),
    });
  };
  const aheadRow = (kind: 'main' | 'other', label: string, target: string) => {
    const action = kind === 'main' ? gitDefaults?.aheadMainAction : gitDefaults?.aheadOtherAction;
    const actionId =
      kind === 'main' ? gitDefaults?.aheadMainActionId : gitDefaults?.aheadOtherActionId;
    const pickRow = !asksFirst && action === 'agent-prompt' && (
      <SettingsRow
        label={
          kind === 'main'
            ? 'Quick command for the default branch'
            : 'Quick command for other branches'
        }
        description="Only quick commands shown in all projects are offered. To use one scoped to a project, choose it in that project's Git settings."
      >
        <ActionPicker
          className="w-56"
          selectedId={actionId ?? ''}
          onSelect={(id) =>
            void update(kind === 'main' ? { aheadMainActionId: id } : { aheadOtherActionId: id })
          }
        />
      </SettingsRow>
    );
    return (
      <>
        <SettingsRow
          label={label}
          description={`When the target is ${target}. ${
            asksFirst || !action
              ? 'Each project asks what to do on its first click.'
              : AHEAD_ACTION_DESCRIPTIONS[action]
          }`}
        >
          <Select
            className="w-56"
            value={asksFirst || !action ? 'ask' : action}
            onChange={(e) => setAhead(kind, e.target.value)}
          >
            <option value="ask">Ask on first click</option>
            {AHEAD_OPTIONS[kind].map((option) => (
              <option key={option} value={option}>
                {AHEAD_ACTION_LABELS[option]}
              </option>
            ))}
          </Select>
        </SettingsRow>
        {pickRow}
      </>
    );
  };
  const behindAction = gitDefaults?.behindTargetAction ?? 'auto';

  return (
    <div className="space-y-8">
      <SettingsCard title="Branches">
        <SettingsRow
          label="Branch prefix"
          description="Starts the name of each new workspace branch, in projects without a prefix of their own."
        >
          {({ controlId, descriptionId }) => (
            <BranchPrefixInput
              id={controlId}
              describedBy={descriptionId}
              value={gitDefaults?.branchPrefix ?? ''}
              onCommit={(branchPrefix) => update({ branchPrefix: branchPrefix || undefined })}
            />
          )}
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Commit buttons"
        description="What clicking the commits ahead (↑N) and behind (↓N) counts on workspace cards does. These are defaults for every project; a project can choose its own under Projects → its name → Git."
      >
        {aheadRow(
          'main',
          'Commits ahead (↑N), default branch',
          "main, master or origin's default branch"
        )}
        {aheadRow('other', 'Commits ahead (↑N), other branches', 'any other branch')}
        <SettingsRow
          label="Push target branch after fast-forward"
          description="Pushes the target branch to its remote after fast-forwarding it."
        >
          <Switch
            checked={gitDefaults?.autoPushAfterMerge !== false}
            onCheckedChange={(autoPushAfterMerge) => update({ autoPushAfterMerge })}
          />
        </SettingsRow>
        <SettingsRow
          label="Commits behind (↓N)"
          description={BEHIND_ACTION_DESCRIPTIONS[behindAction]}
        >
          <Select
            className="w-56"
            value={behindAction}
            onChange={(e) => update({ behindTargetAction: e.target.value as BehindTargetAction })}
          >
            {(['auto', 'rebase', 'merge'] as const).map((action) => (
              <option key={action} value={action}>
                {BEHIND_ACTION_LABELS[action]}
              </option>
            ))}
          </Select>
        </SettingsRow>
      </SettingsCard>

      <SettingsCard title="Fetching">
        <SettingsRow
          label="Fetch in the background"
          description="When you come back to Komla, fetches origin for each project with workspaces, at most every 5 minutes, so the commits behind (↓N) counts stay current. SSH hosts fetch on the host, once Komla is connected to it. A remote that needs a password or passphrase is skipped."
        >
          <Switch
            checked={backgroundFetch}
            onCheckedChange={(gitBackgroundFetch) => void updateConfig({ gitBackgroundFetch })}
          />
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
