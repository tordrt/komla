/**
 * A loose identity for recognizing one repository behind different remote URLs,
 * e.g. on two devices: `git@github.com:acme/app.git`, `https://github.com/acme/app`
 * and `ssh://git@github.com/acme/app.git` all yield `github.com/acme/app`.
 * Transport, user and port are ignored. Only use it to match projects; deciding
 * whether two remotes may share an SSH host's bare clone needs the stricter check
 * in the remote setup script.
 */
export function gitRemoteIdentity(url: string): string {
  const value = url.trim().replace(/\/+$/, '');
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)\/?(.*)$/i.exec(value);
  // Like git, scp-style `[user@]host:path` has no slash before the colon and is not a drive letter.
  const scp = scheme || /^[a-z]:[\\/]/i.test(value) ? null : /^([^/:]+):(.*)$/.exec(value);
  const parts = scheme && scheme[1].toLowerCase() !== 'file' ? scheme.slice(2) : scp?.slice(1);
  if (!parts) return value;
  const [authority = '', path = ''] = parts;
  const host = authority
    .slice(authority.lastIndexOf('@') + 1)
    .replace(/:\d*$/, '')
    .toLowerCase();
  return `${host}/${path
    .replace(/^\/+/, '')
    .replace(/\.git$/i, '')
    .toLowerCase()}`;
}
