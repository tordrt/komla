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
import { ACME_WEB, BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

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
            run: 'git add -A && git commit --quiet --allow-empty -m "Add yearly billing" && git push --quiet -u origin yearly-billing',
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

/**
 * The CI script the hooks guide gave before it was cut down to its short form, so the video shows
 * a hook users set up.
 */
function ciScript(): string {
  return fs.readFileSync(fileURLToPath(new URL('./assets/ci-tag.sh', import.meta.url)), 'utf8');
}

/**
 * Writes hooks.json with the CI script's interval hook. Komla runs interval hooks again when the file
 * changes, so writing it again stands in for the two minutes coming round. Without `notify`, the
 * script only tags, and Komla's own CI notification says how the checks ended.
 */
export function writeCiHook({ notify = true } = {}): void {
  const file = path.join(SANDBOX_DIR, notify ? 'ci-tag.sh' : 'ci-tag-quiet.sh');
  if (!fs.existsSync(file)) {
    const script = ciScript();
    const quiet = script.replace(/^ *komla notify .*\n/gm, '');
    if (!notify && (quiet === script || quiet.includes('komla notify'))) {
      throw new Error('The CI script no longer notifies on lines of their own');
    }
    fs.writeFileSync(file, notify ? script : quiet, { mode: 0o755 });
  }
  const tmp = path.join(SANDBOX_DIR, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  const hooks = {
    _version: 1,
    hooks: [
      {
        id: 'ci-tag',
        event: 'interval',
        intervalSeconds: 120,
        // Its state file in the sandbox, which each run starts without. At their real paths, where
        // the SSH host has the sandbox mounted.
        command: `TMPDIR='${fs.realpathSync(tmp)}' sh '${fs.realpathSync(file)}'`,
      },
    ],
  };
  fs.writeFileSync(
    path.join(SANDBOX_DIR, 'settings', 'hooks.json'),
    JSON.stringify(hooks, null, 2)
  );
}

export const PULL_REQUEST_WORLD: VideoWorld = {
  sshHost: DEVBOX,
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
  // A narrow window, so the terminal trades a little size for columns.
  terminal: { font: { size: 13 } },
};
