import { useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import type { SshConfigHost, SshHost } from '@/types';

/** `user@hostname:port` and any jump host, as far as the Host block says. */
export function sshConfigHostSummary(host: SshConfigHost): string | null {
  if (!host.hostname && !host.user && !host.port && !host.proxyJump) return null;
  const address = `${host.user ? `${host.user}@` : ''}${host.hostname ?? host.alias}${
    host.port ? `:${host.port}` : ''
  }`;
  return host.proxyJump ? `${address} via ${host.proxyJump}` : address;
}

/**
 * Lowercased aliases whose machine Komla already has a host for. A host saved as an alias
 * connects with that entry's settings, its own user and port taking precedence, as in ssh.
 */
export function addedConfigAliases(entries: SshConfigHost[] | null, hosts: SshHost[]): Set<string> {
  if (!entries) return new Set();
  const byAlias = new Map(entries.map((entry) => [entry.alias.toLowerCase(), entry]));
  const saved = new Set(
    hosts.map((host) => {
      const entry = byAlias.get(host.hostname.toLowerCase());
      return connectionKey(
        entry?.hostname ?? host.hostname,
        host.user ?? entry?.user,
        host.port ?? entry?.port
      );
    })
  );
  return new Set(
    entries
      .filter((entry) =>
        saved.has(connectionKey(entry.hostname ?? entry.alias, entry.user, entry.port))
      )
      .map((entry) => entry.alias.toLowerCase())
  );
}

const connectionKey = (hostname: string, user: string | undefined, port: number | undefined) =>
  `${user ?? ''}@${hostname.toLowerCase()}:${port ?? 22}`;

interface SshConfigHostPickerProps {
  /** Null while ~/.ssh/config is read. */
  hosts: SshConfigHost[] | null;
  error: string | null;
  /** Lowercased aliases Komla already has a host for. */
  addedAliases: Set<string>;
  onPick: (host: SshConfigHost) => void;
  onBack: () => void;
}

/** Lists the Host entries in ~/.ssh/config, so one can fill in a new SSH host. */
export function SshConfigHostPicker({
  hosts,
  error,
  addedAliases,
  onPick,
  onBack,
}: SshConfigHostPickerProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = (hosts ?? []).filter(
    (host) =>
      !needle ||
      [host.alias, host.hostname, host.user].some((value) => value?.toLowerCase().includes(needle))
  );
  const isAdded = (host: SshConfigHost) => addedAliases.has(host.alias.toLowerCase());

  return (
    <>
      <DialogHeader>
        <DialogTitle>Choose from ~/.ssh/config</DialogTitle>
        <DialogDescription>
          Pick a host to fill in the form. Komla connects through its alias, so the rest of its
          settings in the file still apply.
        </DialogDescription>
      </DialogHeader>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const first = matches.find((host) => !isAdded(host));
          if (first) onPick(first);
        }}
        placeholder="Filter hosts…"
        aria-label="Filter hosts"
        autoFocus
      />
      <DialogBody className="min-h-40">
        <div className="rounded-lg border">
          {error ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">{error}</p>
          ) : hosts === null ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              Reading ~/.ssh/config…
            </p>
          ) : matches.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-muted-foreground">
              <p className="font-medium text-foreground">
                {hosts.length === 0 ? 'No hosts in ~/.ssh/config' : 'No matching hosts'}
              </p>
              <p className="mt-1 text-xs">
                {hosts.length === 0
                  ? 'Add a Host entry there, or go back and type the details.'
                  : 'Try another filter, or go back and type the details.'}
              </p>
            </div>
          ) : (
            <ul aria-label="Hosts in ~/.ssh/config" className="divide-y divide-border/60">
              {matches.map((host) => {
                const summary = sshConfigHostSummary(host);
                const added = isAdded(host);
                return (
                  <li key={host.alias}>
                    <button
                      type="button"
                      disabled={added}
                      onClick={() => onPick(host)}
                      className={cn(
                        'flex w-full items-center justify-between gap-3 px-3 py-2 text-left',
                        'hover:bg-foreground/5 focus-visible:bg-foreground/5 focus-visible:outline-hidden',
                        'disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent'
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{host.alias}</span>
                        {summary && (
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {summary}
                          </span>
                        )}
                      </span>
                      {added && (
                        <Badge size="sm" tone="success" className="shrink-0">
                          Added
                        </Badge>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onBack}>
          Back
        </Button>
      </DialogFooter>
    </>
  );
}
