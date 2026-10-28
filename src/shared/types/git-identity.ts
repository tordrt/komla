export interface GitIdentityStatus {
  /** git can resolve an author and committer, so commits won't fail for lack of one */
  canCommit: boolean;
  /** Values already in the global git config, for prefilling a prompt */
  userName?: string;
  userEmail?: string;
}
