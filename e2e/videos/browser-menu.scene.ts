/**
 * The browser-menu video's world: an agent adds yearly billing to the pricing
 * page and leaves four things to look at: its dev server, Firefox on a virtual
 * desktop, an HTML audit in its scratchpad, and the artifact it published. It
 * runs on the SSH host, where `komla desktop` has Xvnc.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { PREVIEW_PORT, PREVIEW_URL, PRICING_WEB, YEARLY_EVENTS } from './browser-preview.scene';
import type { VideoProject, VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_WEB, BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

export { PREVIEW_PORT };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// At their real path, where the SSH host has this directory mounted.
const ASSETS = path.join(fs.realpathSync(__dirname), 'assets');
const assetPath = (relativePath: string) => path.join(ASSETS, relativePath);

const DESCRIPTION =
  'Start free and upgrade when your team grows. Hobby, Pro and Team plans for teams that ship every day.';
/** What a real site's head says about it, so the server's hover card shows a preview. */
const SITE_HEAD = `    <title>Pricing · Acme</title>
    <meta name="description" content="${DESCRIPTION}" />
    <meta property="og:site_name" content="Acme" />
    <meta property="og:title" content="Pricing · Acme" />
    <meta property="og:description" content="${DESCRIPTION}" />
    <link rel="icon" href="favicon.svg" />`;

/** The pricing site with its head filled in and the project's icon as its favicon. */
const AUDIT_WEB: VideoProject = {
  ...PRICING_WEB,
  files: {
    ...PRICING_WEB.files,
    'site/index.html': PRICING_WEB.files['site/index.html'].replace(
      '    <title>Pricing · Acme</title>',
      SITE_HEAD
    ),
    'site/favicon.svg': fs.readFileSync(assetPath('icons/acme-web.svg'), 'utf8'),
  },
};

const BRANCH = 'pricing-audit';
/** Where Claude Code keeps a session's scratch files: by user, then workspace folder, then session. */
const SCRATCHPAD = `/tmp/claude-1000/-home-komla--komla-worktrees-acme-web-${BRANCH}/5d1e0c4a-8f3b-4c7e-9a21-3b6f0d2e7c84/scratchpad`;
export const REPORT = `${SCRATCHPAD}/pricing-audit.html`;
export const ARTIFACT_URL = 'https://claude.ai/code/artifact/9b2f6e1d-3c4a-4f8e-b7d5-2a1c0e9f8b36';
export const DESKTOP_APP = `firefox-esr ${PREVIEW_URL}`;

export const AUDIT: VideoWorkspace = {
  id: 'ws-pricing-audit',
  projectId: ACME_WEB.id,
  title: 'Pricing Audit',
  branch: BRANCH,
  minutesAgo: 0,
  agent: {
    title: '✳ Pricing audit',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Add yearly billing to the pricing page, then audit it and share the results',
        verb: 'Auditing',
        doneVerb: 'Baked',
        events: [
          ...YEARLY_EVENTS,
          {
            tool: 'Bash',
            arg: `komla desktop run -- ${DESKTOP_APP}`,
            // In the background, as the app keeps it running.
            run: `komla desktop run -- ${DESKTOP_APP} >/dev/null 2>&1 &`,
            result: [
              'Virtual desktop :1 is ready: open it from the globe button at the top of Komla.',
            ],
            delay: 600,
          },
          {
            tool: 'Write',
            arg: REPORT,
            run: `mkdir -p '${SCRATCHPAD}' && cp '${assetPath('pricing-audit.html')}' '${REPORT}'`,
            result: ['Wrote 168 lines'],
            delay: 600,
          },
          {
            tool: 'Artifact',
            arg: 'Pricing page audit',
            result: ['Published as a private artifact'],
            delay: 600,
          },
          {
            // Each path and URL on its own line, so the terminal never wraps one.
            say: `Yearly billing is in, and the page passes its audit after two contrast fixes.\n\nDev server:\n${PREVIEW_URL}\n\nFirefox has it open on virtual desktop :1.\n\nThe audit:\n${REPORT}\n\nShared with the team:\n${ARTIFACT_URL}`,
            delay: 600,
          },
        ],
      },
    ],
  },
};

export const BROWSER_MENU_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [AUDIT_WEB],
  workspaces: [AUDIT, ...BACKGROUND_WORKSPACES],
  // Pages open beside the terminal instead of over it.
  config: { defaultInlinePreviewLayout: 'side-by-side' },
};
