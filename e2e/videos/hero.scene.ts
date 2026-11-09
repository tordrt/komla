/**
 * The hero video's world: a working session across two projects. Claude Code
 * and Codex work on card retries side by side; a task starts from New
 * Workspace; one agent stops for permission and one finishes. All of it runs
 * on an SSH host.
 *
 * Card Retries, with its plan beside it, is also the command center video's.
 */
import { CODEX_TESTS, GO, HOLD, RETRIES, codexTestsAgent } from './agent-panes.scene';
import {
  ASK,
  DARK_MODE_ACCEPT_EDITS,
  RATE_LIMIT as STATUS_RATE_LIMIT,
  SEARCH as STATUS_SEARCH,
} from './agent-status.scene';
import { PREVIEW_PORT, PREVIEW_URL, PRICING_WEB, YEARLY_EVENTS } from './browser-preview.scene';
import { receiptsAgent, RECEIPTS_TITLE } from './new-workspace.scene';
import {
  CLAUDE_PRESET,
  DEFAULT_AGENT,
  type VideoProject,
  type VideoWorkspace,
  type VideoWorld,
} from './video-fixtures';
import { ACME_API, DEVBOX } from './worlds';

export { ASK, CODEX_TESTS, GO, HOLD, PREVIEW_PORT, RECEIPTS_TITLE };

/** The cue Rate Limiting's agent waits on before it wraps up, so its card turns Done on camera. */
export const FINISH = 'finish';

/** The plan Dark Mode's agent keeps beside it, in a markdown pane. */
export const DARK_MODE_PLAN = 'PLAN.md';

const DARK_MODE_PLAN_MD = `# Dark mode toggle

Let people switch the site to a dark theme from the header, and remember their choice.

## Steps

- [x] Read how the theme is set in \`src/lib/theme.ts\`
- [x] Add dark values for the color tokens
- [ ] Install a switch component (\`@radix-ui/react-switch\`)
- [ ] Add the toggle to the header
- [ ] Save the choice and apply it before first paint

## Notes

- Follow the system theme until someone picks one
- Keep contrast at 4.5:1 or better on both themes
`;

/** Asks to install a package; unlike the others, it doesn't skip permissions. */
export const DARK_MODE: VideoWorkspace = {
  ...DARK_MODE_ACCEPT_EDITS,
  minutesAgo: 6,
  changes: { 'PLAN.md': DARK_MODE_PLAN_MD },
};

/** The plan Claude Code keeps beside it, ticking steps off as it goes. */
export const PLAN = 'PLAN.md';

const PLAN_MD = `# Card retries

Retry a charge when the decline is temporary, so a network blip doesn't cost the sale.

## Steps

- [x] Read how charges reach the gateway
- [ ] Retry timeouts and \`try_again\`, up to 3 tries
- [ ] Time out gateway calls after 10s
- [ ] Tests for retries and hard declines (Codex)

## Never retry

- \`card_declined\`
- \`insufficient_funds\`
`;

const tick = (step: string) => ({
  edit: PLAN,
  find: `- [ ] ${step}`,
  replace: `- [x] ${step}`,
  delay: 900,
});

const retriesEvents = RETRIES.agent!.turns![0].events;

/** The hero's two projects, plainly a web app and the API behind it. */
const HERO_API: VideoProject = {
  ...ACME_API,
  name: 'api-server',
  icon: 'api-server.svg',
  files: {
    ...ACME_API.files,
    'package.json': JSON.stringify(
      { ...JSON.parse(ACME_API.files['package.json']), name: 'api-server' },
      null,
      2
    ),
  },
};
const HERO_WEB: VideoProject = {
  ...PRICING_WEB,
  name: 'web-app',
  icon: 'web-app.svg',
  files: {
    ...PRICING_WEB.files,
    'package.json': JSON.stringify(
      { ...JSON.parse(PRICING_WEB.files['package.json']), name: 'web-app' },
      null,
      2
    ),
  },
};
const apiPackage = JSON.parse(HERO_API.files['package.json']);

/** Claude Code, with Codex below it and the plan beside them both. */
export const CARD_RETRIES: VideoWorkspace = {
  ...RETRIES,
  projectId: ACME_API.id,
  // In the API project, so its package.json stays that project's, with the test runner the video uses.
  commits: RETRIES.commits!.map((commit) => ({
    ...commit,
    files: {
      ...commit.files,
      'package.json': JSON.stringify(
        {
          ...apiPackage,
          type: 'module',
          scripts: { ...apiPackage.scripts, test: 'node --test' },
        },
        null,
        2
      ),
    },
  })),
  minutesAgo: 1,
  // Not committed, so the file panel lists it among the changes.
  changes: { [PLAN]: PLAN_MD },
  agent: {
    ...RETRIES.agent,
    turns: [
      {
        ...RETRIES.agent!.turns![0],
        events: [
          // Up to the charge's retries, then the gateway's timeout, each ticked off as it lands.
          ...retriesEvents.slice(0, 3),
          tick('Retry timeouts and `try_again`, up to 3 tries'),
          ...retriesEvents.slice(3, 5),
          tick('Time out gateway calls after 10s'),
          { waitFor: HOLD },
        ],
      },
    ],
  },
};

const rateLimitTurn = STATUS_RATE_LIMIT.agent!.turns![0];

/** What the API had before: one limit per IP, which the agent replaces with one per API key. */
const OLD_LIMITER_TS = `import rateLimit from 'express-rate-limit';

// 100 requests a minute per IP.
export const limiter = rateLimit({ windowMs: 60_000, limit: 100 });
`;

const RATE_LIMIT_TS = `import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

/** 100 requests a minute per API key; anonymous requests share their IP's budget. */
export const limiter = rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: 'draft-7',
  keyGenerator: (req: Request) => req.header('x-api-key') ?? req.ip ?? 'anonymous',
  handler: (_req, res) => {
    res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  },
});
`;

/** Works in the background until it's cued to finish. */
export const RATE_LIMIT: VideoWorkspace = {
  ...STATUS_RATE_LIMIT,
  // Committed, so the agent's changes are edits to the limiter and not a new file.
  commits: [
    {
      message: 'Rate limit the API per IP',
      files: {
        'src/middleware/rate-limit.ts': OLD_LIMITER_TS,
        'package.json': JSON.stringify(
          {
            ...apiPackage,
            dependencies: { 'express-rate-limit': '^7.1.0' },
          },
          null,
          2
        ),
      },
    },
  ],
  agent: {
    ...STATUS_RATE_LIMIT.agent,
    turns: [
      {
        ...rateLimitTurn,
        doneVerb: 'Brewed',
        events: [
          // A limiter worth a look in the diff: keyed by API key, with a 429 that says when to retry.
          ...rateLimitTurn.events
            .filter((event) => !('waitFor' in event))
            .map((event) => ('write' in event ? { ...event, content: RATE_LIMIT_TS } : event)),
          {
            edit: 'package.json',
            find: '"express-rate-limit": "^7.1.0"',
            replace: '"express-rate-limit": "^7.4.0"',
            delay: 400,
          },
          { waitFor: FINISH },
          { say: 'Each API key gets 100 requests a minute; the next one gets a 429.', delay: 200 },
        ],
      },
    ],
  },
};

/** Finished before the video starts, while another workspace was in view. */
export const SEARCH: VideoWorkspace = { ...STATUS_SEARCH, minutesAgo: 30 };

/**
 * Yearly billing, its dev server running on the devbox. It finishes on GO, cued once another
 * workspace is in view, so its Done badge stays.
 */
export const PRICING: VideoWorkspace = {
  id: 'ws-pricing',
  projectId: HERO_WEB.id,
  title: 'Pricing Page',
  branch: 'pricing-page',
  minutesAgo: 14,
  agent: {
    title: '✳ Pricing page',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Let people pay yearly on the pricing page',
        verb: 'Pricing',
        doneVerb: 'Baked',
        events: [
          ...YEARLY_EVENTS,
          { waitFor: GO },
          {
            say: `Added a Monthly / Yearly switch. The dev server is running at\n${PREVIEW_URL}`,
            delay: 300,
          },
        ],
      },
    ],
  },
};

export const RECEIPTS_PROMPT = 'Send a receipt email after every successful charge';
/** Card Retries without its plan beside it: Claude Code, with Codex in a pane beside it. */
export const HERO_RETRIES: VideoWorkspace = {
  ...CARD_RETRIES,
  minutesAgo: 1,
  changes: {},
  agent: {
    ...CARD_RETRIES.agent,
    turns: [{ ...CARD_RETRIES.agent!.turns![0], events: retriesEvents }],
  },
};

export const HERO_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [HERO_API, HERO_WEB],
  workspaces: [HERO_RETRIES, RATE_LIMIT, DARK_MODE, PRICING],
  presets: [CLAUDE_PRESET],
  spawnedAgents: {
    [CODEX_TESTS]: codexTestsAgent,
    // New Workspace's task has no branch of its own, so it plays the default.
    [DEFAULT_AGENT]: receiptsAgent,
  },
  // Half-width panes keep about 64 columns.
  terminal: { font: { size: 13 } },
};
