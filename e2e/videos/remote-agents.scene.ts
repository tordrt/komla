/**
 * The remote-agents video's world: an agent on the SSH host upgrades the Stripe
 * SDK and works through the test suite while Komla is quit, then wraps up once
 * Komla opens again.
 */
import type { VideoWorkspace } from './video-fixtures';
import { ACME_WEB } from './worlds';

/** Cues the agent holds at: Komla quits at AWAY and is open again by BACK. */
export const AWAY = 'away';
export const BACK = 'back';

export const UPGRADE_PROMPT = 'Upgrade the Stripe SDK and keep going until the tests pass';
export const AWAY_CAPTION = 'Komla quit. The agent kept working on devbox.';

export const UPGRADE: VideoWorkspace = {
  id: 'ws-upgrade',
  projectId: ACME_WEB.id,
  title: 'Stripe Upgrade',
  branch: 'upgrade-stripe-sdk',
  minutesAgo: 0,
  agent: {
    title: '✳ Stripe SDK upgrade',
    turns: [
      {
        verb: 'Upgrading',
        doneVerb: 'Baked',
        events: [
          { tool: 'Read', arg: 'package.json', result: ['Read 8 lines'], delay: 500 },
          {
            edit: 'package.json',
            find: '"private": true,',
            replace: '"private": true,\n  "dependencies": { "stripe": "^18.0.0" },',
            delay: 600,
          },
          {
            tool: 'Bash',
            arg: 'npm test',
            result: ['Running 412 tests in 38 files…'],
            verb: 'Testing',
            delay: 600,
          },
          // Komla quits here; the rest plays on the host with nobody watching.
          { waitFor: AWAY },
          { think: 1200 },
          {
            tool: 'Bash',
            arg: 'npm test',
            result: [
              '409 passed, 3 failed (38 files)',
              'FAIL checkout.test.ts › opens an embedded checkout',
            ],
            delay: 400,
          },
          {
            edit: 'src/lib/checkout.ts',
            find: '  return plan;',
            replace:
              "  return stripe.checkout.sessions.create({\n    mode: 'subscription',\n    ui_mode: 'embedded',\n    line_items: [{ price: plan, quantity: 1 }],\n  });",
            verb: 'Fixing',
            delay: 900,
          },
          {
            tool: 'Bash',
            arg: 'npm test',
            result: ['412 passed (38 files)'],
            verb: 'Testing',
            delay: 1200,
          },
          { waitFor: BACK },
          {
            say: 'Upgraded to Stripe 18 and fixed the three checkout tests it broke. All 412 tests pass.',
            delay: 300,
          },
        ],
      },
    ],
  },
};
