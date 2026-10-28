import { GitBranch, ListChecks, SlidersHorizontal, type Icon } from '@phosphor-icons/react';

import { settingsCardId } from './settings-search';

/** The parts of a git project's settings, each listed under the project in the Settings nav. */
export type ProjectSection = 'general' | 'git' | 'setup';

export const PROJECT_SECTIONS: ReadonlyArray<{
  value: ProjectSection;
  label: string;
  icon: Icon;
  /** Titles of the cards it shows, so a search result or link to a card opens its section. */
  cards: readonly string[];
}> = [
  {
    value: 'general',
    label: 'General',
    icon: SlidersHorizontal,
    cards: ['General', 'SSH workspaces', 'Danger zone'],
  },
  { value: 'git', label: 'Git', icon: GitBranch, cards: ['Branches', 'Commit buttons'] },
  {
    value: 'setup',
    label: 'Setup',
    icon: ListChecks,
    cards: ['Setup steps', 'Quick add', 'Trash cleanup'],
  },
];

export function projectSectionOfCard(cardId: string | undefined): ProjectSection | undefined {
  if (!cardId) return undefined;
  return PROJECT_SECTIONS.find(({ cards }) =>
    cards.some((title) => settingsCardId(title) === cardId)
  )?.value;
}
