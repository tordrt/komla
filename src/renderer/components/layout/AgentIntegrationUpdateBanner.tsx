import { ArrowsClockwise } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

import { BANNER_PRIORITY, useBannerSlot } from '@/components/layout/BannerHost';
import { Banner, BannerAction } from '@/components/ui/banner';
import { useSettingsDialogStore } from '@/stores/settings-dialog.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';

import type { SshAgent, SshIntegrationUpdates } from '@/types';

const DISMISSED_STORAGE_KEY = 'komla.integrationUpdatesDismissed';
const DISMISSED_KEY_LIMIT = 100;
/** Keeps the first check, which asks Claude Code for its version in a login shell, out of startup. */
export const INTEGRATION_UPDATE_CHECK_DELAY_MS = 10_000;

const AGENT_LABELS: Record<SshAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
};

interface PendingUpdate {
  agent: SshAgent;
  hostId?: string;
  /** Changes with what Komla would install, so a dismissal covers only this update. */
  key: string;
}

/** FNV-1a, so the remembered keys stay short. */
function digest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

async function loadLocalUpdates(): Promise<PendingUpdate[]> {
  const results = await Promise.allSettled([
    window.api
      .getNotificationHookDetails()
      .then((d) => ['claude', d.update, d.configJson] as const),
    window.api
      .getCodexNotificationHookDetails()
      .then((d) => ['codex', d.update, d.configJson] as const),
    window.api
      .getAntigravityNotificationHookDetails()
      .then((d) => ['antigravity', d.update, d.configJson] as const),
    window.api
      .getOpenCodeNotificationHookDetails()
      .then((d) => ['opencode', d.update, d.pluginContent] as const),
  ]);
  return results.flatMap((result) => {
    if (result.status !== 'fulfilled' || !result.value[1]) return [];
    const [agent, , installs] = result.value;
    return [{ agent, key: `local:${agent}:${digest(installs)}` }];
  });
}

function sshUpdates(cached: Record<string, SshIntegrationUpdates>): PendingUpdate[] {
  return Object.entries(cached).flatMap(([hostId, updates]) =>
    (Object.entries(updates) as [SshAgent, string][]).map(([agent, installs]) => ({
      agent,
      hostId,
      key: `ssh:${hostId}:${agent}:${digest(installs)}`,
    }))
  );
}

function readDismissed(): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(DISMISSED_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((key) => typeof key === 'string') : []);
  } catch {
    return new Set();
  }
}

function joinNames(names: string[]): string {
  const shown = names.length > 3 ? [...names.slice(0, 2), `${names.length - 2} more`] : names;
  return new Intl.ListFormat('en', { type: 'conjunction' }).format(shown);
}

/**
 * Points at Settings when an installed notification integration, here or on an SSH host,
 * differs from what Komla installs now. Komla never applies these updates by itself.
 */
export function AgentIntegrationUpdateBanner() {
  // Null until the first check, so SSH results alone don't show the banner before it.
  const [localUpdates, setLocalUpdates] = useState<PendingUpdate[] | null>(null);
  const [cachedSshUpdates, setCachedSshUpdates] = useState<Record<string, SshIntegrationUpdates>>(
    {}
  );
  const [dismissed, setDismissed] = useState(readDismissed);
  const [checkDue, setCheckDue] = useState(false);
  const settingsOpen = useSettingsDialogStore((s) => s.open);
  const openSettings = useSettingsDialogStore((s) => s.openSettings);
  const sshHosts = useSshHostsStore((s) => s.hosts);

  useEffect(() => {
    const timer = setTimeout(() => setCheckDue(true), INTEGRATION_UPDATE_CHECK_DELAY_MS);
    const unsubscribe = window.api.onSshIntegrationUpdatesChange(setCachedSshUpdates);
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  // Checks again whenever Settings closes, where an update may have been applied. Each result
  // applies as it arrives: the local check can take seconds, and SSH results pushed meanwhile
  // are newer than the snapshot.
  useEffect(() => {
    if (!checkDue || settingsOpen) return;
    let cancelled = false;
    void window.api
      .getCachedSshIntegrationUpdates()
      .then((ssh) => {
        if (!cancelled) setCachedSshUpdates(ssh);
      })
      .catch(() => {});
    void loadLocalUpdates().then((local) => {
      if (!cancelled) setLocalUpdates(local);
    });
    return () => {
      cancelled = true;
    };
  }, [checkDue, settingsOpen]);

  const pending = localUpdates ? [...localUpdates, ...sshUpdates(cachedSshUpdates)] : [];
  const fresh = pending.filter((update) => !dismissed.has(update.key));
  const slot = useBannerSlot(
    'integration-update',
    BANNER_PRIORITY.integrationUpdate,
    fresh.length > 0
  );
  if (!slot.visible) return null;

  const hostName = (hostId: string) =>
    sshHosts.find((host) => host.id === hostId)?.name ?? 'an SSH host';
  const names = [
    ...new Set(
      fresh.map(({ agent, hostId }) =>
        hostId ? `${AGENT_LABELS[agent]} on ${hostName(hostId)}` : AGENT_LABELS[agent]
      )
    ),
  ];

  const dismiss = () => {
    // Earlier dismissals stay for SSH hosts not checked yet this session, up to a limit.
    const pendingKeys = new Set(pending.map((update) => update.key));
    const keys = [...[...dismissed].filter((key) => !pendingKeys.has(key)), ...pendingKeys].slice(
      -DISMISSED_KEY_LIMIT
    );
    try {
      localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify(keys));
    } catch {
      // Without storage the notice returns next launch.
    }
    setDismissed(new Set(keys));
  };

  return (
    <Banner
      tone="info"
      icon={<ArrowsClockwise className="size-4" />}
      title={`Komla's hooks for ${joinNames(names)} have an update.`}
      actions={
        <BannerAction onClick={() => openSettings({ tab: 'integrations' })}>
          Review update
        </BannerAction>
      }
      pager={slot.pager}
      onDismiss={dismiss}
      dismissLabel="Dismiss notification update notice"
    >
      — Apply it so agent status and alerts stay accurate.
    </Banner>
  );
}
