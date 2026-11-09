/**
 * The usage video's world: Antigravity CLI is asked for a status bar item that shows how much of the
 * weekly limit is left. It reads `agy -p /usage`, writes the script and the item, and Komla shows
 * the item for review. The item's popover lists each model group's share left and when it resets.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { ANTIGRAVITY_PRESET, type VideoWorkspace, type VideoWorld } from './video-fixtures';
import { BACKGROUND_WORKSPACES, DEVBOX, WEB_APP } from './worlds';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROMPT = 'Add a status bar item that shows how much of my weekly limit is left';
/** The item's label, which also names its popover's frame. */
export const ITEM_LABEL = 'Antigravity usage';

/** The quota `agy -p /usage` reports: Gemini is running low, Claude and GPT have all of theirs. */
const USAGE = [
  { name: 'Gemini Models', remaining: 38, refreshHours: 112 },
  { name: 'Claude and GPT models', remaining: 100, refreshHours: 150 },
];

const SCRIPT = '~/.config/komla/agy-usage.sh';
const ITEM_FILE = '~/.config/komla/agy-usage-item.json';
const ITEM = {
  _version: 1,
  items: [
    {
      id: 'agy-usage',
      label: ITEM_LABEL,
      command: `sh ${SCRIPT} status`,
      intervalSeconds: 300,
      popoverCommand: `sh ${SCRIPT} popover`,
    },
  ],
};

export const USAGE_WORKSPACE: VideoWorkspace = {
  id: 'ws-usage',
  projectId: WEB_APP.id,
  title: 'Antigravity Usage',
  branch: 'antigravity-usage',
  minutesAgo: 0,
  agent: {
    look: 'antigravity',
    usage: USAGE,
    turns: [
      {
        verb: 'Generating',
        events: [
          { tool: 'Bash', arg: 'komla skill integrations', verb: 'Running command', delay: 800 },
          { tool: 'Bash', arg: 'agy -p /usage', delay: 600 },
          {
            write: SCRIPT,
            content: fs.readFileSync(path.join(__dirname, 'assets', 'agy-usage.sh'), 'utf8'),
            verb: 'Editing files',
            delay: 1000,
          },
          { bash: `sh ${SCRIPT} status`, verb: 'Running command', delay: 500 },
          { write: ITEM_FILE, content: `${JSON.stringify(ITEM, null, 2)}\n`, delay: 700 },
          { settings: 'status-items', file: ITEM_FILE, delay: 500 },
          {
            say: 'Added an Antigravity usage item to the status bar. It shows the model group with the least of its weekly limit left, and clicking it lists each group and when it resets.',
            delay: 300,
          },
        ],
      },
    ],
  },
};

export const USAGE_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [WEB_APP],
  workspaces: [USAGE_WORKSPACE, ...BACKGROUND_WORKSPACES],
  presets: [ANTIGRAVITY_PRESET],
};
