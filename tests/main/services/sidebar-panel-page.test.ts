/**
 * @vitest-environment jsdom
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { KOMLA_STYLESHEET } from '../../../src/main/services/komla-page-styles';
import {
  sidebarPanelPageHead,
  withSidebarPanelHead,
} from '../../../src/main/services/sidebar-panel-page';

interface Komla {
  data: unknown;
  error: string | undefined;
  theme: { scheme: string; colors: Record<string, string> } | undefined;
  onData(listener: (data: unknown, error?: string) => void): () => void;
  onTheme(listener: (theme: unknown) => void): () => void;
  refresh(): Promise<unknown>;
  run(name: string): Promise<unknown>;
  call(request: unknown, options?: { workspace?: string }): Promise<unknown>;
  transport: { send(request: unknown, options?: unknown): Promise<unknown> };
  on(type: string, listener: (event: unknown) => void): () => void;
  send(message: unknown): Promise<unknown>;
  openSettings(): Promise<unknown>;
  workspace: { list(input?: unknown, options?: unknown): Promise<unknown> };
  agent: { launch(input: unknown): Promise<unknown> };
}

describe('withSidebarPanelHead', () => {
  it("puts Komla's head before the page's own, after its doctype", () => {
    expect(withSidebarPanelHead('<!DOCTYPE html>\n<p>hi</p>', 'H')).toBe(
      '<!DOCTYPE html>H\n<p>hi</p>'
    );
    expect(withSidebarPanelHead('<p>hi</p>', 'H')).toBe('H<p>hi</p>');
    // Before a script ahead of the page's head, or a `<head>` in its comment, which would run
    // first and could take `komla`'s place.
    expect(withSidebarPanelHead('<script>x()</script><head><title>x</title></head>', 'H')).toBe(
      'H<script>x()</script><head><title>x</title></head>'
    );
    expect(withSidebarPanelHead('<!doctype html><!-- <head> --><head></head>', 'H')).toBe(
      '<!doctype html>H<!-- <head> --><head></head>'
    );
    // After a comment and the doctype that follows it.
    expect(withSidebarPanelHead('<!-- made by x -->\n<!DOCTYPE html><p>hi</p>', 'H')).toBe(
      '<!-- made by x -->\n<!DOCTYPE html>H<p>hi</p>'
    );
    // The other ways a comment ends.
    expect(withSidebarPanelHead('<!-->\n<!--->\n<!-- a --!><!DOCTYPE html>', 'H')).toBe(
      '<!-->\n<!--->\n<!-- a --!><!DOCTYPE html>H'
    );
  });
});

describe('sidebarPanelPageHead', () => {
  it("has Komla's theme as CSS variables, its fonts, and leaves out what isn't a color", () => {
    const head = sidebarPanelPageHead({
      scheme: 'dark',
      colors: {
        foreground: '0.95 0 0',
        primary: '0 0 0; } body { display: none',
      },
    });
    expect(head).toContain(':root { --foreground: oklch(0.95 0 0); }');
    expect(head).toContain("url('/__komla/fonts/geist.woff2')");
    // The script gets the theme too, and leaves out the same colors as it applies them.
    expect(head.slice(head.indexOf('<style>'))).not.toContain('display: none');
  });

  it("keeps a theme's text from ending its script", () => {
    const head = sidebarPanelPageHead({
      scheme: 'dark',
      colors: { foreground: '</script><script>alert(1)</script>' },
    });
    expect(head.match(/<\/script>/g)).toHaveLength(1);
  });

  it('has a stylesheet in the theme', () => {
    expect(KOMLA_STYLESHEET).toContain('.k-button');
    expect(KOMLA_STYLESHEET).toContain('var(--primary)');
  });
});

describe("the page's komla", () => {
  let posted: Record<string, unknown>[] = [];
  let hello: Record<string, unknown>;
  let komla: Komla;

  // In jsdom the page is the top window, so Komla's window, its parent, is the page's own.
  function fromKomla(data: unknown, source: Window | null = window) {
    window.dispatchEvent(new MessageEvent('message', { data, source }));
  }

  // `komla` can't be taken back or made again in a window, so the tests share one.
  beforeAll(() => {
    vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Record<string, unknown>);
    });
    const head = sidebarPanelPageHead({
      scheme: 'light',
      colors: { success: '0.7 0.1 150' },
    });
    window.eval(head.slice(head.indexOf('<script>') + 8, head.indexOf('</script>')));
    komla = (window as unknown as { komla: Komla }).komla;
    hello = posted[0]!;
  });

  beforeEach(() => {
    posted = [];
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  /** The colors the bridge's own style sets, not the root's inline style the page may set. */
  const themeColors = () => document.head.querySelector('style')?.textContent;

  it('says hello with its token, and takes the theme it was made in', () => {
    expect(hello).toEqual({ komlaPanel: 'hello', token: expect.any(String) });
    expect(Object.isFrozen(komla)).toBe(true);
    expect(() => {
      (window as unknown as { komla: unknown }).komla = {};
    }).toThrow();
    expect(komla.theme).toEqual({
      scheme: 'light',
      colors: { success: '0.7 0.1 150' },
    });
    expect(themeColors()).toBe(':root:root { --success: oklch(0.7 0.1 150); }');
  });

  it("gives listeners each run's data, and the last one at once", () => {
    const first = vi.fn();
    komla.onData(first);
    expect(first).not.toHaveBeenCalled();

    fromKomla({ komlaPanel: 'data', data: { count: 1 } });
    expect(first).toHaveBeenLastCalledWith({ count: 1 }, undefined);
    fromKomla({ komlaPanel: 'data', data: { count: 1 }, error: 'timed out' });
    expect(komla.error).toBe('timed out');

    const later = vi.fn();
    const stop = komla.onData(later);
    expect(later).toHaveBeenCalledWith({ count: 1 }, 'timed out');
    stop();
    fromKomla({ komlaPanel: 'data', data: { count: 2 } });
    expect(later).toHaveBeenCalledTimes(1);
    expect(komla.data).toEqual({ count: 2 });
  });

  it("ignores messages that don't come from Komla's window", () => {
    fromKomla({ komlaPanel: 'data', data: 'forged' }, null);
    expect(komla.data).not.toBe('forged');
  });

  it('follows the theme as it changes, leaving out what is not a color', () => {
    const listener = vi.fn();
    komla.onTheme(listener);
    fromKomla({
      komlaPanel: 'theme',
      theme: {
        scheme: 'dark',
        colors: { primary: '0.6 0.2 250', error: 'red; x: y', bogus: '1 1 1' },
      },
    });

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(themeColors()).toBe(':root:root { --primary: oklch(0.6 0.2 250); }');
    expect(listener).toHaveBeenCalledWith({
      scheme: 'dark',
      colors: { primary: '0.6 0.2 250' },
    });
  });

  it("sends operations to Komla and settles with its reply, as the SDK's transport", async () => {
    const listed = komla.call({ type: 'workspace.list' });
    expect(posted).toEqual([
      {
        komlaPanel: 'call',
        id: expect.any(Number),
        request: { type: 'workspace.list' },
      },
    ]);
    // Not from a click, so without the token.
    expect(posted[0]).not.toHaveProperty('token');
    fromKomla({
      komlaPanel: 'reply',
      id: posted[0]!.id,
      ok: true,
      result: { workspaces: [] },
    });
    await expect(listed).resolves.toEqual({ workspaces: [] });

    const tagged = komla.transport.send({ type: 'workspace.tag', tag: 'x' }, { workspace: 'ws-2' });
    expect(posted[1]).toMatchObject({ komlaPanel: 'call', workspace: 'ws-2' });
    fromKomla({
      komlaPanel: 'reply',
      id: posted[1]!.id,
      ok: false,
      error: {
        code: 'CAPABILITY_NOT_DECLARED',
        message: 'No',
        details: { capability: 'workspace.tag' },
      },
    });
    await expect(tagged).rejects.toMatchObject({
      name: 'KomlaError',
      code: 'CAPABILITY_NOT_DECLARED',
      message: 'No',
      details: { capability: 'workspace.tag' },
    });
  });

  it('has a method for each Komla Operation, as the SDK client does', async () => {
    expect(Object.isFrozen(komla.workspace)).toBe(true);
    void komla.workspace.list(undefined, { workspace: 'ws-2' });
    void komla.agent.launch({ destination: 'tab', prompt: 'Fix it' });
    expect(posted).toEqual([
      {
        komlaPanel: 'call',
        id: expect.any(Number),
        request: { type: 'workspace.list' },
        workspace: 'ws-2',
      },
      {
        komlaPanel: 'call',
        id: expect.any(Number),
        request: { destination: 'tab', prompt: 'Fix it', type: 'agent.launch' },
      },
    ]);
  });

  it("sends messages to the plugin's code", async () => {
    const answered = komla.send({ want: 'review', number: 7 });
    expect(posted).toEqual([
      { komlaPanel: 'send', id: expect.any(Number), message: { want: 'review', number: 7 } },
    ]);
    fromKomla({ komlaPanel: 'reply', id: posted[0]!.id, ok: true, result: 'started' });
    await expect(answered).resolves.toBe('started');
  });

  it("gives listeners the workspace's events, by type or all of them", () => {
    const done = vi.fn();
    const every = vi.fn();
    const stop = komla.on('agent.done', done);
    komla.on('*', every);
    fromKomla({ komlaPanel: 'event', event: { type: 'agent.done', workspaceId: 'ws-1' } });
    fromKomla({ komlaPanel: 'event', event: { type: 'branch.changed', workspaceId: 'ws-1' } });
    fromKomla({ komlaPanel: 'event', event: 'not an event' });
    stop();
    fromKomla({ komlaPanel: 'event', event: { type: 'agent.done', workspaceId: 'ws-1' } });
    expect(done).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith({ type: 'agent.done', workspaceId: 'ws-1' });
    expect(every.mock.calls.map(([event]) => (event as { type: string }).type)).toEqual([
      'agent.done',
      'branch.changed',
      'agent.done',
    ]);
  });

  it("opens its plugin's settings only from a click", async () => {
    // jsdom has no user activation, so the click itself is for the e2e test.
    await expect(komla.openSettings()).rejects.toMatchObject({ code: 'NEEDS_USER_ACTION' });
    expect(posted).toEqual([]);
  });

  it('runs a command only from a click, and refreshes when asked', async () => {
    await expect(komla.run('rerun')).rejects.toMatchObject({
      code: 'NEEDS_USER_ACTION',
    });
    expect(posted).toEqual([]);

    const refreshed = komla.refresh();
    expect(posted).toEqual([{ komlaPanel: 'refresh', id: expect.any(Number) }]);
    fromKomla({ komlaPanel: 'reply', id: posted[0]!.id, ok: true });
    await expect(refreshed).resolves.toBeUndefined();
  });
});
