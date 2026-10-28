/**
 * The agent-panes video's world: Claude Code adds retries to card charges
 * while Codex, launched in a pane beside it, writes their tests, which run
 * for real in a terminal below.
 */
import {
  CLAUDE_PRESET,
  CODEX_PRESET,
  type AgentScene,
  type VideoWorkspace,
  type VideoWorld,
} from './video-fixtures';
import { ACME_WEB, BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

/** Cues the agents wait on; `HOLD` is never sent, so those agents keep working. */
export const GO = 'go';
export const HOLD = 'hold';

// Lines stay short so the diffs fit a half-width pane.
const GATEWAY_JS = `const API = 'https://api.acme.dev/v1/charges';

export const gateway = {
  async send(card, cents) {
    const res = await fetch(API, {
      method: 'POST',
      body: JSON.stringify({ card, cents }),
    });
    return res.json();
  },
};
`;

const CHARGE_JS = `import { gateway } from './gateway.js';

export async function charge(card, cents) {
  return gateway.send(card, cents);
}
`;

// t.mock restores the gateway after each test.
const CHARGE_TEST_JS = `import assert from 'node:assert/strict';
import { test } from 'node:test';
import { charge } from './charge.js';
import { gateway } from './gateway.js';

const replies = (t, ...results) =>
  t.mock.method(gateway, 'send', async () => results.shift());

test('retries a timeout', async (t) => {
  const send = replies(t, { code: 'timeout' }, { ok: true });
  assert.ok((await charge('tok_visa', 500)).ok);
  assert.equal(send.mock.callCount(), 2);
});

test('gives up after three tries', async (t) => {
  const send = replies(t, ...Array(5).fill({ code: 'timeout' }));
  await charge('tok_visa', 500);
  assert.equal(send.mock.callCount(), 3);
});

test('never retries a hard decline', async (t) => {
  const send = replies(t, { code: 'card_declined' });
  await charge('tok_visa', 500);
  assert.equal(send.mock.callCount(), 1);
});
`;

/** Claude Code works here from the start; Codex joins in a pane beside it. */
export const RETRIES: VideoWorkspace = {
  id: 'ws-retries',
  projectId: ACME_WEB.id,
  title: 'Card Retries',
  branch: 'card-retries',
  minutesAgo: 2,
  commits: [
    {
      message: 'Charge cards through the gateway',
      files: {
        // `npm test` runs node's test runner for real in the video.
        'package.json': JSON.stringify(
          {
            name: 'acme-web',
            version: '0.1.0',
            private: true,
            type: 'module',
            scripts: { dev: 'vite', test: 'node --test' },
          },
          null,
          2
        ),
        'src/billing/gateway.js': GATEWAY_JS,
        'src/billing/charge.js': CHARGE_JS,
      },
    },
  ],
  agent: {
    title: '✳ Card retries',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Retry declined charges when the decline is temporary',
        verb: 'Percolating',
        events: [
          { tool: 'Read', arg: 'src/billing/charge.js', result: ['Read 5 lines'], delay: 400 },
          { waitFor: GO },
          {
            edit: 'src/billing/charge.js',
            find: 'export async function charge(card, cents) {\n  return gateway.send(card, cents);\n}',
            replace:
              "// Declines worth another try.\nconst RETRY = ['timeout', 'try_again'];\n\nexport async function charge(card, cents) {\n  let res;\n  for (let i = 0; i < 3; i++) {\n    res = await gateway.send(card, cents);\n    if (res.ok) break;\n    if (!RETRY.includes(res.code)) break;\n  }\n  return res;\n}",
            delay: 700,
          },
          {
            tool: 'Read',
            arg: 'src/billing/gateway.js',
            result: ['Read 11 lines'],
            verb: 'Pondering',
            delay: 2200,
          },
          {
            edit: 'src/billing/gateway.js',
            find: '      body: JSON.stringify({ card, cents }),',
            replace:
              '      body: JSON.stringify({ card, cents }),\n      signal: AbortSignal.timeout(10_000),',
            delay: 1800,
          },
          { waitFor: HOLD },
        ],
      },
    ],
  },
};

/** Codex, launched from the pane menu, plays this wherever it starts. */
export const CODEX_TESTS = `${RETRIES.branch}:codex`;

export const codexTestsAgent: AgentScene = {
  look: 'codex',
  title: 'Codex',
  turns: [
    {
      auto: true,
      afterMs: 200,
      prompt: 'Test the retries in charge()',
      events: [
        { tool: 'Read', arg: 'src/billing/charge.js', delay: 400 },
        {
          write: 'src/billing/charge.test.js',
          content: CHARGE_TEST_JS,
          verb: 'Writing tests',
          delay: 700,
        },
        { waitFor: HOLD },
      ],
    },
  ],
};

export const PANES_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [ACME_WEB],
  workspaces: [RETRIES, ...BACKGROUND_WORKSPACES],
  // Full auto, since the agents run on the devbox.
  presets: [CLAUDE_PRESET, { ...CODEX_PRESET, scene: CODEX_TESTS, launchMode: 'YOLO' }],
  spawnedAgents: { [CODEX_TESTS]: codexTestsAgent },
  // Two panes side by side keep about 64 columns each.
  terminal: { font: { size: 13 } },
};
