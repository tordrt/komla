import { describe, expect, it } from 'vitest';

import { normalizeSavedLayout } from '../../../src/shared/lib/saved-layout';

const leaf = (pane: Record<string, unknown>) => ({ type: 'leaf', pane });
const browser = (url: string) => leaf({ kind: 'browser', browserTabs: [{ id: 'a', url }] });

describe('normalizeSavedLayout', () => {
  it('keeps a split, its sizes and its panes', () => {
    const layout = {
      tabs: [
        {
          type: 'split',
          direction: 'vertical',
          sizes: [70, 30],
          children: [
            leaf({ kind: 'agent' }),
            leaf({
              kind: 'browser',
              browserTabs: [{ id: 'a', url: 'http://localhost:3000' }],
              activeBrowserTabId: 'a',
            }),
          ],
        },
        leaf({ kind: 'note', name: 'note-1.md' }),
      ],
      activeTab: 1,
    };
    expect(normalizeSavedLayout(layout)).toEqual(layout);
  });

  it('turns a split left with one side into that side, and moves the tab on screen with it', () => {
    expect(
      normalizeSavedLayout({
        tabs: [
          leaf({ kind: 'mystery' }),
          {
            type: 'split',
            direction: 'horizontal',
            sizes: [50, 50],
            children: [browser('javascript:alert(1)'), leaf({ kind: 'setup-step', stepId: 'dev' })],
          },
          browser('https://example.com/'),
        ],
        activeTab: 2,
      })
    ).toEqual({
      tabs: [
        leaf({ kind: 'setup-step', stepId: 'dev' }),
        leaf({
          kind: 'browser',
          browserTabs: [{ id: 'a', url: 'https://example.com/' }],
          activeBrowserTabId: 'a',
        }),
      ],
      activeTab: 1,
    });
  });

  it('evens out sizes it cannot use', () => {
    expect(
      normalizeSavedLayout({
        tabs: [
          {
            type: 'split',
            direction: 'vertical',
            sizes: [Number.NaN, -1],
            children: [leaf({ kind: 'agent' }), browser('')],
          },
        ],
      })?.tabs[0]
    ).toMatchObject({ sizes: [50, 50] });
  });

  it('keeps nothing without a browser or a note to open again', () => {
    expect(
      normalizeSavedLayout({ tabs: [leaf({ kind: 'agent' }), leaf({ kind: 'setup-step', stepId: 'a' })] })
    ).toBeUndefined();
    expect(normalizeSavedLayout({ tabs: [] })).toBeUndefined();
    expect(normalizeSavedLayout('junk')).toBeUndefined();
  });

  it('keeps no more browsers or panes than a workspace holds', () => {
    const normalized = normalizeSavedLayout({
      tabs: Array.from({ length: 20 }, () => browser('')),
    });
    expect(normalized?.tabs).toHaveLength(12);

    const notes = normalizeSavedLayout({
      tabs: Array.from({ length: 80 }, (_, index) => leaf({ kind: 'note', name: `n-${index}.md` })),
    });
    expect(notes?.tabs).toHaveLength(64);
  });

  it('stops at a layout nested deeper than it could hold panes', () => {
    let node: Record<string, unknown> = browser('');
    for (let depth = 0; depth < 100; depth += 1) {
      node = { type: 'split', direction: 'vertical', sizes: [50, 50], children: [browser(''), node] };
    }
    expect(() => normalizeSavedLayout({ tabs: [node] })).not.toThrow();
  });
});
