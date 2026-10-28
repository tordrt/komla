import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { describeSettingsSchema } from '../../../src/main/lib/settings-schema';

describe('describeSettingsSchema', () => {
  it('lists each field with its type, limits, default and description', () => {
    const schema = z
      .object({
        _version: z.number().int().optional(),
        hooks: z
          .array(
            z
              .object({
                id: z.string().regex(/^[a-z]+$/),
                event: z.enum(['agent.done', 'interval']).meta({ description: 'When it runs.' }),
                timeoutSeconds: z.number().int().min(1).max(3600).default(60),
                projects: z.array(z.string().min(1)).min(1).optional(),
              })
              .strict()
          )
          .max(50),
      })
      .strict()
      .meta({ description: 'The whole file.' });

    expect(describeSettingsSchema('hooks', [{ schema }])).toBe(
      [
        '# hooks',
        '',
        'The whole file.',
        '',
        '- `_version`: whole number.',
        '- `hooks` (required): list of up to 50 objects.',
        '  - `id` (required): text matching `^[a-z]+$`.',
        '  - `event` (required): one of `agent.done`, `interval`. When it runs.',
        '  - `timeoutSeconds`: whole number, 1 to 3600, 60 by default.',
        '  - `projects`: list of 1 or more items, each text, 1 or more characters.',
        '',
      ].join('\n')
    );
  });

  it('describes maps, unions and later sections', () => {
    const file = z.object({
      commands: z.record(z.string(), z.string().min(1)).optional(),
      on: z.boolean(),
    });
    const output = z.object({
      buttons: z.array(
        z.union([
          z.object({ label: z.string(), link: z.string() }),
          z.object({ label: z.string(), run: z.string() }),
        ])
      ),
      tone: z.union([z.literal('success'), z.literal('error')]),
    });

    const text = describeSettingsSchema('status-items', [
      { schema: file },
      { title: 'What a command prints', schema: output },
    ]);

    expect(text).toContain('- `commands`: map of names to text, 1 or more characters.');
    expect(text).toContain('- `on` (required): `true` or `false`.');
    expect(text).toContain('## What a command prints');
    expect(text).toContain('- `buttons` (required): list of objects, each one of these.');
    expect(text).toContain('  - Option 2: object.\n    - `label` (required): text.');
    expect(text).toContain('- `tone` (required): `"success"` or `"error"`.');
  });
});
