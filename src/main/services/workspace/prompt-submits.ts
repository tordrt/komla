import type { Workspace, WorkspacePromptSubmit } from '../../../shared/types';

const MAX_PROMPT_SUBMITS_PER_WORKSPACE = 1_000;

// The first prompts usually state the workspace's task, so history limits keep them.
const PINNED_FIRST_PROMPT_SUBMITS = 3;

const MAX_STORED_PROMPT_CHARS = 32_000;

// Final replies are mostly a short summary; their start and end say what the turn was about.
const MAX_STORED_AGENT_REPLY_CHARS = 2_000;

const MAX_STORED_PROMPT_HISTORY_CHARS = 256_000;

// Each prompt gets a limit so a long paste can't crowd out the turns around it.
const MAX_RENAME_PROMPT_CHARS = 8_000;

const MAX_RENAME_PROMPT_CONTEXT_CHARS = 100_000;

const RENAME_PROMPT_CONTEXT_SEPARATOR = '\n';

const PROMPT_TRUNCATED_MARKER = '\n\n[...PROMPT_TRUNCATED...]\n\n';

const INLINE_IMAGE_DATA_REGEX = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi;

export function normalizePromptSubmits(value: unknown): Workspace['promptSubmits'] | undefined {
  if (!Array.isArray(value)) return undefined;

  const prompts = value
    .filter(
      (
        entry
      ): entry is { prompt: string; submittedAt: number; terminalId?: unknown; reply?: unknown } =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)['prompt'] === 'string' &&
        typeof (entry as Record<string, unknown>)['submittedAt'] === 'number'
    )
    .map((entry) => ({
      prompt: truncatePromptForStorage(entry.prompt),
      submittedAt: entry.submittedAt,
      ...(typeof entry.terminalId === 'string' && { terminalId: entry.terminalId }),
      ...(typeof entry.reply === 'string' && { reply: truncateReplyForStorage(entry.reply) }),
    }));

  return compactPromptSubmits(prompts);
}

function wrapRenamePrompt(prompt: string): string {
  return `<prompt>\n${prompt}\n</prompt>`;
}

function wrapRenameReply(reply: string): string {
  return `<agent_reply>\n${reply}\n</agent_reply>`;
}

function dropLoneHighSurrogate(value: string): string {
  return value.replace(/[\uD800-\uDBFF]$/, '');
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Dropping half of a split emoji keeps the text valid for strict JSON parsers.
  if (maxChars <= PROMPT_TRUNCATED_MARKER.length)
    return dropLoneHighSurrogate(value.slice(0, maxChars));

  const remaining = maxChars - PROMPT_TRUNCATED_MARKER.length;
  const headLength = Math.ceil(remaining / 2);
  const tailLength = Math.floor(remaining / 2);
  const head = dropLoneHighSurrogate(value.slice(0, headLength));
  const tail = value.slice(value.length - tailLength).replace(/^[\uDC00-\uDFFF]/, '');
  return `${head}${PROMPT_TRUNCATED_MARKER}${tail}`;
}

function truncatePromptForStorage(prompt: string): string {
  return truncateMiddle(omitInlineImageData(prompt), MAX_STORED_PROMPT_CHARS);
}

export function truncateReplyForStorage(reply: string): string {
  return truncateMiddle(omitInlineImageData(reply), MAX_STORED_AGENT_REPLY_CHARS);
}

function promptSubmitLength(entry: WorkspacePromptSubmit): number {
  return entry.prompt.length + (entry.reply?.length ?? 0);
}

function omitInlineImageData(prompt: string): string {
  return prompt.replace(INLINE_IMAGE_DATA_REGEX, '[IMAGE_DATA_OMITTED]');
}

export function compactPromptSubmits(
  promptSubmits: NonNullable<Workspace['promptSubmits']>
): Workspace['promptSubmits'] | undefined {
  const compacted =
    promptSubmits.length > MAX_PROMPT_SUBMITS_PER_WORKSPACE
      ? [
          ...promptSubmits.slice(0, PINNED_FIRST_PROMPT_SUBMITS),
          ...promptSubmits.slice(PINNED_FIRST_PROMPT_SUBMITS - MAX_PROMPT_SUBMITS_PER_WORKSPACE),
        ]
      : [...promptSubmits];

  let totalLength = compacted.reduce((total, entry) => total + promptSubmitLength(entry), 0);
  while (compacted.length > 1 && totalLength > MAX_STORED_PROMPT_HISTORY_CHARS) {
    // Drop the oldest unpinned prompt, but never the newest one to keep a pinned one.
    const removeIndex =
      compacted.length > PINNED_FIRST_PROMPT_SUBMITS + 1 ? PINNED_FIRST_PROMPT_SUBMITS : 0;
    const [removed] = compacted.splice(removeIndex, 1);
    totalLength -= removed ? promptSubmitLength(removed) : 0;
  }

  if (compacted.length === 1 && totalLength > MAX_STORED_PROMPT_HISTORY_CHARS) {
    compacted[0] = {
      ...compacted[0],
      prompt: truncateMiddle(compacted[0].prompt, MAX_STORED_PROMPT_HISTORY_CHARS),
    };
  }

  return compacted.length > 0 ? compacted : undefined;
}

export function normalizePromptSubmit(prompt: string | undefined): string | null {
  const normalized = prompt?.trim().replace(/\r\n|\r/g, '\n');
  if (!normalized) return null;
  return truncatePromptForStorage(normalized);
}

export function buildPromptSubmitRenameContext(workspace: Workspace): string | null {
  const promptSubmits = workspace.promptSubmits ?? [];
  if (promptSubmits.length === 0) return null;

  const pinnedCount = Math.min(PINNED_FIRST_PROMPT_SUBMITS, promptSubmits.length);
  const pinnedChunks: string[] = [];
  const latestChunks: string[] = [];
  let totalLength = 0;

  // Neutralize closing tags so prompt or reply text cannot end its block or the
  // <prompts> wrapper the inference provider adds.
  const neutralize = (text: string): string =>
    text.replace(/<\/(prompts?|agent_reply)\b/gi, '<\\/$1');

  const takeBlock = (entry: (typeof promptSubmits)[number]): string | null => {
    const separatorLength =
      pinnedChunks.length + latestChunks.length > 0 ? RENAME_PROMPT_CONTEXT_SEPARATOR.length : 0;
    const available =
      MAX_RENAME_PROMPT_CONTEXT_CHARS - totalLength - separatorLength - wrapRenamePrompt('').length;
    if (available <= 0) return null;

    // The last prompt to fit gets what room is left, still with its start and end.
    let block = wrapRenamePrompt(
      truncateMiddle(neutralize(entry.prompt), Math.min(MAX_RENAME_PROMPT_CHARS, available))
    );
    if (entry.reply) {
      const reply = RENAME_PROMPT_CONTEXT_SEPARATOR + wrapRenameReply(neutralize(entry.reply));
      // A reply is only worth its room in full.
      if (
        totalLength + separatorLength + block.length + reply.length <=
        MAX_RENAME_PROMPT_CONTEXT_CHARS
      ) {
        block += reply;
      }
    }
    totalLength += separatorLength + block.length;
    return block;
  };

  // Keep the first prompts, then fill the remaining room with the newest of the rest.
  for (let index = 0; index < pinnedCount; index++) {
    const block = takeBlock(promptSubmits[index]);
    if (!block) break;
    pinnedChunks.push(block);
  }
  for (let index = promptSubmits.length - 1; index >= pinnedCount; index--) {
    const block = takeBlock(promptSubmits[index]);
    if (!block) break;
    latestChunks.unshift(block);
  }

  const chunks = [...pinnedChunks, ...latestChunks];
  return chunks.length > 0 ? chunks.join(RENAME_PROMPT_CONTEXT_SEPARATOR) : null;
}
