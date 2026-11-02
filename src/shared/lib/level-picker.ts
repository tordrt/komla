import {
  LEVEL_PICKER_ICONS,
  type AgentPreset,
  type LevelPickerIcon,
  type LevelPicker,
  type ReasoningLevel,
} from '../types/agent-preset';

export const DEFAULT_LEVEL_PICKER_TITLE = 'Effort';
export const DEFAULT_LEVEL_PICKER_ICON: LevelPickerIcon = 'gauge';

/** The level picker's title, icon and visibility, with the effort defaults for what a preset leaves unset. */
export function levelPickerOf(preset: Pick<AgentPreset, 'levelPicker'>): Required<LevelPicker> {
  // Hand-edited preset files can hold anything here.
  const { title, icon, hidden } = (preset.levelPicker ?? {}) as Record<string, unknown>;
  return {
    title: (typeof title === 'string' && title.trim()) || DEFAULT_LEVEL_PICKER_TITLE,
    icon: LEVEL_PICKER_ICONS.includes(icon as LevelPickerIcon)
      ? (icon as LevelPickerIcon)
      : DEFAULT_LEVEL_PICKER_ICON,
    hidden: hidden === true,
  };
}

/** The levels a picker offers: none while the preset hides its picker, so launches use the agent default. */
export function shownReasoningLevels(
  preset: Pick<AgentPreset, 'levelPicker' | 'reasoningLevels'>
): ReasoningLevel[] {
  return levelPickerOf(preset).hidden ? [] : (preset.reasoningLevels ?? []);
}

/** Whether two levels share a name. Agents name levels to keep them, so names must differ. */
export function hasDuplicateLevelNames(levels: Pick<ReasoningLevel, 'name'>[]): boolean {
  const names = levels.map((level) => level.name.trim()).filter(Boolean);
  return new Set(names).size !== names.length;
}

/** What a preset stores for a picker: only what differs from the defaults. */
export function storedLevelPicker({ title, icon, hidden }: Required<LevelPicker>): LevelPicker {
  return {
    ...(title !== DEFAULT_LEVEL_PICKER_TITLE && { title }),
    ...(icon !== DEFAULT_LEVEL_PICKER_ICON && { icon }),
    ...(hidden && { hidden }),
  };
}
