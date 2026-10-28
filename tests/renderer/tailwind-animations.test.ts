import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const globalsCss = fileURLToPath(new URL('../../src/renderer/styles/globals.css', import.meta.url));
const uiDir = new URL('../../src/renderer/components/ui/', import.meta.url);
const ANIMATION_CLASS =
  /(?:[\w-]+-\[[^\]\s]+\]:)*(?:animate-(?:in|out)|(?:fade|zoom)-(?:in|out)-[\w.]+|slide-(?:in-from|out-to)-(?:top|bottom|left|right)-[\w./[\]%]+)(?=[\s'"`])/g;

async function generateCss(classes: string): Promise<string> {
  const compiler = await compile(readFileSync(globalsCss, 'utf8'), {
    base: path.dirname(globalsCss),
    loadStylesheet: async (id, base) => {
      const file = id.startsWith('.')
        ? path.resolve(base, id)
        : require.resolve(id === 'tailwindcss' ? 'tailwindcss/index.css' : id);
      return { path: file, base: path.dirname(file), content: readFileSync(file, 'utf8') };
    },
  });
  return compiler.build(classes.split(/\s+/));
}

/** The rule Tailwind generated for one class, from its selector to the first closing brace. */
function ruleFor(css: string, cls: string): string | undefined {
  const selector = `.${cls.replace(/[^\w-]/g, (c) => `\\${c}`)}`;
  const match = new RegExp(`${selector.replace(/[\\.[\]()]/g, '\\$&')}(?=[\\s[{:])`).exec(css);
  if (!match) return undefined;
  return css.slice(match.index, css.indexOf('}', match.index) + 1);
}

function animationClassesUsedByUiPrimitives(): string[] {
  const used = new Set<string>();
  for (const file of readdirSync(uiDir)) {
    const source = readFileSync(new URL(file, uiDir), 'utf8');
    for (const [cls] of source.matchAll(ANIMATION_CLASS)) used.add(cls);
  }
  return [...used];
}

describe('overlay animation utilities', () => {
  it('generates a rule for every enter/exit class the UI primitives use', async () => {
    const classes = animationClassesUsedByUiPrimitives();
    expect(classes).toEqual(
      expect.arrayContaining([
        'data-[state=closed]:animate-out',
        'data-[state=open]:zoom-in-95',
        'data-[side=bottom]:slide-in-from-top-2',
      ])
    );

    const css = await generateCss(classes.join(' '));
    for (const cls of classes) {
      expect(ruleFor(css, cls), cls).toMatch(/\{\s*(animation-name|--tw-(enter|exit)-)/);
    }
  });

  it('defines enter/exit keyframes that read the utility variables', async () => {
    const css = await generateCss('animate-in animate-out');

    expect(css).toMatch(/@keyframes enter\s*\{\s*from\s*\{[^}]*var\(--tw-enter-opacity, 1\)/);
    expect(css).toMatch(/@keyframes exit\s*\{\s*to\s*\{[^}]*var\(--tw-exit-scale, 1\)/);
    // Exit animations must have a finite duration so Radix Presence unmounts on animationend.
    expect(css).toMatch(/\.animate-out\s*\{\s*animation-name: exit;\s*animation-duration: 150ms/);
  });

  it("leaves the element's own translate to the translate property", async () => {
    const css = await generateCss('animate-in translate-x-[-50%]');

    // Tailwind 4 translate utilities compose with the keyframes' transform, so repeating
    // the element's translate in the keyframes would move centered dialogs twice as far.
    expect(ruleFor(css, 'translate-x-[-50%]')).toContain('translate: var(--tw-translate-x)');
    expect(css).not.toMatch(/@keyframes (enter|exit)[^@]*--tw-translate-x/);
  });

  it('supports theme spacing, fractions and arbitrary values for slides', async () => {
    const css = await generateCss(
      'slide-in-from-left-1/2 slide-out-to-top-[48%] slide-in-from-right-2 fade-out-50'
    );

    expect(css).toContain('--tw-enter-translate-x: calc(1 / 2 * -100%)');
    expect(css).toContain('--tw-exit-translate-y: calc(48% * -1)');
    expect(css).toContain('--tw-enter-translate-x: calc(var(--spacing) * 2)');
    expect(css).toContain('--tw-exit-opacity: calc(50 / 100)');
  });
});
