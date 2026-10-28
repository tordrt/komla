import { sshWorkspaceService } from '../ssh-workspace.service';
import { workspaceService } from '../workspace.service';

import { buildRemoteFetchCommand, fetchPageLocally, parseRemoteFetch } from './fetch-page';
import { createLinkPreviewService } from './link-preview.service';

export { createLinkPreviewService } from './link-preview.service';
export type { LinkPreviewService, LinkPreviewServiceDeps } from './link-preview.service';

// Covers the SSH round trip on top of curl's own limit.
const REMOTE_EXTRA_MS = 5_000;

export const linkPreviewService = createLinkPreviewService({
  fetchLocally: fetchPageLocally,
  fetchOnSshHost: async (workspaceId, url, options) => {
    const backend = workspaceService.get(workspaceId)?.backend;
    if (backend?.kind !== 'ssh') return null;
    try {
      const output = await sshWorkspaceService.run(
        sshWorkspaceService.getHost(backend.hostId),
        buildRemoteFetchCommand(url, options),
        { purpose: { kind: 'interactive' }, timeout: options.timeoutMs + REMOTE_EXTRA_MS }
      );
      return parseRemoteFetch(output, url);
    } catch {
      return null;
    }
  },
});
