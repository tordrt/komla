/**
 * The Inbox videos' world: the agent-status agents across two projects, with
 * Rate Limiting also stopping to ask, so each project gets a workspace waiting
 * on input above one that's done.
 */
import { ASK, FINISH, GO, HOLD, RATE_LIMIT as STATUS_RATE_LIMIT } from './agent-status.scene';
import {
  AUTH,
  DARK_MODE_ACCEPT_EDITS as DARK_MODE,
  NAV,
  SEARCH,
  STRIPE,
} from './agent-status.scene';
import type { VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_API, ACME_WEB, DEVBOX } from './worlds';

export { ASK, AUTH, DARK_MODE, FINISH, GO, HOLD, NAV, SEARCH, STRIPE };

const rateLimitTurn = STATUS_RATE_LIMIT.agent!.turns![0];

/** Writes its limiter, then asks to install the package it uses. */
export const RATE_LIMIT: VideoWorkspace = {
  ...STATUS_RATE_LIMIT,
  agent: {
    ...STATUS_RATE_LIMIT.agent,
    mode: 'acceptEdits',
    turns: [
      {
        ...rateLimitTurn,
        events: [
          ...rateLimitTurn.events.filter((event) => !('waitFor' in event)),
          { waitFor: ASK },
          {
            permission: {
              title: 'Bash command',
              detail: 'npm install express-rate-limit',
              message: 'Claude needs your permission to use Bash',
            },
            delay: 100,
          },
          {
            tool: 'Bash',
            arg: 'npm install express-rate-limit',
            result: ['added 1 package in 1s'],
            verb: 'Installing',
            delay: 500,
          },
          { waitFor: HOLD },
        ],
      },
    ],
  },
};

/** In sidebar order; the agents start in this order off camera. */
export const INBOX_WORKSPACES = [AUTH, DARK_MODE, NAV, STRIPE, RATE_LIMIT, SEARCH];

const world = (config: Record<string, unknown>): VideoWorld => ({
  sshHost: DEVBOX,
  projects: [ACME_WEB, ACME_API],
  workspaces: INBOX_WORKSPACES,
  terminal: { font: { size: 12 } },
  config,
});

/** Inbox mode on, with working workspaces still listed below the line. */
export const INBOX_WORLD = world({
  inboxMode: true,
  hideWorkingWorkspaces: false,
});

/** Inbox mode off; the video turns it on, which folds working workspaces away. */
export const INBOX_FOLDED_WORLD = world({
  inboxMode: false,
  hideWorkingWorkspaces: false,
});
