/**
 * The new-workspace video's world: Claude Code adds retries to card charges
 * while a dictated task starts a second Claude Code in a fresh workspace of
 * its own.
 */
import { GO, RETRIES as PANES_RETRIES } from './agent-panes.scene';
import {
  DEFAULT_AGENT,
  type AgentScene,
  type VideoWorkspace,
  type VideoWorld,
} from './video-fixtures';
import { ACME_WEB, BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

export { GO };
/** Sent as the task launches, so Claude Code's next edit lands once the dialog has closed. */
export const LAUNCHED = 'launched';

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

/** Names its workspace and writes the receipts, then finishes once cued. */
const receiptsAgent: AgentScene = {
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
        { waitFor: GO },
        { say: 'Customers now get a receipt email after each successful charge.', delay: 200 },
      ],
    },
  ],
};

export const NEW_WORKSPACE_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [ACME_WEB],
  workspaces: [RETRIES, ...BACKGROUND_WORKSPACES],
  // Just Claude Code, already set to skip permissions: it runs on the devbox.
  spawnedAgents: { [RECEIPTS_AGENT]: receiptsAgent },
  dictation: { speech: RECEIPTS_PROMPT, model: 'parakeet-tdt-0.6b-v2-int8' },
  terminal: { font: { size: 13 } },
};
