import { join } from 'path';
import { pathToFileURL } from 'url';

import { describe, expect, it } from 'vitest';

import { getModuleDir } from '../../../src/main/lib/module-path';

describe('getModuleDir', () => {
  it('derives an ESM module directory without relying on CommonJS globals', () => {
    const entryPath = join(process.cwd(), 'out', 'main', 'index.js');

    expect(getModuleDir(pathToFileURL(entryPath).href)).toBe(join(process.cwd(), 'out', 'main'));
  });
});
