/**
 * The two-agents video's world: one task launched with Claude Code and Codex
 * at once, each in a workspace of its own, while Claude Code works on card
 * retries.
 */
import { GO, HOLD, RETRIES } from './agent-panes.scene';
import { RATE_LIMIT, SEARCH } from './agent-status.scene';
import {
  CLAUDE_PRESET,
  CODEX_PRESET,
  DEFAULT_AGENT,
  type AgentScene,
  type VideoWorld,
} from './video-fixtures';
import { ACME_API, DEVBOX } from './worlds';

export { GO, HOLD, RATE_LIMIT, RETRIES, SEARCH };

export const PROMPT = 'Add idempotency keys to charges so a retried request never charges twice';
export const CLAUDE_TITLE = 'Idempotent Charges';
export const CODEX_TITLE = 'Idempotency Keys';
/** The scene Codex plays wherever it's launched from New Workspace. */
const CODEX_NEW = 'codex-new';

const CLAUDE_TS = `import { db } from '../db';

export async function once(key, run) {
  const { rows } = await db.query(
    'insert into idempotency (key) values ($1) on conflict do nothing returning key',
    [key]
  );
  if (rows.length === 0) return db.result(key);
  return db.saveResult(key, await run());
}
`;

const CODEX_TS = `import type { Request, Response, NextFunction } from 'express';
import { db } from '../db';

export async function idempotent(req: Request, res: Response, next: NextFunction) {
  const key = req.header('Idempotency-Key');
  if (!key) return next();
  const seen = await db.query('select body from responses where key = $1', [key]);
  if (seen.rows[0]) return res.json(seen.rows[0].body);
  res.locals.idempotencyKey = key;
  next();
}
`;

const titled = (title: string): AgentScene['turns'] => [
  {
    events: [
      {
        mcp: 'set_workspace_title',
        args: { title },
        result: [`Workspace title set to "${title}"`],
        delay: 200,
      },
    ],
  },
];

/** Claude Code keys the charge itself. */
const claudeAgent: AgentScene = {
  title: '✳ Idempotent charges',
  turns: [
    {
      events: [
        ...titled(CLAUDE_TITLE)![0].events,
        { tool: 'Read', arg: 'src/routes/charges.ts', result: ['Read 48 lines'], delay: 500 },
        { write: 'src/lib/once.js', content: CLAUDE_TS, delay: 800 },
        { waitFor: HOLD },
      ],
    },
  ],
};

/** Codex keys the request, with middleware. */
const codexAgent: AgentScene = {
  look: 'codex',
  turns: [
    {
      events: [
        ...titled(CODEX_TITLE)![0].events,
        { tool: 'Read', arg: 'src/routes/charges.ts', delay: 400 },
        { write: 'src/middleware/idempotent.ts', content: CODEX_TS, delay: 900 },
        { waitFor: HOLD },
      ],
    },
  ],
};

export const TWO_AGENTS_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [ACME_API],
  workspaces: [
    { ...RETRIES, projectId: ACME_API.id, minutesAgo: 1 },
    { ...RATE_LIMIT, minutesAgo: 9 },
    { ...SEARCH, minutesAgo: 30 },
  ],
  presets: [CLAUDE_PRESET, { ...CODEX_PRESET, scene: CODEX_NEW }],
  spawnedAgents: { [DEFAULT_AGENT]: claudeAgent, [CODEX_NEW]: codexAgent },
  terminal: { font: { size: 13 } },
};
