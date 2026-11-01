import { z } from 'zod';

export const diagnosticsRendererStatsArgsSchema = z.tuple([
  z.object({
    terminalCacheSize: z.number(),
    parkedTerminalCount: z.number(),
    activeWebglContexts: z.number(),
    timestamp: z.number(),
  }),
]);
