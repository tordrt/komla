import { describe, expect, it } from 'vitest';

import { z } from 'zod';

import {
  renderKomlaSdkTypes,
  renderType,
  type JsonSchema,
} from '../../../src/main/services/komla-operation/sdk-types';

describe('Komla SDK types', () => {
  // `npm run generate:sdk` rewrites the file after an operation's schema changes (ADR 0008).
  it('match the schemas Komla validates operations with', async () => {
    await expect(renderKomlaSdkTypes()).toMatchFileSnapshot(
      '../../../packages/sdk/src/generated.ts'
    );
  });

  const render = (schema: z.ZodType) =>
    renderType(z.toJSONSchema(schema, { io: 'output' }) as JsonSchema);

  it('refuse to render a record or a loose object rather than type it wrong', () => {
    expect(() => render(z.record(z.string(), z.number()))).toThrow(/only strict objects/);
    expect(() => render(z.looseObject({ id: z.string() }))).toThrow(/only strict objects/);
  });

  it("keep a description's `*/` from ending its comment", () => {
    expect(render(z.object({ glob: z.string().describe('Matches src/**/*.ts') }).strict())).toBe(
      '{\n  /** Matches src/**\\/*.ts */\n  glob: string;\n}'
    );
  });
});
