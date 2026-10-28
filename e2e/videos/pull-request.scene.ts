/**
 * The pull request video's world: an agent pushes its work and opens a pull request, and the hooks
 * guide's CI script tags the workspace while the checks run, then notifies when they pass.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  SANDBOX_DIR,
  type VideoPullRequest,
  type VideoWorkspace,
  type VideoWorld,
} from './video-fixtures';
import { ACME_WEB, BACKGROUND_WORKSPACES } from './worlds';

export const PROMPT = 'Open a PR for this';

export const BILLING: VideoWorkspace = {
  id: 'ws-billing',
  projectId: ACME_WEB.id,
  title: 'Yearly Billing',
  branch: 'yearly-billing',
  minutesAgo: 0,
  agent: {
    title: '✳ Yearly billing',
    history: [
      { prompt: 'Let people pay yearly at checkout, monthly by default' },
      { tool: 'Update', arg: 'src/lib/checkout.ts', result: ['Added 4 lines, removed 1 line'] },
      { tool: 'Write', arg: 'src/lib/saving.ts', result: ['Wrote 4 lines'] },
      { tool: 'Bash', arg: 'npm test', result: ['2 passed (2)'] },
      {
        say: 'Checkout takes a billing interval, monthly by default, and each plan shows its yearly saving.',
      },
      { done: 'Cooked for 1m 12s' },
    ],
    turns: [
      {
        verb: 'Shipping',
        doneVerb: 'Shipped',
        events: [
          {
            tool: 'Bash',
            arg: 'git commit -am "Add yearly billing" && git push -u origin yearly-billing',
            run: 'git commit --quiet --allow-empty -m "Add yearly billing" && git push --quiet -u origin yearly-billing',
            result: ['branch yearly-billing set up to track origin/yearly-billing'],
            delay: 700,
          },
          {
            tool: 'Bash',
            arg: 'gh pr create --fill',
            run: 'gh pr create --fill',
            result: ['https://github.com/acme/acme-web/pull/128'],
            delay: 600,
          },
          { say: 'Opened #128, Add yearly billing.', delay: 500 },
        ],
      },
    ],
  },
};

const CHECKS: VideoPullRequest['checks'] = [
  { name: 'lint', workflowName: 'CI', state: 'passed' },
  { name: 'typecheck', workflowName: 'CI', state: 'passed' },
  { name: 'unit tests', workflowName: 'CI', state: 'pending' },
  { name: 'e2e', workflowName: 'CI', state: 'pending' },
  { name: 'preview deploy', state: 'pending' },
];

export const PULL_REQUEST_RUNNING: VideoPullRequest = {
  number: 128,
  title: 'Add yearly billing',
  checks: CHECKS,
};

export const PULL_REQUEST_PASSED: VideoPullRequest = {
  ...PULL_REQUEST_RUNNING,
  checks: CHECKS.map((check) => ({ ...check, state: 'passed' })),
};

/** Where we look while the checks run. */
export const CHECKOUT = BACKGROUND_WORKSPACES[0];

const CI_SCRIPT = path.join(SANDBOX_DIR, 'ci-tag.sh');

/** The hooks guide's CI script, as the guide gives it, so the video shows what users set up. */
function writeCiScript(): void {
  const guide = fs.readFileSync(
    fileURLToPath(
      new URL('../../resources/skills/komla-customize-instructions.md', import.meta.url)
    ),
    'utf8'
  );
  const script = guide.match(
    /```sh\n(#!\/bin\/sh\n# Tags the workspace "CI running"[\s\S]*?)```/
  )?.[1];
  if (!script) throw new Error('The hooks guide no longer has its CI script');
  fs.writeFileSync(CI_SCRIPT, script, { mode: 0o755 });
}

/**
 * Writes hooks.json with the guide's interval hook. Komla runs interval hooks again when the file
 * changes, so writing it again stands in for the two minutes coming round.
 */
export function writeCiHook(): void {
  if (!fs.existsSync(CI_SCRIPT)) writeCiScript();
  const tmp = path.join(SANDBOX_DIR, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const hooks = {
    _version: 1,
    hooks: [
      {
        id: 'ci-tag',
        event: 'interval',
        intervalSeconds: 120,
        // Its state file in the sandbox, which each run starts without.
        command: `TMPDIR='${tmp}' sh '${CI_SCRIPT}'`,
      },
    ],
  };
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'settings', 'hooks.json'),
    JSON.stringify(hooks, null, 2)
  );
}

export const PULL_REQUEST_WORLD: VideoWorld = {
  // On this computer: the stand-in `gh` answers for a local workspace.
  projects: [ACME_WEB],
  workspaces: [
    BILLING,
    {
      ...CHECKOUT,
      agent: {
        title: '✳ Stripe checkout',
        history: [
          { prompt: 'Move checkout to Stripe Checkout sessions' },
          { tool: 'Update', arg: 'src/lib/checkout.ts', result: ['Added 3 lines, removed 1 line'] },
          { say: 'Checkout now creates a Stripe Checkout session for the chosen plan.' },
          { done: 'Baked for 41s' },
        ],
      },
    },
    ...BACKGROUND_WORKSPACES.slice(1),
  ],
  // The hook tags and notifies, as the guide says to set it up: Komla's own pull request tags off,
  // and its CI notification too, which would say the same.
  config: { pullRequestCiNotifications: false },
};
