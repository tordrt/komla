/**
 * The status-item video's world: the agent that added team invites makes a
 * status bar item for the migrations its branch's database hasn't run, whose
 * Run migrations button tags the workspace while they run and notifies once
 * they're applied.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { VideoProject, VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_API, ACME_WEB, BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROMPT =
  'Add a status bar item for this branch’s pending migrations, with a button to run them';

/** Where we look while the migrations run. */
export const CHECKOUT = BACKGROUND_WORKSPACES[0];

/** acme-api with the migrations main has run, which a branch's database starts with. */
const API: VideoProject = {
  ...ACME_API,
  files: {
    ...ACME_API.files,
    'db/migrations/20260912160400_create_teams.sql':
      '-- Teams and their members\ncreate table teams (\n  id uuid primary key default gen_random_uuid(),\n  name text not null\n);\n',
    'db/migrations/20261003081100_add_team_billing.sql':
      "-- A billing plan and Stripe customer per team\nalter table teams\n  add column plan text not null default 'free',\n  add column stripe_customer_id text;\n",
    'db/migrations/20261021113000_add_member_roles.sql':
      "-- Owner, admin and member roles\ncreate type member_role as enum ('owner', 'admin', 'member');\nalter table team_members add column role member_role not null default 'member';\n",
  },
};

const SCRIPT = 'scripts/migrations.sh';
const ITEMS_FILE = 'status-items.json';
const STATUS_ITEMS = {
  _version: 1,
  items: [
    {
      id: 'migrations',
      label: 'Migrations',
      command: `sh ${SCRIPT} status`,
      popoverCommand: `sh ${SCRIPT} popover`,
      commands: { migrate: `sh ${SCRIPT} migrate` },
      projects: [API.name],
    },
  ],
};

/** The branch's two new migrations, which its database hasn't run yet. */
const CREATE_INVITES = 'db/migrations/20261028141200_create_invites.sql';
const INVITE_EXPIRY = 'db/migrations/20261029093000_add_invite_expiry.sql';

export const INVITES: VideoWorkspace = {
  id: 'ws-invites',
  projectId: API.id,
  title: 'Team Invites',
  branch: 'team-invites',
  minutesAgo: 0,
  commits: [
    {
      message: 'Add team invites',
      files: {
        [CREATE_INVITES]:
          '-- Invites, with a token per email\ncreate table invites (\n  id uuid primary key default gen_random_uuid(),\n  team_id uuid not null references teams (id) on delete cascade,\n  email text not null,\n  token text not null unique,\n  created_at timestamptz not null default now()\n);\ncreate index invites_team_id on invites (team_id);\n',
        [INVITE_EXPIRY]:
          "-- Invite links expire after 7 days\nalter table invites\n  add column expires_at timestamptz not null default now() + interval '7 days';\n",
        'src/routes/invites.ts':
          "import { Router } from 'express';\n\nimport { db } from '../db';\n\nexport const invites = Router();\n",
      },
    },
  ],
  agent: {
    title: '✳ Team invites',
    history: [
      { prompt: 'Let team owners invite people by email, with links that expire after a week' },
      { tool: 'Write', arg: CREATE_INVITES, result: ['Wrote 9 lines'] },
      { tool: 'Write', arg: INVITE_EXPIRY, result: ['Wrote 3 lines'] },
      { tool: 'Write', arg: 'src/routes/invites.ts', result: ['Wrote 38 lines'] },
      { tool: 'Bash', arg: 'npm test -- invites', result: ['Tests  7 passed (7)'] },
      {
        say: 'Owners can invite people by email, and each link expires after 7 days. Two new migrations add the invites table and its expiry.',
      },
      { done: 'Cooked for 1m 48s' },
    ],
    turns: [
      {
        verb: 'Designing',
        doneVerb: 'Crafted',
        events: [
          {
            tool: 'Bash',
            arg: 'komla skill status-items',
            result: ['# Komla Status Bar Items', '…'],
            delay: 600,
          },
          {
            tool: 'Bash',
            arg: 'git diff --name-only main -- db/migrations',
            result: [CREATE_INVITES, INVITE_EXPIRY],
            delay: 500,
          },
          {
            write: SCRIPT,
            content: fs.readFileSync(path.join(__dirname, 'assets', 'migrations.sh'), 'utf8'),
            delay: 900,
          },
          {
            write: ITEMS_FILE,
            content: `${JSON.stringify(STATUS_ITEMS, null, 2)}\n`,
            delay: 700,
          },
          { settings: 'status-items', file: ITEMS_FILE, delay: 500 },
          {
            say: 'Added a **Migrations** item to the status bar. It counts the migrations this branch’s database hasn’t run, and its **Run migrations** button tags this workspace while they run, then notifies you.',
            delay: 300,
          },
        ],
      },
    ],
  },
};

export const STATUS_ITEM_WORLD: VideoWorld = {
  // On the SSH host, where the item's commands run with the `komla` CLI.
  sshHost: DEVBOX,
  // acme-api first, so its card heads the sidebar.
  projects: [API, ACME_WEB],
  workspaces: [INVITES, ...BACKGROUND_WORKSPACES],
};
