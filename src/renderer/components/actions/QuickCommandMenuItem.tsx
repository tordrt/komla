import { Play, Sparkle } from '@phosphor-icons/react';

import { ActionRunMenuList, keepEscapeForActionSearch } from '@/components/actions/ActionRunList';
import { MENU_PARTS } from '@/components/ui/menu-parts';
import { getDefaultAction, type ActionMenuGroup } from '@/lib/action-menu-order';

import type { Action, AgentPreset } from '@/types';

interface QuickCommandMenuItemProps {
  menuType: 'context' | 'dropdown';
  groups: ActionMenuGroup[];
  /** The Action the row reruns, when it is still listed. */
  defaultActionId: string | undefined;
  presets: AgentPreset[];
  /** Says what the row does with its Action, where the menu around it doesn't. */
  hint?: string;
  /** Greys out the row and its list, leaving New quick command when there is no Action yet. */
  disabled?: boolean;
  /** Runs an Action, which makes it this place's default. */
  onRun: (action: Action) => void;
  onNew: () => void;
  onManage: () => void;
}

/**
 * Like the tab bar's Actions split button: the row reruns the place's default Action, its
 * arrow lists every Action for the project. With none yet, the row opens the editor. The
 * list has no menu items, so its callbacks close the menu themselves.
 */
export function QuickCommandMenuItem({
  menuType,
  groups,
  defaultActionId,
  presets,
  hint,
  disabled = false,
  onRun,
  onNew,
  onManage,
}: QuickCommandMenuItemProps) {
  const { Item, Shortcut, Sub, SubContent, SubTrigger } = MENU_PARTS[menuType];
  const defaultAction = getDefaultAction(groups, defaultActionId);

  if (!defaultAction) {
    return (
      <Item onSelect={onNew}>
        <Play weight="fill" />
        New quick command
      </Item>
    );
  }

  return (
    <Sub>
      <div className="flex items-stretch">
        <Item className="flex-1 pr-1" disabled={disabled} onSelect={() => onRun(defaultAction)}>
          {defaultAction.type === 'command' ? <Play weight="fill" /> : <Sparkle />}
          <span className="truncate">{defaultAction.title}</span>
          {hint && <Shortcut>{hint}</Shortcut>}
        </Item>
        <SubTrigger
          aria-label="More quick commands"
          disabled={disabled}
          className="ml-0.5 flex-none px-1.5"
        />
      </div>
      <SubContent className="w-80 p-0" onEscapeKeyDown={keepEscapeForActionSearch}>
        <ActionRunMenuList
          groups={groups}
          presets={presets}
          initialActiveId={defaultAction.id}
          onRun={onRun}
          onNew={onNew}
          onManage={onManage}
        />
      </SubContent>
    </Sub>
  );
}
