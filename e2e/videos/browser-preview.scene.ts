/**
 * The browser-preview video's world: an agent adds yearly billing to the
 * pricing page, starts its dev server and prints a docs link, then makes the
 * Pro plan stand out while the page is open in Komla's browser.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_WEB, BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (relativePath: string) =>
  fs.readFileSync(path.join(__dirname, 'assets', relativePath), 'utf8');

export const PREVIEW_PORT = 4310;
export const PREVIEW_URL = `http://localhost:${PREVIEW_PORT}`;
/** A real page, so the links list shows its title; GitHub's isn't localized by location. */
export const DOCS_URL = 'https://github.com/stripe/stripe-node';

export const YEARLY_PROMPT = 'Add yearly billing to the pricing page and start the dev server';
export const STAND_OUT_PROMPT = 'Make the Pro plan stand out';

const BILLING_CSS = `.billing {
  display: flex;
  gap: 4px;
  width: fit-content;
  margin: 20px auto 0;
  padding: 4px;
  border-radius: 999px;
  background: #f1f3f6;
}

.billing__option {
  border: 0;
  border-radius: 999px;
  padding: 7px 16px;
  font: inherit;
  font-size: 14px;
  background: none;
  color: #555;
}

.billing__option.is-active {
  background: #fff;
  color: #111;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
}

.save {
  margin-left: 6px;
  padding: 2px 7px;
  border-radius: 999px;
  font-size: 12px;
  background: #e8eaee;
  color: #555;
}`;

const STAND_OUT_CSS = `.featured {
  border: 2px solid #2a6bd1;
  border-radius: 14px;
  background: #f3f7fe;
  transform: translateY(-8px);
  box-shadow: 0 16px 36px rgb(42 107 209 / 0.2);
}`;

export const ANNUAL: VideoWorkspace = {
  id: 'ws-annual',
  projectId: ACME_WEB.id,
  title: 'Yearly Pricing',
  branch: 'yearly-pricing',
  minutesAgo: 0,
  agent: {
    title: '✳ Yearly pricing',
    turns: [
      {
        verb: 'Pricing',
        doneVerb: 'Baked',
        events: [
          { tool: 'Read', arg: 'site/index.html', result: ['Read 68 lines'], delay: 500 },
          {
            edit: 'site/index.html',
            find: '    <link rel="stylesheet" href="styles.css" />',
            replace:
              '    <link rel="stylesheet" href="styles.css" />\n    <link rel="stylesheet" href="billing.css" />',
            delay: 500,
          },
          {
            edit: 'site/index.html',
            find: '      <section class="plans">',
            replace:
              '      <div class="billing">\n        <button class="billing__option">Monthly</button>\n        <button class="billing__option is-active">Yearly<span class="save">Save 20%</span></button>\n      </div>\n\n      <section class="plans">',
            delay: 700,
          },
          {
            edit: 'site/index.html',
            find: '$19</span><span class="period">/month',
            replace: '$15</span><span class="period">/month, billed yearly',
            delay: 500,
          },
          {
            edit: 'site/index.html',
            find: '$49</span><span class="period">/month',
            replace: '$39</span><span class="period">/month, billed yearly',
            delay: 400,
          },
          // A file of its own, so the terminal shows a few lines rather than the whole stylesheet.
          { write: 'site/billing.css', content: `${BILLING_CSS}\n`, delay: 500 },
          { serve: 'site', port: PREVIEW_PORT, delay: 500 },
          {
            // Each URL on its own line, so the terminal never wraps one.
            say: `Added a Monthly / Yearly switch. Yearly prices are 20% lower and map to yearly Prices in stripe-node:\n${DOCS_URL}\n\nThe dev server is running at\n${PREVIEW_URL}`,
            delay: 600,
          },
        ],
      },
      {
        verb: 'Restyling',
        doneVerb: 'Baked',
        events: [
          { append: 'site/billing.css', content: STAND_OUT_CSS, delay: 500 },
          { say: 'The Pro plan now sits higher, with a blue outline and a soft shadow.', delay: 400 },
        ],
      },
    ],
  },
};

export const BROWSER_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [
    {
      ...ACME_WEB,
      files: {
        ...ACME_WEB.files,
        'site/index.html': read('pricing-site/index.html'),
        'site/styles.css': read('pricing-site/styles.css'),
      },
    },
  ],
  workspaces: [ANNUAL, ...BACKGROUND_WORKSPACES],
  // Pages open beside the terminal instead of over it.
  config: { defaultInlinePreviewLayout: 'side-by-side' },
};
