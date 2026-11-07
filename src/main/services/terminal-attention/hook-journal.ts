import { createHash } from 'crypto';
import { posix as pathPosix } from 'path';

import { z } from 'zod';

import { notificationPayloadSchema, type NotificationPayload } from '../notification-payload';

/**
 * A hook in a Terminal's Hook Journal on an SSH host. The companion keeps each agent's prompt and
 * the newest hook since, for the installations that weren't connected to get a copy.
 */
export interface HookJournalEntry {
  /** The installation the hook went to, by its companion's key: its own mailbox has it. */
  owner: string;
  /** The installations it was copied to, whose mailboxes have it too. */
  copiedTo: string[];
  /** When the hook ran: by the host's clock as written, and by this computer's once read. */
  writtenAt: number;
  hook: NotificationPayload;
}

const entrySchema = z.object({
  owner: z.string().min(1).max(256),
  copiedTo: z.array(z.string().max(256)).max(256).default([]),
  writtenAtMs: z.number().int().nonnegative(),
  hook: z.record(z.string(), z.unknown()),
});

/** An entry as the companion wrote it, or none for one that isn't. */
export function parseHookJournalEntry(text: string): HookJournalEntry | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = entrySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { owner, copiedTo, writtenAtMs } = parsed.data;
  // Komla takes each in as a copy, which a relayed interrupt has to be.
  const hook = notificationPayloadSchema.safeParse({ ...parsed.data.hook, copy: true });
  if (!hook.success) return undefined;
  return { owner, copiedTo, writtenAt: writtenAtMs, hook: hook.data };
}

/**
 * The folder of a Terminal's Hook Journal, beside the companions' folder that holds `hookInbox`
 * at `<base>/helpers/companion/<key>/inbox`.
 */
export function hookJournalFolder(hookInbox: string, terminalId: string): string {
  const helpers = pathPosix.dirname(pathPosix.dirname(pathPosix.dirname(hookInbox)));
  const name = createHash('sha256').update(terminalId).digest('hex').slice(0, 32);
  return pathPosix.join(helpers, 'hook-journal', name);
}
