import { z } from 'zod';

import { AGENT_STATES_BY_URGENCY, type AgentState } from '../../../shared/lib/agent-state';
import { AGENTS_MENU_BAR_IMAGE_MAX_DATA_URL_LENGTH } from '../../../shared/types';

import { idSchema } from './primitives';

const sizeSchema = z.number().positive().max(10_000);

export const agentsMenuBarImageArgsSchema = z.tuple([
  z
    .object({
      counts: z
        .array(
          z
            .object({
              state: z.enum(AGENT_STATES_BY_URGENCY as [AgentState, ...AgentState[]]),
              count: z.number().int().positive().max(1_000_000),
            })
            .strip()
        )
        .max(AGENT_STATES_BY_URGENCY.length),
      dataUrl: z.string().max(AGENTS_MENU_BAR_IMAGE_MAX_DATA_URL_LENGTH),
      width: sizeSchema,
      height: sizeSchema,
    })
    .strip(),
]);

export const agentsMenuBarResizeArgsSchema = z.tuple([sizeSchema, sizeSchema]);

export const agentsMenuBarOpenArgsSchema = z.tuple([idSchema, idSchema.optional()]);

export const agentsMenuBarCloseArgsSchema = z.tuple([]);

export const agentsMenuBarStateRequestArgsSchema = z.tuple([]);

export const agentsMenuBarThemeArgsSchema = z.tuple([
  z.object({ className: z.string().max(1_000), style: z.string().max(50_000) }).strip(),
]);
