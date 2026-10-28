/** Strip xterm focus in/out reports (CSI I / CSI O) from terminal data. */
export function stripTerminalFocusReports(data: string): string {
  return data.replaceAll('\x1b[I', '').replaceAll('\x1b[O', '');
}

export interface TerminalOscNotification {
  title?: string;
  message: string;
}

/** Observe complete OSC 0/2 titles without consuming them from terminal output. */
export function extractTerminalTitles(data: string): string[] {
  // oxlint-disable-next-line no-control-regex -- intentional: matches ESC/BEL
  return Array.from(data.matchAll(/\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g), (match) =>
    match[1].slice(0, 1024)
  );
}

/**
 * What a program reports about itself with OSC 7501, the Program Status Protocol:
 * `state=working:app=codex`. Codex and Claude Code name no app in the `state=clear` they send as
 * they quit. A report with an `id` is a record of the program's own, such as a background
 * subagent's; one without is the program's.
 */
export interface TerminalProgramStatus {
  state: string;
  app?: string;
  kind?: string;
  id?: string;
  /** One line about the state, such as the command a permission prompt asks about. */
  msg?: string;
}

const PROGRAM_STATES = new Set(['idle', 'working', 'blocked', 'done', 'error', 'clear']);
// The protocol's limit on a decoded message.
const MAX_PROGRAM_STATUS_MESSAGE_BYTES = 2048;

/** A base64 field of a report, or null when the protocol says to discard the report. */
function decodeProgramStatusText(value: string): string | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padded = value.replace(/=+$/, '');
  const text = decodeBase64Utf8(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  // oxlint-disable-next-line no-control-regex -- intentional: rejects control characters
  if (text === undefined || /[\x00-\x1f\x7f]/.test(text)) return null;
  if (new TextEncoder().encode(text).length > MAX_PROGRAM_STATUS_MESSAGE_BYTES) return null;
  return text;
}

/** Observe complete OSC 7501 program statuses without consuming them from terminal output. */
export function extractTerminalProgramStatuses(data: string): TerminalProgramStatus[] {
  const statuses: TerminalProgramStatus[] = [];
  // oxlint-disable-next-line no-control-regex -- intentional: matches ESC/BEL
  for (const match of data.matchAll(/\x1b\]7501;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
    const fields = new Map(
      match[1].split(':').flatMap((field) => {
        const equals = field.indexOf('=');
        return equals < 0 ? [] : [[field.slice(0, equals), field.slice(equals + 1)] as const];
      })
    );
    const state = fields.get('state');
    if (!state || !PROGRAM_STATES.has(state)) continue;
    const app = fields.get('app');
    const kind = fields.get('kind');
    const id = fields.get('id');
    const encodedMsg = fields.get('msg');
    const msg = encodedMsg ? decodeProgramStatusText(encodedMsg) : undefined;
    if (msg === null) continue;
    statuses.push({
      state,
      ...(app && { app }),
      ...(kind && { kind }),
      ...(id && { id }),
      ...(msg && { msg }),
    });
  }
  return statuses;
}

/** How many times the output asks whether the terminal takes OSC 7501 program statuses. */
export function countTerminalProgramStatusQueries(data: string): number {
  // oxlint-disable-next-line no-control-regex -- intentional: matches ESC/BEL
  return data.match(/\x1b\]7501;\?[^\x07\x1b]*(?:\x07|\x1b\\)/g)?.length ?? 0;
}

/** The answer that tells a program asking with OSC 7501 that the terminal takes its statuses. */
export const TERMINAL_PROGRAM_STATUS_REPLY = '\x1b]7501;?\x1b\\';

export interface TerminalOscNotificationState {
  kittyContinuations: Map<string, KittyNotificationDraft>;
}

interface KittyNotificationDraft {
  titleParts: string[];
  bodyParts: string[];
  currentPart: KittyNotificationPart;
  partCount: number;
  textLength: number;
}

type KittyNotificationPart = 'title' | 'body';

type ParseNotificationOscResult =
  | { consumed: true; notification?: TerminalOscNotification }
  | { consumed: false };

const MAX_OSC_NOTIFICATION_TEXT_LENGTH = 1024;
const MAX_KITTY_CONTINUATIONS = 32;
const MAX_KITTY_CONTINUATION_PARTS = 16;
const MAX_KITTY_CONTINUATION_TEXT_LENGTH = MAX_OSC_NOTIFICATION_TEXT_LENGTH * 2;

export function createTerminalOscNotificationState(): TerminalOscNotificationState {
  return { kittyContinuations: new Map() };
}

function createNotification(title: string | undefined, message: string): TerminalOscNotification {
  return title ? { title, message } : { message };
}

function cleanOscNotificationText(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replaceAll('\x1b', '')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f);
    })
    .join('')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.slice(0, MAX_OSC_NOTIFICATION_TEXT_LENGTH);
}

function decodeBase64Utf8(value: string): string | undefined {
  try {
    if (typeof atob === 'function') {
      const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    }

    if (typeof Buffer !== 'undefined') {
      return Buffer.from(value, 'base64').toString('utf8');
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function parseKittyMetadata(metadata: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const entry of metadata.split(':')) {
    const equals = entry.indexOf('=');
    if (equals === -1) continue;

    const key = entry.slice(0, equals).trim().toLowerCase();
    if (key.length !== 1) continue;

    const value = entry.slice(equals + 1).trim();
    if (value) {
      result.set(key, value);
    }
  }
  return result;
}

function rememberKittyContinuation(
  state: TerminalOscNotificationState,
  id: string,
  draft: KittyNotificationDraft
): void {
  if (!state.kittyContinuations.has(id)) {
    while (state.kittyContinuations.size >= MAX_KITTY_CONTINUATIONS) {
      const oldestId = state.kittyContinuations.keys().next().value;
      if (!oldestId) break;
      state.kittyContinuations.delete(oldestId);
    }
  }

  state.kittyContinuations.set(id, draft);
}

function appendKittyContinuationPart(
  draft: KittyNotificationDraft,
  part: KittyNotificationPart,
  text: string
): boolean {
  if (
    draft.partCount >= MAX_KITTY_CONTINUATION_PARTS ||
    draft.textLength + text.length > MAX_KITTY_CONTINUATION_TEXT_LENGTH
  ) {
    return false;
  }

  if (part === 'title') {
    draft.titleParts.push(text);
  } else {
    draft.bodyParts.push(text);
  }
  draft.currentPart = part;
  draft.partCount += 1;
  draft.textLength += text.length;
  return true;
}

function parseKittyNotification(
  payload: string,
  state: TerminalOscNotificationState
): ParseNotificationOscResult {
  const separator = payload.indexOf(';');
  if (separator === -1) return { consumed: false };

  const metadata = parseKittyMetadata(payload.slice(0, separator));

  const part = metadata.get('p');
  if (part && part !== 'title' && part !== 'body') return { consumed: false };

  const encodedText = payload.slice(separator + 1);
  const rawText = metadata.get('e') === '1' ? decodeBase64Utf8(encodedText) : encodedText;
  const text = cleanOscNotificationText(rawText);
  if (!text) return { consumed: false };

  const id = metadata.get('i');
  const isComplete = metadata.get('d') !== '0';

  if (id && (!isComplete || state.kittyContinuations.has(id))) {
    const draft =
      state.kittyContinuations.get(id) ??
      ({
        titleParts: [],
        bodyParts: [],
        currentPart: 'title',
        partCount: 0,
        textLength: 0,
      } satisfies KittyNotificationDraft);
    const currentPart = part === 'title' || part === 'body' ? part : draft.currentPart;
    const appended = appendKittyContinuationPart(draft, currentPart, text);
    if (!appended) {
      state.kittyContinuations.delete(id);
      return { consumed: true };
    }

    if (!isComplete) {
      rememberKittyContinuation(state, id, draft);
      return { consumed: true };
    }

    state.kittyContinuations.delete(id);
    const title = cleanOscNotificationText(draft.titleParts.join(''));
    const body = cleanOscNotificationText(draft.bodyParts.join(''));
    const message = body ?? title;
    return message
      ? { consumed: true, notification: createNotification(title, message) }
      : { consumed: true };
  }

  if (part === 'title') {
    return { consumed: true, notification: { title: text, message: text } };
  }

  return { consumed: true, notification: { message: text } };
}

function parseNotificationOsc(
  command: string,
  payload: string,
  state: TerminalOscNotificationState
): ParseNotificationOscResult {
  if (command === '9') {
    const subcommand = payload.split(';', 1)[0]?.trim();
    if (subcommand && /^\d+$/.test(subcommand)) return { consumed: false };

    const message = cleanOscNotificationText(payload);
    return message ? { consumed: true, notification: { message } } : { consumed: false };
  }

  if (command === '777') {
    const parts = payload.split(';');
    if (parts[0]?.trim().toLowerCase() !== 'notify') return { consumed: false };

    const title = cleanOscNotificationText(parts[1]);
    const message = cleanOscNotificationText(parts.slice(2).join(';')) ?? title;
    return message
      ? { consumed: true, notification: createNotification(title, message) }
      : { consumed: false };
  }

  if (command === '99') {
    return parseKittyNotification(payload, state);
  }

  return { consumed: false };
}

/**
 * Find the first BEL or ST after `from`. A single forward scan stops at the nearest
 * terminator; searching for each kind separately would scan to the end of the
 * chunk whenever one kind is absent, which is quadratic for OSC-heavy output.
 */
function findOscTerminator(data: string, from: number): { end: number; terminatorLength: number } {
  for (let i = from; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code === 0x07) return { end: i, terminatorLength: 1 };
    if (code === 0x1b && data.charCodeAt(i + 1) === 0x5c) return { end: i, terminatorLength: 2 };
  }
  return { end: -1, terminatorLength: 1 };
}

/**
 * Extract desktop-notification OSC sequences from terminal output.
 *
 * Supported forms:
 *   OSC 9 ; message BEL/ST
 *   OSC 777 ; notify ; title ; message BEL/ST
 *   OSC 99 ; metadata ; payload ST (kitty-style title/body/plain-text subset)
 */
export function extractTerminalOscNotifications(data: string): {
  notifications: TerminalOscNotification[];
  cleaned: string;
};
export function extractTerminalOscNotifications(
  data: string,
  state: TerminalOscNotificationState
): {
  notifications: TerminalOscNotification[];
  cleaned: string;
};
export function extractTerminalOscNotifications(
  data: string,
  state: TerminalOscNotificationState = createTerminalOscNotificationState()
): {
  notifications: TerminalOscNotification[];
  cleaned: string;
} {
  const notifications: TerminalOscNotification[] = [];
  let cleaned = '';
  let index = 0;

  while (index < data.length) {
    const start = data.indexOf('\x1b]', index);
    if (start === -1) {
      cleaned += data.slice(index);
      break;
    }

    cleaned += data.slice(index, start);
    const { end, terminatorLength } = findOscTerminator(data, start + 2);

    if (end === -1) {
      cleaned += data.slice(start);
      break;
    }

    const body = data.slice(start + 2, end);
    const separator = body.indexOf(';');
    if (separator === -1) {
      cleaned += data.slice(start, end + terminatorLength);
      index = end + terminatorLength;
      continue;
    }

    const command = body.slice(0, separator);
    const payload = body.slice(separator + 1);
    const result = parseNotificationOsc(command, payload, state);
    if (!result.consumed) {
      cleaned += data.slice(start, end + terminatorLength);
    } else if (result.notification) {
      notifications.push(result.notification);
    }
    index = end + terminatorLength;
  }

  return { notifications, cleaned };
}
