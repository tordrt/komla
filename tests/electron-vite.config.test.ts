import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import config from '../electron.vite.config';

describe('electron-vite renderer configuration', () => {
  it('keeps optimized dependencies out of the shared node_modules directory', () => {
    expect(config.renderer?.cacheDir).toBe(resolve('.cache/vite/renderer'));
  });

  it('pre-bundles lazy Monaco runtime entries before opening an editor', () => {
    expect(config.renderer?.optimizeDeps?.include).toEqual(
      expect.arrayContaining([
        'monaco-editor',
        'monaco-editor/esm/vs/language/json/monaco.contribution.js',
        'monaco-editor/esm/vs/language/json/jsonMode.js',
        'monaco-editor/esm/vs/editor/browser/widget/diffEditor/features/overviewRulerFeature.js',
        'shiki',
        '@shikijs/monaco',
        'monaco-vim',
      ])
    );
  });

  it('pre-bundles every lazily mounted file-tree runtime entry', () => {
    expect(config.renderer?.optimizeDeps?.include).toEqual(
      expect.arrayContaining(['@pierre/trees', '@pierre/trees/react', '@pierre/theming/color'])
    );
  });

  it('pre-bundles dependencies of the lazily loaded Settings dialog', () => {
    expect(config.renderer?.optimizeDeps?.include).toEqual(expect.arrayContaining(['qrcode']));
  });

  it('writes license notices for the packages every bundle includes', () => {
    for (const build of [config.main, config.preload, config.renderer]) {
      const names = (build?.plugins ?? [])
        .flat()
        .map((plugin) => (plugin as { name?: string }).name);
      expect(names).toContain('komla:third-party-licenses');
    }
  });
});
