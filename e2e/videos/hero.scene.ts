/**
 * The hero video's world: one agent on the SSH host fans a pricing-page
 * redesign out to four new workspaces, each restyling the page live in a
 * browser beside its agent.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { DEFAULT_AGENT, type AgentEvent, type AgentScene, type VideoWorld } from './video-fixtures';
import { ACME_WEB, DEVBOX } from './worlds';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, 'assets');
const read = (relativePath: string) => fs.readFileSync(path.join(ASSETS, relativePath), 'utf8');

/** The lead workspace comes from the new workspace dialog, so it plays the default scene. */
export const LEAD_AGENT = DEFAULT_AGENT;
export const LEAD_TITLE = 'Pricing Redesign';
export const LEAD_PROMPT =
  'Redesign the pricing page. Explore 4 directions in parallel, one workspace each.';

export const DESIGNS = [
  {
    name: 'Editorial',
    file: 'editorial',
    port: 4301,
    brief: 'a print magazine: cream paper, Didot headlines, oxblood accents',
  },
  {
    name: 'Midnight',
    file: 'midnight',
    port: 4302,
    brief: 'a dark product page: near-black, tight sans type, one lime accent',
  },
  {
    name: 'Brutalist',
    file: 'brutalist',
    port: 4303,
    brief: 'brutalism: heavy black borders, monospace, one loud yellow',
  },
  {
    name: 'Playful',
    file: 'playful',
    port: 4304,
    brief: 'something playful: pastel cards, rounded type, coral accents',
  },
].map((design) => ({ ...design, branch: `pricing-${design.file}` }));

/** The cue a design agent waits on before opening its preview, once a browser is beside it. */
export const PREVIEW_CUE = 'preview';
/** The cue a design agent waits on before restyling, so it happens on camera. */
export const RESTYLE_CUE = 'restyle';

function designAgent(design: (typeof DESIGNS)[number]): AgentScene {
  const stages = read(`designs/${design.file}.css`).split('/* @stage */');
  const url = `http://localhost:${design.port}`;
  const restyle: AgentEvent[] = stages.map((content, i) => ({
    append: 'site/styles.css',
    content,
    delay: i === 0 ? 250 : 1100,
  }));
  return {
    title: `✳ ${design.name} pricing page`,
    turns: [
      {
        verb: 'Sketching',
        doneVerb: 'Crafted',
        events: [
          { tool: 'Read', arg: 'site/index.html', result: ['Read 68 lines'], delay: 400 },
          { serve: 'site', port: design.port, delay: 400 },
          { waitFor: PREVIEW_CUE },
          {
            mcp: 'open_browser_preview',
            args: { url },
            result: [`Browser preview opened at ${url}`],
            delay: 500,
          },
          { waitFor: RESTYLE_CUE, verb: 'Restyling' },
          ...restyle,
          {
            say: `Restyled the pricing page as ${design.brief}. CSS only, markup untouched.`,
            delay: 700,
          },
        ],
      },
    ],
  };
}

const leadAgent: AgentScene = {
  title: '✳ Pricing redesign',
  turns: [
    {
      verb: 'Planning',
      doneVerb: 'Orchestrated',
      events: [
        {
          mcp: 'set_workspace_title',
          args: { title: LEAD_TITLE },
          result: [`Workspace title set to "${LEAD_TITLE}"`],
          delay: 500,
        },
        { tool: 'Read', arg: 'site/index.html', result: ['Read 68 lines'], delay: 400 },
        {
          say: "I'll explore four directions in parallel, each in its own workspace with a live preview.",
          delay: 500,
        },
        ...DESIGNS.map((design): AgentEvent => ({
          mcp: 'spawn_agent_in_new_workspace',
          args: {
            name: design.name,
            branchName: design.branch,
            initialPrompt: `Restyle site/ as ${design.brief}. CSS only. Start the dev server and open a browser preview.`,
          },
          show: { name: design.name, branchName: design.branch },
          result: [`Started Claude Code in "${design.name}"`],
          delay: 450,
        })),
        {
          say: 'All four are running. Switch between the workspaces to compare them as they build.',
          delay: 500,
        },
      ],
    },
  ],
};

export const HERO_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [
    {
      ...ACME_WEB,
      files: {
        'README.md': '# Acme Web\n\nMarketing site for Acme.\n',
        'package.json': JSON.stringify(
          { name: 'acme-web', private: true, scripts: { dev: 'node dev-server.mjs site' } },
          null,
          2
        ),
        'site/index.html': read('pricing-site/index.html'),
        'site/styles.css': read('pricing-site/styles.css'),
      },
    },
  ],
  // Komla starts empty; the lead workspace is created in the new workspace dialog.
  workspaces: [],
  spawnedAgents: {
    [LEAD_AGENT]: leadAgent,
    ...Object.fromEntries(DESIGNS.map((design) => [design.branch, designAgent(design)])),
  },
};
