import { z } from 'zod';

import { validateGitIdentity } from '../../../shared/lib/git-identity';

import {
  fileStatusSchema,
  idSchema,
  nonEmptyStringSchema,
  safePathSchema,
  untrimmedSafePathSchema,
} from './primitives';

const contentSearchOptionsSchema = z
  .object({
    caseSensitive: z.boolean().optional(),
    regex: z.boolean().optional(),
    maxResults: z.number().int().positive().optional(),
    maxFileSize: z
      .string()
      .regex(/^\d+[KMG]?$/i)
      .optional(),
  })
  .strip();

export const getDirectoryInfoArgsSchema = z.tuple([safePathSchema]);
export const repoPathArgsSchema = z.tuple([safePathSchema]);
export const worktreePathArgsSchema = z.tuple([safePathSchema]);
export const inspectCommitScopeArgsSchema = z.tuple([safePathSchema]);
const commitScopeSchema = z.enum(['staged', 'all']);
export const generateCommitDraftArgsSchema = z.tuple([
  safePathSchema,
  commitScopeSchema.optional(),
]);
export const commitChangesArgsSchema = z.tuple([
  safePathSchema,
  z
    .object({
      subject: nonEmptyStringSchema,
      body: z.string().nullable().optional(),
      scope: commitScopeSchema,
    })
    .strict(),
]);
export const diffAgainstBranchArgsSchema = z.tuple([
  safePathSchema,
  nonEmptyStringSchema,
  z.boolean().default(false),
]);
export const fileDiffContentArgsSchema = z.tuple([safePathSchema, safePathSchema, z.boolean()]);
export const fileDiffAgainstBranchArgsSchema = z.tuple([
  safePathSchema,
  safePathSchema,
  nonEmptyStringSchema,
  z.boolean().default(false),
]);
export const workspaceDiffArgsSchema = z.tuple([idSchema]);
export const workspaceDiffAgainstBranchArgsSchema = z.tuple([
  idSchema,
  nonEmptyStringSchema,
  z.boolean().default(false),
]);
export const workspaceFileDiffContentArgsSchema = z.tuple([idSchema, safePathSchema, z.boolean()]);
export const workspaceFileDiffAgainstBranchArgsSchema = z.tuple([
  idSchema,
  safePathSchema,
  nonEmptyStringSchema,
  z.boolean().default(false),
]);
export const workspaceListFilesArgsSchema = z.tuple([idSchema, z.boolean().optional()]);
export const workspaceReadFileArgsSchema = z.tuple([idSchema, untrimmedSafePathSchema]);
export const workspaceWriteFileArgsSchema = z.tuple([
  idSchema,
  untrimmedSafePathSchema,
  z.string(),
]);
export const workspaceDeletePathArgsSchema = z.tuple([idSchema, untrimmedSafePathSchema]);
export const workspaceImportExternalFileArgsSchema = z.tuple([
  idSchema,
  z
    .string()
    .max(4096)
    .refine((value) => !value.includes('\0'), { message: 'must not contain null bytes' })
    .refine((value) => value.trim().length > 0, { message: 'path must not be empty' }),
  safePathSchema.optional(),
  z.enum(['workspace', 'local-mirror']).optional(),
]);
const terminalSourcePathSchema = z
  .string()
  .max(4096)
  // A terminal can print a path in its user's home folder as ~/.
  .refine((value) => value.startsWith('/') || value.startsWith('~/'), {
    message: 'must be an absolute POSIX path or start with ~/',
  })
  .refine((value) => !value.includes('\0'), { message: 'must not contain null bytes' });
const viewerFileSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), filePath: untrimmedSafePathSchema }).strict(),
  z.object({ kind: z.literal('terminal'), fullPath: terminalSourcePathSchema }).strict(),
]);
export const workspaceViewerFileArgsSchema = z.tuple([
  idSchema,
  // The terminal that printed a terminal file's path; a workspace file needs none.
  idSchema.nullable(),
  viewerFileSourceSchema,
]);
export const workspaceViewerPreviewUrlArgsSchema = z.tuple([
  idSchema,
  idSchema.nullable(),
  viewerFileSourceSchema,
  z.object({ replacesPrevious: z.boolean().optional() }).strict().optional(),
]);
export const workspaceBranchStatusArgsSchema = z.tuple([idSchema, idSchema.optional()]);
export const workspaceListBranchesArgsSchema = z.tuple([idSchema, z.boolean().optional()]);
// Hashes and refs land in git's arguments and in remote shells, so they're held to what git
// itself allows: a full or abbreviated hash, and a ref name that can't read as an option.
const commitHashSchema = z.string().regex(/^[0-9a-f]{4,64}$/i, 'must be a commit hash');
const refNameSchema = z
  .string()
  .max(256)
  // oxlint-disable-next-line no-control-regex -- git refuses control characters in ref names
  .regex(/^[^-\s~^:?*[\\\x00-\x1f\x7f][^\s~^:?*[\\\x00-\x1f\x7f]*$/, 'must be a ref name');
export const workspacePullRequestStatusArgsSchema = z.tuple([idSchema]);
export const workspaceCommitGraphArgsSchema = z.tuple([
  idSchema,
  z
    .object({
      limit: z.number().int().positive().max(500),
      skip: z.number().int().nonnegative().max(1_000_000).optional(),
      ref: refNameSchema.optional(),
      path: untrimmedSafePathSchema.optional(),
    })
    .strict(),
]);
export const workspaceCommitDiffArgsSchema = z.tuple([idSchema, commitHashSchema]);
export const workspaceCommitFileDiffArgsSchema = z.tuple([
  idSchema,
  commitHashSchema,
  untrimmedSafePathSchema,
]);
export const workspaceFetchRemoteArgsSchema = z.tuple([idSchema]);
export const workspaceMergeFromArgsSchema = z.tuple([
  idSchema,
  nonEmptyStringSchema,
  z.object({ stash: z.boolean().optional() }).strict().optional(),
]);
export const workspaceRebaseOnBranchArgsSchema = workspaceMergeFromArgsSchema;
export const workspacePushPullArgsSchema = z.tuple([idSchema]);
export const workspaceTargetBranchActionArgsSchema = z.tuple([idSchema]);
export const workspaceRestoreFileArgsSchema = z.tuple([
  idSchema,
  safePathSchema,
  fileStatusSchema,
  safePathSchema.optional(),
]);
export const workspaceDiscardAllChangesArgsSchema = z.tuple([idSchema]);
export const workspaceInspectCommitScopeArgsSchema = z.tuple([idSchema]);
export const workspaceGenerateCommitDraftArgsSchema = z.tuple([idSchema]);
export const workspaceCommitChangesArgsSchema = z.tuple([
  idSchema,
  z
    .object({
      subject: nonEmptyStringSchema,
      body: z.string().nullable().optional(),
      scope: commitScopeSchema,
    })
    .strict(),
]);
export const workspaceCreateBranchArgsSchema = z.tuple([
  idSchema,
  nonEmptyStringSchema,
  nonEmptyStringSchema.optional(),
]);
export const workspaceSwitchBranchArgsSchema = z.tuple([idSchema, nonEmptyStringSchema]);
export const branchStatusArgsSchema = z.tuple([safePathSchema, idSchema.optional()]);
export const rebaseOnTargetBranchArgsSchema = z.tuple([
  safePathSchema,
  z.object({ stash: z.boolean().optional() }).strict().optional(),
]);
export const mergeFromArgsSchema = z.tuple([safePathSchema, nonEmptyStringSchema]);
const stashOptionsSchema = z.object({ stash: z.boolean().optional() }).strict().optional();
export const mergeFromWithStashArgsSchema = z.tuple([
  safePathSchema,
  nonEmptyStringSchema,
  stashOptionsSchema,
]);
export const rebaseOnBranchArgsSchema = z.tuple([
  safePathSchema,
  nonEmptyStringSchema,
  stashOptionsSchema,
]);
export const listBranchesArgsSchema = z.tuple([safePathSchema, z.boolean().optional()]);

export const deleteBranchArgsSchema = z.tuple([
  safePathSchema,
  nonEmptyStringSchema,
  z.boolean().optional(),
]);

export const fileExistsArgsSchema = z.tuple([safePathSchema, safePathSchema]);
export const getFileMetadataArgsSchema = z.tuple([safePathSchema, safePathSchema]);
export const copyFileArgsSchema = z.tuple([safePathSchema, safePathSchema, safePathSchema]);
export const copyDirectoryArgsSchema = z.tuple([safePathSchema, safePathSchema, safePathSchema]);
export const importExternalFileArgsSchema = z.tuple([
  safePathSchema,
  safePathSchema,
  safePathSchema.optional(),
]);
export const deleteFileArgsSchema = z.tuple([safePathSchema, safePathSchema, fileStatusSchema]);
export const renameFileArgsSchema = z.tuple([safePathSchema, safePathSchema, safePathSchema]);
export const createDirectoryArgsSchema = z.tuple([safePathSchema, safePathSchema]);
export const writeFileArgsSchema = z.tuple([safePathSchema, safePathSchema, z.string()]);
export const listFilesArgsSchema = z.tuple([safePathSchema, z.boolean().optional()]);
export const readFileArgsSchema = z.tuple([safePathSchema, safePathSchema]);
export const htmlPreviewUrlArgsSchema = z.tuple([
  safePathSchema,
  safePathSchema,
  z
    .string()
    .max(5 * 1024 * 1024)
    .optional(),
]);
export const restoreFileArgsSchema = z.tuple([
  safePathSchema,
  safePathSchema,
  fileStatusSchema,
  safePathSchema.optional(),
]);

export const validateRemoteUrlArgsSchema = z.tuple([nonEmptyStringSchema]);
export const addRemoteArgsSchema = z.tuple([safePathSchema, nonEmptyStringSchema]);
export const createGithubRepoArgsSchema = z.tuple([
  safePathSchema,
  nonEmptyStringSchema,
  z.boolean(),
]);
export const pushProjectBranchesArgsSchema = z.tuple([
  idSchema,
  z.array(idSchema.refine((branch) => !branch.startsWith('-'))).max(16),
]);
export const getGitIdentityArgsSchema = z.tuple([]);
export const setGitIdentityArgsSchema = z
  .tuple([nonEmptyStringSchema, nonEmptyStringSchema])
  .refine(([userName, userEmail]) => validateGitIdentity(userName, userEmail) === null, {
    message: 'Invalid git name or email',
  });

export const managedRepoFetchArgsSchema = z.tuple([idSchema]);
export const managedRepoPushPullStatusArgsSchema = z.tuple([idSchema, nonEmptyStringSchema]);

export const projectSyncRefreshArgsSchema = z.tuple([idSchema, z.boolean().optional()]);

export const workspaceSearchContentArgsSchema = z.tuple([
  idSchema,
  nonEmptyStringSchema,
  contentSearchOptionsSchema.optional(),
]);

export const blameArgsSchema = z.tuple([
  safePathSchema,
  safePathSchema,
  nonEmptyStringSchema.optional(),
]);

export const refreshGitStatusArgsSchema = z.tuple([idSchema]);
export const getWorkspaceObservationsArgsSchema = z.tuple([]);
