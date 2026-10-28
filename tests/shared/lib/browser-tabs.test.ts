import { describe, expect, it } from 'vitest';

import {
  MAX_BROWSER_TABS,
  addBrowserTab,
  closeBrowserTab,
  getActiveBrowserTab,
  isBrowserUrl,
  isLocalPageUrl,
  isSignInPageUrl,
  normalizeBrowserTabs,
  openUrlInNewBrowserTab,
  recordBrowserTabPage,
  selectBrowserTab,
  setActiveBrowserTabUrl,
  setBrowserTabUrl,
  toBrowserUrl,
} from '../../../src/shared/lib/browser-tabs';

import type { WorkspaceBrowserTab } from '../../../src/shared/types/workspace';

function workspaceWith(browserTabs: WorkspaceBrowserTab[], activeBrowserTabId?: string) {
  return { browserTabs, activeBrowserTabId };
}

describe('browser tab URLs', () => {
  it('accepts any http(s) URL and nothing else', () => {
    expect(isBrowserUrl('http://localhost:3000')).toBe(true);
    expect(isBrowserUrl('https://example.com/docs?q=1')).toBe(true);
    expect(isBrowserUrl('file:///etc/passwd')).toBe(false);
    expect(isBrowserUrl('javascript:alert(1)')).toBe(false);
    expect(isBrowserUrl('example.com')).toBe(false);
    expect(isBrowserUrl(`https://example.com/${'a'.repeat(2048)}`)).toBe(false);
  });
});

describe('pages on this computer', () => {
  it.each([
    'http://localhost:3000/',
    'http://app.localhost:5173/',
    'http://127.0.0.2:8080/',
    'http://[::1]:3000/',
    'http://0.0.0.0:3000/',
  ])('counts %s', (url) => {
    expect(isLocalPageUrl(url)).toBe(true);
  });

  it.each(['https://example.com/', 'http://192.168.1.20:5173/', 'http://localhost.evil.com/', ''])(
    'does not count %j',
    (url) => {
      expect(isLocalPageUrl(url)).toBe(false);
    }
  );
});

describe('sign-in pages', () => {
  it.each([
    // OAuth sign-ins of Claude Code, Codex and Gemini CLI.
    'https://claude.ai/oauth/authorize?code=true&client_id=9d1c&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&code_challenge=abc&state=xyz',
    'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_1&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A45289%2Foauth2callback&response_type=code&client_id=6812.apps.googleusercontent.com',
    // Device-code pages: GitHub (gh, Copilot CLI), Microsoft, AWS.
    'https://github.com/login/device',
    'https://microsoft.com/devicelogin',
    'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
    // Other CLIs' sign-in pages.
    'https://cursor.com/loginDeepControl?challenge=abc&uuid=def&mode=login',
    'https://dashboard.stripe.com/stripecli/confirm_auth?t=abc',
    'https://www.npmjs.com/login?next=/login/cli/123',
    'https://login.tailscale.com/a/1a2b3c',
    'https://app.example.com/sign-in',
  ])('counts %s', (url) => {
    expect(isSignInPageUrl(url)).toBe(true);
  });

  it.each([
    'https://example.com/docs',
    'https://example.com/authors',
    'https://author.example.com/blog',
    // Code or docs about signing in, deep in a site.
    'https://github.com/org/repo/blob/main/src/auth/index.ts',
    'https://docs.github.com/en/authentication/connecting-to-github-with-ssh',
    'mailto:dev@example.com',
    // Pages on this computer are your own app's.
    'http://localhost:3000/login',
    'http://127.0.0.1:8080/oauth/authorize?client_id=app_1',
  ])('does not count %s', (url) => {
    expect(isSignInPageUrl(url)).toBe(false);
  });
});

describe('typed addresses', () => {
  it.each([
    ['http://localhost:3000/a', 'http://localhost:3000/a'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:8080/x', 'http://127.0.0.1:8080/x'],
    ['192.168.1.20:5173', 'http://192.168.1.20:5173'],
    ['example.com/docs', 'https://example.com/docs'],
    ['  https://example.com  ', 'https://example.com'],
  ])('reads %s as %s', (typed, url) => {
    expect(toBrowserUrl(typed)).toBe(url);
  });

  it.each(['', 'not a url', 'intranet', 'file:///etc/passwd', 'ftp://example.com'])(
    'rejects %j',
    (typed) => {
      expect(toBrowserUrl(typed)).toBeNull();
    }
  );
});

describe('opening a URL in a tab of its own', () => {
  it('adds a tab beside one on the same site', () => {
    const state = openUrlInNewBrowserTab(
      workspaceWith([{ id: 'a', url: 'http://localhost:3000/', title: 'Home' }], 'a'),
      'http://localhost:3000/report',
      'workspace',
      'new'
    );
    expect(state).toEqual({
      browserTabs: [
        { id: 'a', url: 'http://localhost:3000/', title: 'Home' },
        { id: 'new', url: 'http://localhost:3000/report' },
      ],
      activeBrowserTabId: 'new',
    });
  });

  it('shows a tab already at that URL on the same machine', () => {
    const tabs: WorkspaceBrowserTab[] = [
      { id: 'a', url: 'http://localhost:3000/', title: 'Home' },
      { id: 'b', url: 'https://example.com/' },
    ];
    expect(openUrlInNewBrowserTab(workspaceWith(tabs, 'b'), 'http://localhost:3000/')).toEqual({
      browserTabs: tabs,
      activeBrowserTabId: 'a',
    });
    expect(
      openUrlInNewBrowserTab(
        workspaceWith(tabs, 'b'),
        'http://localhost:3000/',
        'local-mirror',
        'new'
      ).activeBrowserTabId
    ).toBe('new');
  });

  it('shows the tab at that URL however it is written, leaving its page alone', () => {
    const tabs: WorkspaceBrowserTab[] = [
      { id: 'a', url: 'http://localhost:3000/', title: 'Home' },
      { id: 'b', url: 'https://example.com/' },
    ];
    const workspace = workspaceWith(tabs, 'b');
    const state = openUrlInNewBrowserTab(workspace, 'http://localhost:3000');
    expect(state.browserTabs).toBe(workspace.browserTabs);
    expect(state.activeBrowserTabId).toBe('a');
  });

  it('changes nothing when the tab at that URL is already on screen', () => {
    const workspace = workspaceWith([{ id: 'a', url: 'https://example.com/docs' }], 'a');
    expect(openUrlInNewBrowserTab(workspace, 'https://example.com/docs')).toEqual({
      browserTabs: workspace.browserTabs,
      activeBrowserTabId: 'a',
    });
    expect(openUrlInNewBrowserTab(workspace, 'https://example.com/docs').browserTabs).toBe(
      workspace.browserTabs
    );
  });

  it('shows the tab at a website URL whichever machine the link came from', () => {
    const tabs: WorkspaceBrowserTab[] = [
      { id: 'a', url: 'https://example.com/docs', urlExecutionLocation: 'local-mirror' },
      { id: 'b', url: 'http://localhost:3000/' },
    ];
    expect(
      openUrlInNewBrowserTab(workspaceWith(tabs, 'b'), 'https://example.com/docs', 'workspace')
        .activeBrowserTabId
    ).toBe('a');
  });

  it('fills the active tab when it has no page yet', () => {
    expect(
      openUrlInNewBrowserTab(workspaceWith([{ id: 'a', url: '' }], 'a'), 'http://localhost:3000/')
    ).toEqual({
      browserTabs: [{ id: 'a', url: 'http://localhost:3000/' }],
      activeBrowserTabId: 'a',
    });
  });

  it('uses the active tab once the workspace holds as many tabs as it can', () => {
    const tabs = Array.from({ length: MAX_BROWSER_TABS }, (_, index) => ({
      id: `t${index}`,
      url: `http://localhost:${3000 + index}/`,
    }));
    const state = openUrlInNewBrowserTab(workspaceWith(tabs, 't2'), 'http://localhost:3000/x');
    expect(state.browserTabs).toHaveLength(MAX_BROWSER_TABS);
    expect(state.activeBrowserTabId).toBe('t2');
    expect(state.browserTabs[2].url).toBe('http://localhost:3000/x');
    expect(addBrowserTab(workspaceWith(tabs, 't2')).browserTabs).toHaveLength(MAX_BROWSER_TABS);
  });
});

describe('changing tabs', () => {
  it('keeps the active tab when the saved active id is gone', () => {
    expect(getActiveBrowserTab(workspaceWith([{ id: 'a', url: '' }], 'gone'))?.id).toBe('a');
  });

  it('keeps a tab on its machine unless told otherwise', () => {
    const workspace = workspaceWith(
      [{ id: 'a', url: 'http://localhost:3000/', urlExecutionLocation: 'local-mirror' }],
      'a'
    );
    expect(setBrowserTabUrl(workspace, 'a', 'http://localhost:4000/').browserTabs).toEqual([
      { id: 'a', url: 'http://localhost:4000/', urlExecutionLocation: 'local-mirror' },
    ]);
    expect(
      setBrowserTabUrl(workspace, 'a', 'http://localhost:4000/', 'workspace').browserTabs
    ).toEqual([{ id: 'a', url: 'http://localhost:4000/' }]);
  });

  it('points the active tab at a URL, or starts one', () => {
    expect(
      setActiveBrowserTabUrl(
        workspaceWith(
          [
            { id: 'a', url: '' },
            { id: 'b', url: 'https://example.com/', title: 'Example' },
          ],
          'b'
        ),
        'http://localhost:3000/'
      ).browserTabs
    ).toEqual([
      { id: 'a', url: '' },
      { id: 'b', url: 'http://localhost:3000/' },
    ]);
    expect(setActiveBrowserTabUrl(undefined, 'http://localhost:3000/').browserTabs).toEqual([
      { id: expect.stringMatching(/^browser-/), url: 'http://localhost:3000/' },
    ]);
  });

  it('records where a tab navigated and its title, and nothing when unchanged', () => {
    const workspace = workspaceWith([{ id: 'a', url: 'https://example.com/' }], 'a');
    const next = recordBrowserTabPage(workspace, 'a', {
      url: 'https://example.com/docs',
      title: 'Docs',
    });
    expect(next?.browserTabs).toEqual([
      { id: 'a', url: 'https://example.com/docs', title: 'Docs' },
    ]);
    expect(
      recordBrowserTabPage({ ...workspace, browserTabs: next!.browserTabs }, 'a', {
        url: 'https://example.com/docs',
        title: 'Docs',
      })
    ).toBeNull();
    expect(
      recordBrowserTabPage(workspace, 'a', { url: 'chrome-error://chromewebdata/' })
    ).toBeNull();
    expect(recordBrowserTabPage(workspace, 'missing', { title: 'x' })).toBeNull();
  });

  it('shows the neighbour to the right after closing the active tab, else the left one', () => {
    const workspace = workspaceWith(
      [
        { id: 'a', url: '' },
        { id: 'b', url: '' },
        { id: 'c', url: '' },
      ],
      'b'
    );
    expect(closeBrowserTab(workspace, 'b').activeBrowserTabId).toBe('c');
    expect(closeBrowserTab({ ...workspace, activeBrowserTabId: 'c' }, 'c').activeBrowserTabId).toBe(
      'b'
    );
    expect(closeBrowserTab(workspace, 'a').activeBrowserTabId).toBe('b');
    expect(closeBrowserTab(workspaceWith([{ id: 'a', url: '' }], 'a'), 'a')).toEqual({
      browserTabs: [],
      activeBrowserTabId: undefined,
    });
  });

  it('ignores selecting a tab that does not exist', () => {
    const workspace = workspaceWith([{ id: 'a', url: '' }], 'a');
    expect(selectBrowserTab(workspace, 'missing').activeBrowserTabId).toBe('a');
  });
});

describe('saved tabs', () => {
  it('drops invalid, duplicate and non-web entries', () => {
    expect(
      normalizeBrowserTabs([
        { id: 'a', url: 'http://localhost:3000/', urlExecutionLocation: 'local-mirror' },
        { id: 'a', url: 'https://duplicate.example/' },
        { id: 'b', url: 'file:///etc/passwd' },
        { id: '', url: '' },
        { id: 'c', url: '', urlExecutionLocation: 'elsewhere', title: 'x'.repeat(400) },
        'not a tab',
      ])
    ).toEqual([
      { id: 'a', url: 'http://localhost:3000/', urlExecutionLocation: 'local-mirror' },
      { id: 'c', url: '', title: 'x'.repeat(300) },
    ]);
    expect(normalizeBrowserTabs([])).toBeUndefined();
    expect(normalizeBrowserTabs('nope')).toBeUndefined();
  });
});
