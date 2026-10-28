/**
 * The workspace-switching video's world: four agents at work in workspaces
 * laid out their own way, with a live page beside its agent, an open diff,
 * three panes, and tabs. The background workspaces are stopped, so ⌘↓ cycles the four.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { CODEX_TESTS, GO, HOLD, RETRIES, codexTestsAgent } from './agent-panes.scene';
import { DARK_MODE_PROMPT, DARK_MODE_WORKSPACE } from './change-review.scene';
import type { AgentEvent, AgentScene, VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_WEB, BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

export { CODEX_TESTS, GO, HOLD, RETRIES };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) =>
  fs.readFileSync(path.join(__dirname, 'assets', relativePath), 'utf8');

export const PRICING_PORT = 4317;
const PRICING_URL = `http://localhost:${PRICING_PORT}`;
/** The cue the pricing agent waits on before opening its page, once a browser is beside it. */
export const PREVIEW = 'preview';

/** Restyles the pricing page in the browser beside it once cued. */
export const PRICING: VideoWorkspace = {
  id: 'ws-pricing',
  projectId: ACME_WEB.id,
  title: 'Pricing Page',
  branch: 'pricing-page',
  minutesAgo: 1,
  agent: {
    title: '✳ Pricing page',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Restyle the pricing page like a print magazine',
        verb: 'Sketching',
        doneVerb: 'Crafted',
        events: [
          { tool: 'Read', arg: 'site/index.html', result: ['Read 68 lines'], delay: 400 },
          { serve: 'site', port: PRICING_PORT, delay: 400 },
          { waitFor: PREVIEW },
          {
            mcp: 'open_browser_preview',
            args: { url: PRICING_URL },
            result: [`Browser preview opened at ${PRICING_URL}`],
            delay: 500,
          },
          { waitFor: GO, verb: 'Restyling' },
          ...read('designs/editorial.css')
            .split('/* @stage */')
            .map((content, i): AgentEvent => ({
              append: 'site/styles.css',
              content,
              delay: i === 0 ? 250 : 1100,
            })),
          {
            say: 'Restyled the pricing page as a print magazine: cream paper, Didot headlines, oxblood accents.',
            delay: 700,
          },
        ],
      },
    ],
  },
};

const darkModeTurn = DARK_MODE_WORKSPACE.agent!.turns![0];

/** The change-review agent, already under way; its last edit lands in the open diff on camera. */
export const DARK_MODE: VideoWorkspace = {
  ...DARK_MODE_WORKSPACE,
  minutesAgo: 4,
  agent: {
    ...DARK_MODE_WORKSPACE.agent,
    turns: [
      {
        ...darkModeTurn,
        auto: true,
        afterMs: 200,
        prompt: DARK_MODE_PROMPT,
        events: [
          ...darkModeTurn.events.slice(0, 4),
          { waitFor: GO },
          ...darkModeTurn.events.slice(4),
        ],
      },
    ],
  },
};

const RATE_LIMIT_TS = `import rateLimit from 'express-rate-limit';

// 100 requests a minute for each API key.
export const limiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  keyGenerator: (req) => req.get('x-api-key') ?? req.ip,
});
`;

/** Claude Code writes the limiter in one tab while Codex reviews it in another. */
export const RATE_LIMIT: VideoWorkspace = {
  id: 'ws-rate-limit',
  projectId: ACME_WEB.id,
  title: 'Rate Limiting',
  branch: 'rate-limiting',
  minutesAgo: 9,
  agent: {
    title: '✳ Rate limiting',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Rate limit the public API per key',
        verb: 'Throttling',
        events: [
          { write: 'src/middleware/rate-limit.ts', content: RATE_LIMIT_TS, delay: 500 },
          { waitFor: HOLD },
        ],
      },
    ],
  },
};

export const RATE_LIMIT_REVIEW = `${RATE_LIMIT.branch}:codex`;

const rateLimitReview: AgentScene = {
  look: 'codex',
  title: 'Codex',
  turns: [
    {
      auto: true,
      afterMs: 200,
      prompt: 'Review the rate limiter for ways around it',
      verb: 'Reviewing',
      events: [
        { tool: 'Read', arg: 'src/middleware/rate-limit.ts', delay: 400 },
        { waitFor: GO },
        {
          say: 'The key is trusted as sent, so a client can make up a new x-api-key for a fresh limit on every request. Look the key up first, and fall back to the IP when it is unknown.',
          delay: 500,
        },
        { waitFor: HOLD },
      ],
    },
  ],
};

export const SWITCH_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [
    {
      ...ACME_WEB,
      files: {
        ...ACME_WEB.files,
        'site/index.html': read('pricing-site/index.html'),
        'site/styles.css': read('pricing-site/styles.css'),
      },
    },
  ],
  workspaces: [
    PRICING,
    DARK_MODE,
    RETRIES,
    RATE_LIMIT,
    ...BACKGROUND_WORKSPACES.map((workspace) => ({ ...workspace, stopped: true })),
  ],
  spawnedAgents: { [CODEX_TESTS]: codexTestsAgent, [RATE_LIMIT_REVIEW]: rateLimitReview },
  // Half-width panes keep about 64 columns.
  terminal: { font: { size: 13 } },
};
