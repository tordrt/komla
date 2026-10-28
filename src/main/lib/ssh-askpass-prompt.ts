import { isAbsolute } from 'path';

// The exact prompt ssh shows while loading an encrypted private key.
const SSH_KEY_PASSPHRASE_PROMPT = /^Enter passphrase for key '([^\n]+)': ?$/;
// ssh cuts the key path in the prompt to 100 bytes.
const SSH_PROMPT_PATH_MAX_BYTES = 100;
// Windows paths that ssh-keygen can open start with a drive letter. MSYS builds of ssh,
// such as Git for Windows', print paths like /c/Users/me/.ssh/id_ed25519 instead.
const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const OPENSSH_VERSION = /OpenSSH_(?:for_Windows_)?(\d+)\.(\d+)/;

/**
 * The key file named in an ssh passphrase prompt, or null for any other prompt. Relative
 * paths (resolved from ssh's working directory), paths ssh may have cut short and MSYS
 * paths are null too, since Komla couldn't be sure to find the same file.
 */
export function sshKeyPathFromPrompt(prompt: string): string | null {
  const keyPath = SSH_KEY_PASSPHRASE_PROMPT.exec(prompt)?.[1];
  if (!keyPath || Buffer.byteLength(keyPath) >= SSH_PROMPT_PATH_MAX_BYTES) return null;
  const absolute =
    process.platform === 'win32' ? WINDOWS_DRIVE_PATH.test(keyPath) : isAbsolute(keyPath);
  return absolute ? keyPath : null;
}

/**
 * Whether `ssh -V` output belongs to OpenSSH 8.4 or later, which prefixes prompts that
 * come from the server (keyboard-interactive) with "(user@host) ". Older clients pass
 * them through unchanged, so a server could imitate a key passphrase prompt.
 */
export function opensshMarksServerPrompts(versionOutput: string): boolean {
  const match = OPENSSH_VERSION.exec(versionOutput);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 8 || (major === 8 && minor >= 4);
}
