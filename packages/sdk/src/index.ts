import { createKomlaClient, type KomlaClient, type KomlaTransport } from './client.js';
import { KomlaError } from './errors.js';
import { discoverKomla, type DiscoverOptions, type DiscoveredRoute } from './discovery.js';
import { httpTransport, type KomlaRoute } from './http.js';

import type { KomlaCapability } from './generated.js';

export * from './client.js';
export { discoverKomla, komlaDataDir } from './discovery.js';
export type { DiscoverOptions, DiscoveredRoute } from './discovery.js';
export { httpTransport } from './http.js';
export type { HttpTransportOptions, KomlaRoute } from './http.js';

export interface ConnectKomlaOptions<C extends KomlaCapability> extends DiscoverOptions {
  /** The capabilities the client uses beyond reading; see `createKomlaClient`. */
  capabilities?: readonly C[];
  /** Komla's route, in place of finding it as the CLI does. */
  route?: KomlaRoute;
  fetch?: typeof fetch;
}

/**
 * A client for the Komla that the `komla` CLI would reach from here, over its local HTTP server.
 * It finds Komla at the first call, again after Komla stopped answering (which helps when the port
 * file named it), and before each call from a managed terminal on an SSH host.
 */
export function connectKomla<const C extends KomlaCapability = never>(
  options: ConnectKomlaOptions<C> = {}
): KomlaClient<C> {
  const { capabilities, route, fetch, ...discovery } = options;
  // A hook's own notifications set off no hooks, so one can't set itself off again.
  const fromHook = Boolean((discovery.env ?? process.env).KOMLA_HOOK_ID?.trim());
  let found: Promise<DiscoveredRoute> | undefined;
  const currentRoute = async (): Promise<KomlaRoute> => {
    if (route) return route;
    const pending = found ?? discoverKomla(discovery);
    found = pending;
    try {
      const discovered = await pending;
      if (discovered.refresh) found = undefined;
      return discovered;
    } catch (error) {
      // Komla may start later.
      found = undefined;
      throw error;
    }
  };
  const http = httpTransport({ route: currentRoute, ...(fetch && { fetch }) });
  const transport: KomlaTransport = {
    send: async (request, callOptions) => {
      try {
        return await http.send(
          fromHook && request.type === 'workspace.notify' && request.source === undefined
            ? { ...request, source: 'hook' }
            : request,
          callOptions
        );
      } catch (error) {
        // Komla may have restarted on another port, which the port file names.
        if (error instanceof KomlaError && error.code === 'KOMLA_UNREACHABLE') found = undefined;
        throw error;
      }
    },
  };
  return createKomlaClient({ transport, ...(capabilities && { capabilities }) });
}
