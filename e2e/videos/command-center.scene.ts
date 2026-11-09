/**
 * The command center video's world: eight workspaces across two projects, each
 * with a description of what it's for, which the command center searches. One
 * agent waits on permission and one has finished, so both wait under Needs
 * attention, while Claude Code and Codex work on card retries side by side.
 *
 * Local, not on the SSH host: descriptions can't be seeded there yet.
 */
import {
  ASK,
  DARK_MODE_ACCEPT_EDITS as DARK_MODE,
  HOLD,
  RATE_LIMIT,
  SEARCH,
} from './agent-status.scene';
import { CODEX_TESTS, codexTestsAgent } from './agent-panes.scene';
import { CARD_RETRIES } from './hero.scene';
import type { VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_API, ACME_WEB, BACKGROUND_WORKSPACES } from './worlds';

export { ASK, CARD_RETRIES, CODEX_TESTS, DARK_MODE, HOLD, RATE_LIMIT, SEARCH };
export { GO } from './agent-status.scene';

const [CHECKOUT, , NAV] = BACKGROUND_WORKSPACES;

/** What we search for: it's only in Stripe Webhooks' description. */
export const QUERY = 'refund';
/** What finds Card Retries again, by its title. */
export const BACK_QUERY = 'retr';

/** Found by its description, and done with its work, so it's quiet when we land on it. */
export const WEBHOOKS: VideoWorkspace = {
  id: 'ws-webhooks',
  projectId: ACME_API.id,
  title: 'Stripe Webhooks',
  branch: 'stripe-webhooks',
  minutesAgo: 55,
  description: 'Handle checkout.session.completed and charge.refunded events',
  agent: {
    title: '✳ Stripe webhooks',
    history: [
      { prompt: 'Handle Stripe checkout and refund webhooks, verifying their signatures' },
      { tool: 'Write', arg: 'src/routes/webhooks.ts', result: ['Wrote 31 lines'] },
      { tool: 'Bash', arg: 'npm test -- webhooks', result: ['Tests  6 passed (6)'] },
      {
        say: 'Completed checkouts activate the subscription, and refunds cancel it at the period end.',
      },
      { done: 'Baked for 2m 4s' },
    ],
  },
};

export const COMMAND_CENTER_WORLD: VideoWorld = {
  projects: [ACME_WEB, ACME_API],
  workspaces: [
    { ...RATE_LIMIT, minutesAgo: 2, description: '100 requests a minute per API key, in Redis' },
    { ...DARK_MODE, minutesAgo: 6, description: 'Header toggle and dark theme tokens' },
    { ...SEARCH, minutesAgo: 9, description: 'GET /search over post titles, 20 a page' },
    {
      id: 'ws-yearly',
      projectId: ACME_WEB.id,
      title: 'Yearly Billing',
      branch: 'yearly-billing',
      minutesAgo: 14,
      description: 'Monthly / Yearly switch on the pricing page, yearly 20% off',
    },
    { ...CARD_RETRIES, minutesAgo: 21, description: 'Retry gateway timeouts, never hard declines' },
    { ...CHECKOUT, minutesAgo: 33, description: 'Hosted Stripe Checkout sessions for each plan' },
    WEBHOOKS,
    { ...NAV, minutesAgo: 95, description: 'Header links wrap below 360px wide' },
  ],
  spawnedAgents: { [CODEX_TESTS]: codexTestsAgent },
  // A narrow window, so the terminal trades a little size for columns.
  terminal: { font: { size: 13 } },
};
