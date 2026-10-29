/**
 * The hero video's world: a working session across two projects. Agents work
 * in workspaces laid out their own way: Claude Code and Codex with their plan
 * open beside them, an agent with its diff beside it, a shipped one with its
 * page in a browser beside it and its checks running, and one in the
 * background. One stops for permission, one finishes, and the checks pass.
 */
import { CODEX_TESTS, GO, HOLD, RETRIES, codexTestsAgent } from './agent-panes.scene';
import { ASK, DARK_MODE_ACCEPT_EDITS, RATE_LIMIT as STATUS_RATE_LIMIT } from './agent-status.scene';
import { PREVIEW_PORT, PREVIEW_URL, PRICING_WEB, YEARLY_EVENTS } from './browser-preview.scene';
import { BILLING, PULL_REQUEST_PASSED } from './pull-request.scene';
import type { VideoPullRequest, VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_API, DEVBOX } from './worlds';

export { ASK, CODEX_TESTS, GO, HOLD, PREVIEW_PORT };
export { PROMPT as SHIP_PROMPT, PULL_REQUEST_RUNNING } from './pull-request.scene';

/** The cue the billing agent waits on before opening its page, once a browser is beside it. */
export const PREVIEW = 'preview';
/** The cue Rate Limiting's agent waits on before it wraps up, so its card turns Done on camera. */
export const FINISH = 'finish';

/** Asks to install a package; unlike the others, it doesn't skip permissions. */
export const DARK_MODE: VideoWorkspace = { ...DARK_MODE_ACCEPT_EDITS, minutesAgo: 6 };

/**
 * Its checks pass, and a reviewer has approved it, so the hooks guide's CI script just drops its
 * CI running tag: no review tag, which Komla doesn't apply unless the user asks it to.
 */
export const PULL_REQUEST_APPROVED: VideoPullRequest = {
  ...PULL_REQUEST_PASSED,
  reviewDecision: 'APPROVED',
};

/** Adds yearly billing with its page open beside it, then ships it, all before the video starts. */
export const YEARLY_BILLING: VideoWorkspace = {
  ...BILLING,
  minutesAgo: 3,
  agent: {
    title: '✳ Yearly billing',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Let people pay yearly on the pricing page',
        verb: 'Pricing',
        doneVerb: 'Baked',
        events: [
          ...YEARLY_EVENTS,
          { waitFor: PREVIEW },
          { bash: `komla preview --open ${PREVIEW_URL}`, delay: 500 },
          {
            say: 'Added a Monthly / Yearly switch. Yearly plans are 20% off, and the page is open beside me.',
            delay: 300,
          },
        ],
      },
      BILLING.agent!.turns![0],
    ],
  },
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
const acmeApiPackage = JSON.parse(ACME_API.files['package.json']);

/** Claude Code, with Codex below it and the plan beside them both. */
export const CARD_RETRIES: VideoWorkspace = {
  ...RETRIES,
  projectId: ACME_API.id,
  // In acme-api, so its package.json stays acme-api's, with the test runner the video uses.
  commits: RETRIES.commits!.map((commit) => ({
    ...commit,
    files: {
      ...commit.files,
      'package.json': JSON.stringify(
        {
          ...acmeApiPackage,
          type: 'module',
          scripts: { ...acmeApiPackage.scripts, test: 'node --test' },
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

/** Works in the background until it's cued to finish. */
export const RATE_LIMIT: VideoWorkspace = {
  ...STATUS_RATE_LIMIT,
  agent: {
    ...STATUS_RATE_LIMIT.agent,
    turns: [
      {
        ...rateLimitTurn,
        doneVerb: 'Brewed',
        events: [
          ...rateLimitTurn.events.filter((event) => !('waitFor' in event)),
          { waitFor: FINISH },
          { say: 'Each API key gets 100 requests a minute; the next one gets a 429.', delay: 200 },
        ],
      },
    ],
  },
};

export const HERO_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [PRICING_WEB, ACME_API],
  workspaces: [CARD_RETRIES, YEARLY_BILLING, DARK_MODE, RATE_LIMIT],
  spawnedAgents: { [CODEX_TESTS]: codexTestsAgent },
  // Pages open beside the terminal instead of over it.
  config: { defaultInlinePreviewLayout: 'side-by-side' },
  // Half-width panes keep about 64 columns.
  terminal: { font: { size: 13 } },
};
