import { describe, expect, it } from 'vitest';

import {
  MAX_RECENT_LINKS,
  isRecentLinkUrl,
  mergePrintedLinks,
  normalizeRecentLinks,
  recordOpenedLink,
} from '../../../src/shared/lib/recent-links';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('isRecentLinkUrl', () => {
  it('takes web pages on other sites, sign-in pages too', () => {
    expect(isRecentLinkUrl('https://github.com/acme/app/pull/1')).toBe(true);
    expect(isRecentLinkUrl('https://accounts.google.com/o/oauth2/auth?client_id=x')).toBe(true);
  });

  it('leaves out local pages and other schemes', () => {
    expect(isRecentLinkUrl('http://localhost:5173/')).toBe(false);
    expect(isRecentLinkUrl('http://127.0.0.1:8080/x')).toBe(false);
    expect(isRecentLinkUrl('file:///etc/hosts')).toBe(false);
    expect(isRecentLinkUrl('not a url')).toBe(false);
  });

  it('leaves out the local network addresses dev servers print', () => {
    for (const url of [
      'http://[::]:8000/',
      'http://192.168.1.23:5173/',
      'http://10.0.0.5:3000/',
      'http://172.20.0.2:8080/',
      'http://169.254.1.1/',
      'http://100.101.102.103:3000/',
      'http://[fd7a:115c:a1e0::1]:3000/',
      'http://[fe80::1]:3000/',
    ]) {
      expect(isRecentLinkUrl(url), url).toBe(false);
    }
    expect(isRecentLinkUrl('http://172.32.0.1/')).toBe(true);
    expect(isRecentLinkUrl('http://[2606:4700::1111]/')).toBe(true);
  });

  it('leaves out a link too long to save once its characters are spelled out', () => {
    expect(isRecentLinkUrl(`https://ru.wikipedia.org/wiki/${'я'.repeat(300)}`)).toBe(true);
    expect(isRecentLinkUrl(`https://ru.wikipedia.org/wiki/${'я'.repeat(1_000)}`)).toBe(false);
  });
});

describe('recordOpenedLink', () => {
  it('ranks an opened link as if printed two hours later', () => {
    const links = [
      { url: 'https://new.example/', printedAt: 10 * HOUR },
      { url: 'https://recent.example/', printedAt: 9 * HOUR },
      { url: 'https://old.example/', printedAt: 5 * HOUR },
    ];

    const order = (openedAt: number) =>
      recordOpenedLink(links, 'https://old.example/', openedAt).map((link) => link.url);

    expect(order(8.5 * HOUR)).toEqual([
      'https://old.example/',
      'https://new.example/',
      'https://recent.example/',
    ]);
    expect(order(7.5 * HOUR)).toEqual([
      'https://new.example/',
      'https://old.example/',
      'https://recent.example/',
    ]);
    expect(order(6 * HOUR)).toEqual([
      'https://new.example/',
      'https://recent.example/',
      'https://old.example/',
    ]);
  });

  it('keeps when the link was printed', () => {
    expect(
      recordOpenedLink([{ url: 'https://a.example/', printedAt: 3 }], 'https://a.example/', 7)
    ).toEqual([{ url: 'https://a.example/', printedAt: 3, openedAt: 7 }]);
  });

  it('treats a site with and without its trailing slash as one link', () => {
    const links = recordOpenedLink([{ url: 'https://a.example/' }], 'https://a.example', 7);

    expect(links).toEqual([{ url: 'https://a.example/', openedAt: 7 }]);
    expect(
      mergePrintedLinks(links, [{ url: 'https://a.example', printedAt: 5 }], 9).map(
        (link) => link.url
      )
    ).toEqual(['https://a.example/']);
  });

  it('ignores a link that does not belong in the list', () => {
    const links = [{ url: 'https://a.example/' }];
    expect(recordOpenedLink(links, 'http://localhost:3000/', 1)).toBe(links);
  });
});

describe('mergePrintedLinks', () => {
  it('orders links by when they were last printed', () => {
    const links = [
      { url: 'https://old.example/', printedAt: 1 * HOUR },
      { url: 'https://again.example/', printedAt: 2 * HOUR },
    ];

    expect(
      mergePrintedLinks(
        links,
        [
          { url: 'https://again.example/', printedAt: 9 * HOUR },
          { url: 'https://new.example/', printedAt: 5 * HOUR },
          { url: 'https://again.example/', printedAt: 3 * HOUR },
          { url: 'http://localhost:3000/', printedAt: 9.5 * HOUR },
        ],
        10 * HOUR
      )
    ).toEqual([
      { url: 'https://again.example/', printedAt: 9 * HOUR },
      { url: 'https://new.example/', printedAt: 5 * HOUR },
      { url: 'https://old.example/', printedAt: 1 * HOUR },
    ]);
  });

  it('takes the latest print of a link wherever it comes in the list, as from another terminal', () => {
    expect(
      mergePrintedLinks(
        [],
        [
          { url: 'https://a.example/', printedAt: 1 * HOUR },
          { url: 'https://a.example/', printedAt: 3 * HOUR },
          { url: 'https://a.example/', printedAt: 2 * HOUR },
        ],
        4 * HOUR
      )
    ).toEqual([{ url: 'https://a.example/', printedAt: 3 * HOUR }]);
  });

  it('keeps the time of a link printed again within a minute, as a redraw does', () => {
    const links = [{ url: 'https://a.example/', printedAt: 10 * MINUTE }];

    expect(
      mergePrintedLinks(links, [{ url: 'https://a.example/', printedAt: 10.9 * MINUTE }], 0)
    ).toEqual(links);
    expect(
      mergePrintedLinks(links, [{ url: 'https://a.example/', printedAt: 11 * MINUTE }], 0)
    ).toEqual([{ url: 'https://a.example/', printedAt: 11 * MINUTE }]);
  });

  it('counts a new link printed at an unknown time as printed now, and keeps a known one', () => {
    const links = [{ url: 'https://known.example/', printedAt: 4_000 }];

    expect(
      mergePrintedLinks(
        links,
        [{ url: 'https://known.example/' }, { url: 'https://new.example/' }],
        10_000
      )
    ).toEqual([
      { url: 'https://new.example/', printedAt: 10_000 },
      { url: 'https://known.example/', printedAt: 4_000 },
    ]);
  });

  it('never moves a link back to an earlier print', () => {
    expect(
      mergePrintedLinks(
        [{ url: 'https://a.example/', printedAt: 8_000 }],
        [{ url: 'https://a.example/', printedAt: 2_000 }],
        10_000
      )
    ).toEqual([{ url: 'https://a.example/', printedAt: 8_000 }]);
  });

  it('keeps the list to its limit, dropping the oldest links', () => {
    const printed = Array.from({ length: MAX_RECENT_LINKS + 5 }, (_, i) => ({
      url: `https://x.example/${i}`,
      printedAt: 1_000 - i,
    }));
    const merged = mergePrintedLinks(
      [{ url: 'https://opened.example/', openedAt: 1 }],
      printed,
      2_000
    );

    expect(merged).toHaveLength(MAX_RECENT_LINKS);
    expect(merged[0]).toEqual({ url: 'https://opened.example/', openedAt: 1 });
    expect(merged.at(-1)?.url).toBe(`https://x.example/${MAX_RECENT_LINKS - 2}`);
  });
});

describe('normalizeRecentLinks', () => {
  it('drops entries that are not links to other sites, and duplicates', () => {
    expect(
      normalizeRecentLinks([
        { url: 'https://a.example/', printedAt: 5 },
        { url: 'https://b.example/', openedAt: 3 },
        { url: 'https://a.example/', openedAt: 9 },
        { url: 'javascript:alert(1)' },
        { url: 'http://localhost:1/' },
        { url: 'https://c.example/', openedAt: 'yesterday' },
        null,
      ])
    ).toEqual([
      { url: 'https://b.example/', openedAt: 3 },
      { url: 'https://a.example/', printedAt: 5 },
      { url: 'https://c.example/' },
    ]);
  });

  it('is undefined for nothing to keep', () => {
    expect(normalizeRecentLinks(undefined)).toBeUndefined();
    expect(normalizeRecentLinks([{ url: 'ftp://x' }])).toBeUndefined();
  });
});
