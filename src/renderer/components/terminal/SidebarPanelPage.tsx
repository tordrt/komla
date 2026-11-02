import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

import { readPopoverTheme } from '@/components/command-page/command-page';
import { pluginCardId } from '@/components/layout/settings/plugin-card';
import { Spinner } from '@/components/ui/spinner';
import { useRunWhileVisible } from '@/hooks/useRunWhileVisible';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import {
  keepSidebarPanelData,
  sidebarPanelKey,
  useSidebarPanelState,
  useSidebarPanelsStore,
} from '@/stores/sidebar-panels.store';

import { sidebarPanelBadgeInputSchema } from '../../../shared/ipc/schemas/sidebar-panels-ipc.schemas';
import { isBrowserUrl } from '../../../shared/lib/browser-tabs';

import { SidebarPanelHeader } from './SidebarPanelHeader';

import type {
  SidebarPanel,
  SidebarPanelOperationResult,
} from '../../../shared/types/sidebar-panels';

/** A message the page's `komla` sends, which Komla reads with care: the page made it. */
type PageMessage = {
  komlaPanel?: unknown;
  id?: unknown;
  token?: unknown;
  name?: unknown;
  request?: unknown;
  workspace?: unknown;
  url?: unknown;
  message?: unknown;
  badge?: unknown;
};

type Reply = { ok: true; result?: unknown } | Extract<SidebarPanelOperationResult, { ok: false }>;

function failed(code: string, message: string): Reply {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A sidebar panel with a page of its own, in Komla's preview sandbox: it loads once and stays
 * while the panel shows. Its command's output, or what its plugin's code posts, comes to it as
 * data when it opens, on its interval and the events it refreshes on while the window can be
 * seen, and when it asks; the window's theme as it changes, and the workspace's events. `komla`
 * in the page asks Komla for the rest: commands the panel names, from a click, links, its tab's
 * badge, messages to its plugin's code, and Komla Operations, which Komla checks against what
 * the panel declares.
 */
export function SidebarPanelPage({
  workspaceId,
  panel,
}: {
  workspaceId: string;
  panel: SidebarPanel;
}) {
  const key = sidebarPanelKey(workspaceId, panel);
  const [page, setPage] = useState<{ url?: string; error?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  // Loads the page again while its plugin is in development.
  const [reloads, setReloads] = useState(0);
  const last = useSidebarPanelsStore((s) => s.data[key]);
  const posted = useSidebarPanelState(workspaceId, panel.id)?.data;
  const frame = useRef<HTMLIFrameElement>(null);
  // The token the page's `komla` sent first, which only it can send again.
  const token = useRef<string | null>(null);
  const running = useRef<Promise<void> | null>(null);
  const theme = useRef('');

  const post = useCallback((message: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(message, '*');
  }, []);

  // A page for this window, in its theme as it is now; later changes come as messages.
  useEffect(() => {
    let current = true;
    setPage(null);
    token.current = null;
    const now = readPopoverTheme();
    theme.current = JSON.stringify(now);
    void window.api
      .getSidebarPanelPage(workspaceId, panel.id, now)
      .then((result) => current && setPage(result))
      .catch((error: Error) => current && setPage({ error: error.message }));
    return () => {
      current = false;
    };
  }, [workspaceId, panel.id, panel.revision, reloads]);

  // What the plugin's code posts, as it posts it.
  useEffect(() => {
    if (posted && token.current !== null) {
      post({ komlaPanel: 'data', data: posted.data, error: posted.error });
    }
  }, [posted, post]);

  // The workspace's events, for the page's komla.on; Komla left out what agents said.
  useEffect(
    () =>
      window.api.onKomlaEvent((event) => {
        if (token.current === null) return;
        if (panel.runOn !== 'local' && event.workspaceId !== workspaceId) return;
        post({ komlaPanel: 'event', event });
      }),
    [workspaceId, panel.runOn, post]
  );

  const load = useCallback((): Promise<void> => {
    if (!panel.command) return Promise.resolve();
    if (running.current) return running.current;
    setLoading(true);
    const run = window.api
      .runSidebarPanelData(workspaceId, panel.id)
      .catch((error: Error) => ({ data: undefined, error: error.message }))
      .then((result) => {
        // A failed run keeps the data before it, with the error.
        const previous = useSidebarPanelsStore.getState().data[key];
        const next = result.error ? { data: previous?.data, error: result.error } : result;
        keepSidebarPanelData(key, next);
        post({ komlaPanel: 'data', data: next.data, error: next.error });
      })
      .finally(() => {
        running.current = null;
        setLoading(false);
      });
    running.current = run;
    return run;
  }, [workspaceId, panel.id, panel.command, key, post]);

  useEffect(() => {
    void load();
  }, [load]);

  useRunWhileVisible({
    key,
    intervalSeconds: panel.intervalSeconds,
    busy: loading,
    run: () => void load(),
    enabled: Boolean(panel.command),
    refreshOn: panel.refreshOn,
    workspaceId,
    runOn: panel.runOn,
  });

  // The window's theme, as the user changes it, without loading the page again.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const now = readPopoverTheme();
      const serialized = JSON.stringify(now);
      if (serialized === theme.current) return;
      theme.current = serialized;
      post({ komlaPanel: 'theme', theme: now });
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme'],
    });
    return () => observer.disconnect();
  }, [post]);

  const answer = async (message: PageMessage, activated: boolean): Promise<Reply> => {
    switch (message.komlaPanel) {
      case 'refresh':
        await load();
        return { ok: true };
      case 'run': {
        if (!activated) {
          return failed('NEEDS_USER_ACTION', 'komla.run works only from a click or a key press.');
        }
        if (typeof message.name !== 'string') return failed('INVALID_REQUEST', 'Name a command.');
        const result = await window.api.runSidebarPanelButton(workspaceId, panel.id, message.name);
        void load();
        return result.error ? failed('COMMAND_FAILED', result.error) : { ok: true };
      }
      case 'send':
        return window.api.sendSidebarPanelMessage(workspaceId, panel.id, message.message ?? null, {
          activated,
        });
      case 'open-settings':
        if (!activated) {
          return failed(
            'NEEDS_USER_ACTION',
            'komla.openSettings works only from a click or a key press.'
          );
        }
        if (!panel.pluginId) {
          return failed('NOT_A_PLUGIN', 'Only a plugin’s panel has settings to open.');
        }
        useSettingsDialogStore
          .getState()
          .openSettings({ tab: 'integrations', cardId: pluginCardId(panel.pluginId) });
        return { ok: true };
      case 'badge': {
        const badge = sidebarPanelBadgeInputSchema.safeParse(message.badge);
        if (!badge.success) {
          return failed('INVALID_BADGE', 'A badge is text or a number, with a tone, or null.');
        }
        await window.api.setSidebarPanelBadge(workspaceId, panel.id, badge.data);
        return { ok: true };
      }
      case 'call': {
        if (!isRecord(message.request)) {
          return failed('INVALID_OPERATION', 'An operation is an object with a type.');
        }
        return window.api.runSidebarPanelOperation(workspaceId, panel.id, message.request, {
          activated,
          ...(typeof message.workspace === 'string' && { workspace: message.workspace }),
        });
      }
      default:
        return failed('INVALID_REQUEST', 'Komla has no such request for a panel.');
    }
  };

  const onMessage = useEffectEvent((event: MessageEvent) => {
    if (!frame.current || event.source !== frame.current.contentWindow) return;
    const message = event.data as PageMessage | null;
    if (!isRecord(message) || typeof message.komlaPanel !== 'string') return;
    const activated = token.current !== null && message.token === token.current;
    if (message.komlaPanel === 'hello') {
      if (token.current === null && typeof message.token === 'string') {
        token.current = message.token;
      }
      // Brings the page up to date, as the theme may have changed since Komla made it.
      post({ komlaPanel: 'theme', theme: readPopoverTheme() });
      if (last) post({ komlaPanel: 'data', data: last.data, error: last.error });
      if (posted) post({ komlaPanel: 'data', data: posted.data, error: posted.error });
      return;
    }
    if (message.komlaPanel === 'open-link') {
      if (activated && typeof message.url === 'string' && isBrowserUrl(message.url)) {
        void window.api.openExternal(message.url);
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const id = message.id;
    void answer(message, activated)
      .catch((error: Error) => failed('OPERATION_FAILED', error.message))
      .then((reply) => post({ komlaPanel: 'reply', id, ...reply }));
  });

  useEffect(() => {
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col" data-sidebar-panel={panel.id}>
      <SidebarPanelHeader
        panel={panel}
        loading={loading}
        onRefresh={panel.command ? () => void load() : undefined}
        onReload={() => setReloads((count) => count + 1)}
      />
      {last?.error && (
        <p className="shrink-0 border-b border-foreground/10 px-3 py-1.5 text-xs break-words text-muted-foreground">
          The panel's command failed: {last.error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        {page?.url ? (
          <iframe
            ref={frame}
            title={panel.title}
            src={page.url}
            // No allow-same-origin, so scripts in the page can't reach Komla; no popups or navigation.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="block h-full w-full border-0 bg-transparent"
          />
        ) : page?.error ? (
          <p className="px-3 py-2.5 text-xs break-words text-muted-foreground">
            The panel's page can't load: {page.error}
          </p>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
            <Spinner size="xs" />
            Loading…
          </div>
        )}
      </div>
    </div>
  );
}
