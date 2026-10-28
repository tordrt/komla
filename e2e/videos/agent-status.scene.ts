/**
 * The agent-status video's world: six agents across two projects, each
 * holding at a cue so the spec decides when a card turns to Input or Done.
 */
import type { AgentScene, VideoProject, VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_WEB, DEVBOX } from './worlds';

/** Cues the agents wait on; `HOLD` is never sent, so those agents keep working. */
export const GO = 'go';
export const ASK = 'ask';
export const FINISH = 'finish';
export const HOLD = 'hold';

const ACME_API: VideoProject = {
  id: 'proj-acme-api',
  name: 'acme-api',
  color: 'hsl(340, 75%, 62%)',
  icon: 'acme-api.svg',
  files: {
    'README.md': '# Acme API\n\nBilling, search and accounts for Acme.\n',
    'package.json': JSON.stringify(
      { name: 'acme-api', private: true, scripts: { dev: 'tsx watch src/server.ts' } },
      null,
      2
    ),
    'src/routes/webhooks.ts':
      "import { Router } from 'express';\n\nexport const webhooks = Router();\n",
    'src/routes/search.ts':
      "import { Router } from 'express';\n\nexport const search = Router();\n",
    'src/db.ts': "import { Pool } from 'pg';\n\nexport const db = new Pool();\n",
  },
};

const PASSWORD_TS = `import bcrypt from 'bcrypt';

const ROUNDS = 12;

export function hash(pw: string) {
  return bcrypt.hash(pw, ROUNDS);
}

export function verify(pw: string, hash: string) {
  return bcrypt.compare(pw, hash);
}
`;

/** Workspace in view when the video starts; its agent works on camera. */
export const AUTH: VideoWorkspace = {
  id: 'ws-auth',
  projectId: ACME_WEB.id,
  title: 'Auth Flow',
  branch: 'add-auth',
  minutesAgo: 3,
  changes: {
    // Short lines, so the agent's diffs fit the narrow terminal.
    'src/lib/session.ts':
      "import { findUser } from './users';\n\nexport async function signIn(email, pw) {\n  const user = await findUser(email);\n  return user?.password === pw;\n}\n",
  },
  agent: {
    title: '✳ Password sign-in',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Hash passwords with bcrypt and check them on sign-in',
        verb: 'Hashing',
        doneVerb: 'Baked',
        events: [
          { tool: 'Read', arg: 'src/lib/session.ts', result: ['Read 6 lines'], delay: 400 },
          { waitFor: GO },
          { write: 'src/lib/password.ts', content: PASSWORD_TS, delay: 500 },
          {
            edit: 'src/lib/session.ts',
            find: "import { findUser } from './users';",
            replace: "import { findUser } from './users';\nimport { verify } from './password';",
            delay: 1100,
          },
          {
            edit: 'src/lib/session.ts',
            find: '  return user?.password === pw;',
            replace: '  if (!user) return false;\n  return verify(pw, user.passwordHash);',
            delay: 1000,
          },
          {
            tool: 'Bash',
            arg: 'npm test -- session',
            result: ['Tests  9 passed (9)'],
            verb: 'Testing',
            delay: 1100,
          },
          { waitFor: FINISH },
          {
            say: 'Passwords are now hashed with bcrypt (12 rounds) and sign-in checks the hash. Tests pass.',
            delay: 200,
          },
        ],
      },
    ],
  },
};

/** Stops for permission to install a package; the spec answers it from the top pane. */
export const DARK_MODE: VideoWorkspace = {
  id: 'ws-dark',
  projectId: ACME_WEB.id,
  title: 'Dark Mode',
  branch: 'dark-mode-toggle',
  minutesAgo: 8,
  agent: {
    title: '✳ Dark mode toggle',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Add a dark mode toggle to the header',
        verb: 'Spelunking',
        events: [
          { tool: 'Read', arg: 'src/lib/theme.ts', result: ['Read 5 lines'], delay: 400 },
          {
            edit: 'src/styles/tokens.css',
            find: 'body {',
            replace:
              "[data-theme='dark'] {\n  --bg: #0b0d12;\n  --surface: #151922;\n  --text: #e5e7eb;\n}\n\nbody {",
            delay: 500,
          },
          { waitFor: ASK },
          {
            permission: {
              title: 'Bash command',
              detail: 'npm install @radix-ui/react-switch',
              message: 'Claude needs your permission to use Bash',
            },
            delay: 100,
          },
          {
            tool: 'Bash',
            arg: 'npm install @radix-ui/react-switch',
            result: ['added 3 packages in 2s'],
            verb: 'Installing',
            delay: 500,
          },
          {
            edit: 'src/components/Header.tsx',
            find: '      </nav>\n',
            replace: '      </nav>\n      <ThemeToggle />\n',
            verb: 'Crafting',
            delay: 900,
          },
          { waitFor: HOLD },
        ],
      },
    ],
  },
};

/** A second agent in Dark Mode, in a pane split below the first. */
export const DARK_MODE_TESTS = `${DARK_MODE.branch}:tests`;

const darkModeTestsAgent: AgentScene = {
  title: '✳ Theme toggle tests',
  turns: [
    {
      auto: true,
      afterMs: 200,
      prompt: 'Write tests for the theme toggle',
      verb: 'Testing',
      events: [
        {
          write: 'src/components/ThemeToggle.test.tsx',
          content:
            "import { render } from '@testing-library/react';\nimport { ThemeToggle } from './ThemeToggle';\n\ntest('remembers the theme', () => {\n  render(<ThemeToggle label=\"Theme\" />);\n});\n",
          delay: 500,
        },
        { waitFor: GO },
        {
          tool: 'Bash',
          arg: 'npm test -- ThemeToggle',
          result: ['Tests  3 passed (3)'],
          delay: 900,
        },
        {
          edit: 'src/components/ThemeToggle.test.tsx',
          find: '});\n',
          replace: "});\n\ntest('follows the system', () => {\n  matchMedia.dark = true;\n});\n",
          verb: 'Covering',
          delay: 1400,
        },
        { waitFor: HOLD },
      ],
    },
  ],
};

export const NAV: VideoWorkspace = {
  id: 'ws-nav',
  projectId: ACME_WEB.id,
  title: 'Fix Nav Overflow',
  branch: 'fix-nav-overflow',
  minutesAgo: 15,
  agent: {
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'The header nav overflows on small screens',
        verb: 'Measuring',
        events: [
          { tool: 'Read', arg: 'src/components/Header.tsx', result: ['Read 14 lines'], delay: 400 },
          {
            edit: 'src/styles/tokens.css',
            find: '  --radius: 10px;',
            replace: '  --radius: 10px;\n  --nav-gap: clamp(8px, 2vw, 24px);',
            delay: 500,
          },
          { waitFor: HOLD },
        ],
      },
    ],
  },
};

export const STRIPE: VideoWorkspace = {
  id: 'ws-stripe',
  projectId: ACME_API.id,
  title: 'Stripe Billing',
  branch: 'stripe-billing',
  minutesAgo: 12,
  commits: [
    {
      message: 'Verify Stripe signatures',
      files: {
        'src/routes/webhooks.ts':
          "import { Router } from 'express';\nimport Stripe from 'stripe';\n\nexport const webhooks = Router();\nconst stripe = new Stripe(process.env.STRIPE_KEY!);\n",
      },
    },
  ],
  agent: {
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Handle checkout.session.completed webhooks',
        verb: 'Wiring',
        events: [
          {
            append: 'src/routes/webhooks.ts',
            content:
              "webhooks.post('/stripe', async (req, res) => {\n  const event = stripe.webhooks.constructEvent(req.body, req.header('stripe-signature')!, process.env.STRIPE_SECRET!);\n  if (event.type === 'checkout.session.completed') await activate(event.data.object);\n  res.sendStatus(200);\n});",
            delay: 500,
          },
          { waitFor: FINISH },
          { say: 'Completed checkouts now activate the subscription.', delay: 100 },
        ],
      },
    ],
  },
};

export const RATE_LIMIT: VideoWorkspace = {
  id: 'ws-rate-limit',
  projectId: ACME_API.id,
  title: 'Rate Limiting',
  branch: 'rate-limiting',
  minutesAgo: 20,
  agent: {
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Rate limit the public API per key',
        verb: 'Throttling',
        events: [
          {
            write: 'src/middleware/rate-limit.ts',
            content:
              "import rateLimit from 'express-rate-limit';\n\nexport const limiter = rateLimit({ windowMs: 60_000, limit: 100 });\n",
            delay: 500,
          },
          { waitFor: HOLD },
        ],
      },
    ],
  },
};

/** Already done when the video starts. */
export const SEARCH: VideoWorkspace = {
  id: 'ws-search',
  projectId: ACME_API.id,
  title: 'Search Endpoint',
  branch: 'search-endpoint',
  minutesAgo: 30,
  agent: {
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Add a /search endpoint for posts',
        events: [
          // Cued once another workspace is in view, so its Done badge stays.
          { waitFor: GO },
          {
            append: 'src/routes/search.ts',
            content:
              "search.get('/', async (req, res) => {\n  const { rows } = await db.query('select * from posts where title ilike $1 limit 20', [`%${req.query.q}%`]);\n  res.json(rows);\n});",
            delay: 400,
          },
          { say: 'Added GET /search, capped at 20 results.', delay: 300 },
        ],
      },
    ],
  },
};

/** In sidebar order; the agents start in this order off camera. */
export const STATUS_WORKSPACES = [AUTH, DARK_MODE, NAV, STRIPE, RATE_LIMIT, SEARCH];

export const STATUS_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [ACME_WEB, ACME_API],
  workspaces: STATUS_WORKSPACES,
  spawnedAgents: { [DARK_MODE_TESTS]: darkModeTestsAgent },
  // A narrow window, so the terminal trades a little size for columns.
  terminal: { font: { size: 12 } },
};
