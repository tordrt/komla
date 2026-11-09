/**
 * The CI panel video's world: the agent that opened a pull request for yearly billing is asked for a
 * sidebar panel that shows the pull request's checks, with a button to re-run the failed ones. The
 * stand-in `gh` serves the checks: one failing, then running after the re-run, then all passed.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { VideoPullRequest, VideoWorkspace, VideoWorld } from './video-fixtures';
import { BACKGROUND_WORKSPACES, DEVBOX, WEB_APP } from './worlds';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROMPT =
  'Add a sidebar panel with this PR’s CI checks and a button to re-run the failed ones';
/** The panel's tab, which also names its page's frame. */
export const PANEL_TITLE = 'CI';

const PANEL_FILE = '~/.config/komla/ci-panel.json';
const SCRIPT = '~/.config/komla/ci-panel.sh';
const PANEL = {
  _version: 1,
  panels: [
    {
      id: 'ci',
      title: PANEL_TITLE,
      command: `sh ${SCRIPT}`,
      intervalSeconds: 10,
      commands: { rerun: 'gh run rerun --failed' },
    },
  ],
};

type Checks = VideoPullRequest['checks'];
const CHECKS: Checks = [
  { name: 'lint', workflowName: 'CI', state: 'passed' },
  { name: 'typecheck', workflowName: 'CI', state: 'passed' },
  { name: 'unit tests', workflowName: 'CI', state: 'passed' },
  { name: 'build', workflowName: 'CI', state: 'passed' },
  { name: 'e2e', workflowName: 'CI', state: 'failed' },
  { name: 'preview deploy', workflowName: 'Deploy', state: 'passed' },
];
const withE2e = (state: Checks[number]['state']): Checks =>
  CHECKS.map((check) => (check.name === 'e2e' ? { ...check, state } : check));

const PULL_REQUEST = { number: 128, title: 'Add yearly billing' };
/** The pull request when the panel opens: the e2e job failed. */
export const PULL_REQUEST_FAILED: VideoPullRequest = { ...PULL_REQUEST, checks: CHECKS };
/** After the re-run starts the failed job again. */
export const PULL_REQUEST_RERUNNING: VideoPullRequest = {
  ...PULL_REQUEST,
  checks: withE2e('pending'),
};
export const PULL_REQUEST_PASSED: VideoPullRequest = { ...PULL_REQUEST, checks: withE2e('passed') };

export const BILLING: VideoWorkspace = {
  id: 'ws-billing',
  projectId: WEB_APP.id,
  title: 'Yearly Billing',
  branch: 'yearly-billing',
  minutesAgo: 0,
  commits: [
    {
      message: 'Add yearly billing',
      files: {
        'src/lib/checkout.ts':
          "export type Interval = 'month' | 'year';\n\nexport async function startCheckout(plan: string, interval: Interval = 'month') {\n  return { plan, interval };\n}\n",
        'src/lib/saving.ts':
          'export function yearlySaving(monthly: number): number {\n  return monthly * 12 * 0.2;\n}\n',
      },
    },
  ],
  // On GitHub, so it has a pull request for the stand-in `gh` to describe.
  pushed: true,
  agent: {
    title: '✳ Yearly billing',
    history: [
      { prompt: 'Let people pay yearly at checkout, monthly by default' },
      { tool: 'Update', arg: 'src/lib/checkout.ts', result: ['Added 4 lines, removed 1 line'] },
      { tool: 'Write', arg: 'src/lib/saving.ts', result: ['Wrote 4 lines'] },
      { tool: 'Bash', arg: 'npm test', result: ['2 passed (2)'] },
      {
        tool: 'Bash',
        arg: 'gh pr create --fill',
        result: ['https://github.com/acme/acme-web/pull/128'],
      },
      { say: 'Opened #128, Add yearly billing.' },
      { done: 'Cooked for 1m 12s' },
    ],
    turns: [
      {
        verb: 'Designing',
        doneVerb: 'Crafted',
        events: [
          {
            tool: 'Bash',
            arg: 'komla skill integrations',
            result: ['# Komla Integrations: Status Bar Items, Sidebar Panels and Plugins', '…'],
            delay: 700,
          },
          {
            bash: `gh pr view --json number,title,statusCheckRollup --jq '"#\\(.number) \\(.title): \\(.statusCheckRollup | length) checks"'`,
            delay: 600,
          },
          {
            write: SCRIPT,
            content: fs.readFileSync(path.join(__dirname, 'assets', 'ci-panel.sh'), 'utf8'),
            delay: 1000,
          },
          { bash: `sh ${SCRIPT} | jq -r '.buttons[0].label'`, delay: 500 },
          { write: PANEL_FILE, content: `${JSON.stringify(PANEL, null, 2)}\n`, delay: 600 },
          { settings: 'sidebar-panels', file: PANEL_FILE, delay: 500 },
          {
            say: 'Added a **CI** tab to the sidebar. It lists this PR’s checks by state, failed first, and its **Re-run failed** button starts them again.',
            delay: 300,
          },
        ],
      },
    ],
  },
};

export const CI_PANEL_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [WEB_APP],
  workspaces: [BILLING, ...BACKGROUND_WORKSPACES],
};
