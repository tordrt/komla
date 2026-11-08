import type { PromptDraftText } from '../types/prompt-draft-window';

/**
 * `draft` put after `text`, with a blank line between them unless `text` is blank, and its
 * cursor moved along with it: two drafts joined, as one pops back in or out onto another.
 */
export function appendDraft(text: string, draft: PromptDraftText): PromptDraftText {
  const offset = text.trim() ? text.length + 2 : 0;
  if (!offset) return draft;
  return {
    text: `${text}\n\n${draft.text}`,
    selectionStart: draft.selectionStart + offset,
    selectionEnd: draft.selectionEnd + offset,
  };
}
