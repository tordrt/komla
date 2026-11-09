/**
 * The new-workspace video's world: Claude Code adds retries to card charges
 * while a dictated task starts another agent in a fresh workspace of its own.
 */
import { GO, HOLD, RETRIES as PANES_RETRIES } from './agent-panes.scene';
import {
  CLAUDE_PRESET,
  DEFAULT_AGENT,
  type AgentScene,
  type VideoWorkspace,
  type VideoWorld,
} from './video-fixtures';
import { ACME_WEB, BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

export { GO };
/** Sent as the task launches, so Claude Code's next edit lands once the dialog has closed. */
export const LAUNCHED = 'launched';
/** The cue the checkout agent waits on before it wraps up, so its card turns Done on camera. */
export const FINISH = 'finish';

const retriesTurn = PANES_RETRIES.agent!.turns![0];

/** Claude Code's retries land before the dialog opens, and its gateway timeout after it closes. */
export const RETRIES: VideoWorkspace = {
  ...PANES_RETRIES,
  agent: {
    ...PANES_RETRIES.agent,
    turns: [
      {
        ...retriesTurn,
        events: [
          ...retriesTurn.events.slice(0, 3),
          { waitFor: LAUNCHED },
          ...retriesTurn.events.slice(3),
        ],
      },
    ],
  },
};

export const RECEIPTS_PROMPT = 'Send a receipt email after every successful charge.';
export const RECEIPTS_TITLE = 'Receipt Emails';
/** The workspace the dialog creates has no scene of its own, so it plays the default one. */
export const RECEIPTS_AGENT = DEFAULT_AGENT;

const RECEIPTS_TS = `import { sendEmail } from './email';

export async function sendReceipt(charge: { id: string; email: string; cents: number }) {
  await sendEmail({
    to: charge.email,
    subject: \`Your Acme receipt (\${charge.id})\`,
    template: 'receipt',
    data: charge,
  });
}
`;

/** Names its workspace and writes the receipts, still at work when the video ends. */
export const receiptsAgent: AgentScene = {
  title: '✳ Receipt emails',
  turns: [
    {
      events: [
        {
          mcp: 'set_workspace_title',
          args: { title: RECEIPTS_TITLE },
          result: [`Workspace title set to "${RECEIPTS_TITLE}"`],
          delay: 200,
        },
        { tool: 'Read', arg: 'src/lib/checkout.ts', delay: 500 },
        { write: 'src/lib/receipts.ts', content: RECEIPTS_TS, delay: 800 },
        { waitFor: HOLD },
      ],
    },
  ],
};

const [CHECKOUT_BASE, ...OTHER_WORKSPACES] = BACKGROUND_WORKSPACES;

/** Works in the background and finishes once the new task is under way. */
export const CHECKOUT: VideoWorkspace = {
  ...CHECKOUT_BASE,
  agent: {
    title: '✳ Stripe checkout',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Move checkout to Stripe Checkout sessions',
        verb: 'Wiring',
        events: [
          { tool: 'Read', arg: 'src/lib/checkout.ts', result: ['Read 5 lines'], delay: 400 },
          { waitFor: FINISH },
          {
            say: 'Checkout now creates a Stripe Checkout session for the chosen plan.',
            delay: 200,
          },
        ],
      },
    ],
  },
};

/**
 * Dictation needs macOS `say` for the microphone's speech; a Linux dry run types the task
 * instead.
 */
export const DICTATES = process.platform === 'darwin';

export const NEW_WORKSPACE_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [ACME_WEB],
  workspaces: [RETRIES, CHECKOUT, ...OTHER_WORKSPACES],
  // Claude Code, already set to skip permissions as it runs on the devbox.
  presets: [CLAUDE_PRESET],
  spawnedAgents: { [RECEIPTS_AGENT]: receiptsAgent },
  ...(DICTATES
    ? { dictation: { speech: RECEIPTS_PROMPT, model: 'parakeet-tdt-0.6b-v2-int8' } }
    : {}),
  terminal: { font: { size: 13 } },
};
