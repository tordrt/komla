import { randomInt } from 'crypto';

const WORKSPACE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const WORKSPACE_ID_LETTERS = 26;
const WORKSPACE_ID_LENGTH = 10;

// People copy workspace ids into scripts and `komla --workspace`, so they're short and in one
// case; ten of these characters keep two of one user's workspaces from ever sharing one. With
// no dash, an id never reads as a flag, and its leading letter keeps JSON or YAML written by
// hand from reading it as a number. Workspaces made before keep their UUIDs. As
// random_workspace_id in the komla CLI's native/src/offline_workspace.rs.
export function createWorkspaceId(): string {
  let id = WORKSPACE_ID_ALPHABET[randomInt(WORKSPACE_ID_LETTERS)];
  while (id.length < WORKSPACE_ID_LENGTH) {
    id += WORKSPACE_ID_ALPHABET[randomInt(WORKSPACE_ID_ALPHABET.length)];
  }
  return id;
}
