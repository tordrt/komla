import { buildSkillFetchInstruction } from './skill-fetch-instruction';

const ASK_WHAT_TO_CHANGE =
  "Then ask me what I'd like to change, such as a status bar item, a hook, a keyboard shortcut or the theme.";

export const ASK_FOR_STATUS_ITEM =
  'Then run `komla skill status-items` for what an item can show and how to make it look good, and ask me what my new status bar item should show and how often it should update.';

export const SUGGEST_STATUS_ITEMS =
  "Then run `komla skill status-items`, which lists Komla's built-in status bar items and how to make your own look good. Tell me that Komla has many built-in status bar items I can turn on by right-clicking the status bar, and above all that you can make me my own here, such as status bar items, hooks and shortcuts. Suggest a few that would help in this project and ask me what I'd like to change.";

// Prompt for the entries, in Tips, the status bar's menu and the built-in Action, that have an
// agent change Komla's settings.
export function buildCustomizePrompt(ask = ASK_WHAT_TO_CHANGE): string {
  return `# Customize Komla

${buildSkillFetchInstruction('customize')} ${ask}`;
}
