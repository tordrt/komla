export type CloneProtocol = 'ssh' | 'https';

// Hosts that serve `owner/repo` both as `git@host:` over SSH and as `https://host/`.
// A self-hosted server may use another SSH user or port, so its URLs clone as entered.
const KNOWN_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org']);

interface KnownRepo {
  host: string;
  repoPath: string;
  // An https username, like the one in Bitbucket's clone URLs, kept when cloning over HTTPS.
  httpsUser?: string;
}

function repoPathFor(host: string, path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  // GitLab allows nested groups and puts its pages after `/-/`; the others are owner/repo
  // followed by page paths such as `tree/main`.
  const end = host === 'gitlab.com' ? segments.indexOf('-') : 2;
  const repoSegments = segments.slice(0, end === -1 ? undefined : end);
  if (repoSegments.length < 2) return null;
  const last = repoSegments.length - 1;
  repoSegments[last] = repoSegments[last].replace(/\.git$/, '');
  return repoSegments[last] ? repoSegments.join('/') : null;
}

function parseKnownRepo(url: string): KnownRepo | null {
  // Lowercase schemes only, as the form's validation accepts.
  const https = url.match(/^https?:\/\/(?:([^@/?#]+)@)?([^/?#]+)([^?#]*)/);
  const ssh = https ? null : url.match(/^git@([^:/\s]+):([^?#\s]*)$/);
  const match = https ?? ssh;
  // A URL with a password or token in it clones as entered, so it isn't dropped or shown.
  if (!match || https?.[1]?.includes(':')) return null;
  const host = (https ? https[2] : match[1]).toLowerCase().replace(/^www\./, '');
  if (!KNOWN_HOSTS.has(host)) return null;
  const repoPath = repoPathFor(host, https ? https[3] : match[2]);
  if (!repoPath) return null;
  return { host, repoPath, httpsUser: https?.[1] };
}

function formatRepo(repo: KnownRepo, protocol: CloneProtocol): string {
  if (protocol === 'ssh') return `git@${repo.host}:${repo.repoPath}.git`;
  const user = repo.httpsUser ? `${repo.httpsUser}@` : '';
  return `https://${user}${repo.host}/${repo.repoPath}.git`;
}

export function urlProtocol(url: string): CloneProtocol | null {
  if (/^https?:\/\//.test(url)) return 'https';
  if (url.startsWith('git@')) return 'ssh';
  return null;
}

/**
 * The URL to clone for what was entered: a GitHub, GitLab or Bitbucket link, including one
 * copied from a browser page, becomes that repo's clone URL for the chosen protocol.
 */
export function cloneUrlFor(url: string, protocol: CloneProtocol): string {
  const trimmed = url.trim();
  const repo = parseKnownRepo(trimmed);
  return repo ? formatRepo(repo, protocol) : trimmed;
}

/** Rewrites the field's URL when the protocol is switched, for any host. */
export function switchCloneProtocol(url: string, protocol: CloneProtocol): string {
  const trimmed = url.trim();
  const repo = parseKnownRepo(trimmed);
  if (repo) return formatRepo(repo, protocol);
  if (protocol === 'ssh') {
    // A URL with a username or password in it is left alone.
    const match = trimmed.match(/^https?:\/\/([^/@]+)\/(.+?)(?:\.git)?$/);
    if (match) return `git@${match[1]}:${match[2]}.git`;
  } else {
    const match = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
    if (match) return `https://${match[1]}/${match[2]}.git`;
  }
  return trimmed;
}
