/**
 * Starting points for new automations. Each run starts on a new branch with nobody
 * watching, so the prompts commit their work there for review instead of pushing.
 */
export interface AutomationTemplate {
  id: string;
  label: string;
  description: string;
  prompt: string;
  cron: string;
  missedRunGraceMinutes: number;
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'dependency-updates',
    label: 'Dependency updates',
    description: 'Update dependencies that pass the tests, and list the major upgrades waiting.',
    cron: '0 7 * * 1',
    missedRunGraceMinutes: 1440,
    prompt: `Check this project's dependencies for newer versions.

1. Update every patch and minor version, then install, build, and run the tests.
2. If something breaks, find the update that caused it and revert only that one.
3. Commit the updates that pass on this branch. Don't push.

Finish with a short summary: what you updated, what you reverted and why, and which major versions are available with what upgrading to each would take.`,
  },
  {
    id: 'ci-check',
    label: 'Fix CI on the default branch',
    description: 'Check the latest CI run and fix the failure if there is one.',
    cron: '0 8 * * 1-5',
    missedRunGraceMinutes: 180,
    prompt: `Check the latest CI run on the default branch. For GitHub Actions, use \`gh run list\` and \`gh run view --log-failed\`.

If it passed, say so and stop.

If it failed, find the cause. Reproduce it locally if you can, fix it, run the affected tests, and commit the fix on this branch. Don't push. If the failure comes from flakiness or the CI infrastructure rather than the code, explain that instead of changing code.`,
  },
  {
    id: 'issue-triage',
    label: 'Morning issue triage',
    description: 'Sort new GitHub issues into duplicates, real bugs, and quick fixes.',
    cron: '30 8 * * 1-5',
    missedRunGraceMinutes: 180,
    prompt: `Triage the GitHub issues opened or updated since yesterday, using \`gh issue list\` and \`gh issue view\`. Don't comment on, label, or close any of them.

For each issue, check whether it duplicates another one, try to reproduce it if it's a bug, and find the code involved.

Write a short report ordered by priority, with a suggested label and next step for each issue. If one has a small, obvious fix, make it with a test and commit it on this branch. Don't push.`,
  },
  {
    id: 'flaky-tests',
    label: 'Flaky test hunt',
    description: 'Run the tests several times and fix the ones that fail only sometimes.',
    cron: '0 2 * * *',
    missedRunGraceMinutes: 720,
    prompt: `Run the full test suite three times and note every test that fails in some runs but passes in others.

If every run passed, say so and stop.

For each flaky test, find the cause, such as timing, test order, shared state, or the network, and fix the cause rather than adding retries or longer timeouts. Run the test repeatedly to confirm the fix, then commit it on this branch. Don't push. List any flaky tests you couldn't fix and what you found.`,
  },
  {
    id: 'security-audit',
    label: 'Weekly security audit',
    description: 'Audit dependencies for known vulnerabilities and fix the safe ones.',
    cron: '0 7 * * 5',
    missedRunGraceMinutes: 1440,
    prompt: `Audit this project's dependencies for known vulnerabilities with the tools that fit it, such as \`npm audit\`, \`cargo audit\`, or \`pip-audit\`.

Apply the fixes that don't need a major version upgrade, then build and run the tests. Commit what passes on this branch. Don't push.

Finish with the vulnerabilities that remain, by severity: whether this project actually uses the vulnerable code, and what fixing each would take.`,
  },
  {
    id: 'daily-summary',
    label: 'What changed yesterday',
    description: 'Summarize the last day’s commits and flag risky or untested changes.',
    cron: '0 9 * * 1-5',
    missedRunGraceMinutes: 720,
    prompt: `Summarize the commits on the default branch from the last 24 hours. Fetch first if the repository has a remote you can reach.

Group them by area and describe each change in a sentence. Call out changes that look risky: missing tests, changed public behavior, data migrations, or security-sensitive code. Don't change any files.`,
  },
];
