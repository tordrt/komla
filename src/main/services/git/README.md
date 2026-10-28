# Git Service Modules

The git service is split into focused modules. All modules export singletons and are re-composed into a single `gitService` facade in `index.ts` for backward compatibility.

## Modules

| Module                  | Responsibility                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git-exec.ts`           | Shared execution (`execGitAsync`, `execGitWithProgress`), result cache, target branch registry, and commonly-used queries (`getCurrentBranch`, `hasUncommittedChanges`, `getMainBranch`, `getAheadBehind`, etc.) |
| `git-branch.ts`         | Branch CRUD, merge, rebase, push, pull, fetch, quick status, PR/branch URL generation                                                                                                                            |
| `git-branch-cleanup.ts` | Leftover branches, here or in an SSH host's clone: which landed in the target, deleting them                                                                                                                     |
| `git-diff.ts`           | Diff computation, file change parsing, working tree stats, binary detection                                                                                                                                      |
| `git-commit.ts`         | Commit-scope inspection, AI draft input construction, explicit stage-all, and commit execution                                                                                                                   |
| `git-repo.ts`           | Clone (bare/regular/remote), init, remote management, file CRUD, discard changes, URL validation                                                                                                                 |
| `git-history.ts`        | Commit log, per-commit diff, per-commit file diff                                                                                                                                                                |
| `git-worktree.ts`       | Worktree create, delete, list; fast-forwarding a branch no worktree has checked out                                                                                                                              |
| `index.ts`              | `GitService` facade class that delegates to all sub-services; re-exports all types                                                                                                                               |

## Dependencies

```
git-exec  (standalone — no internal deps)
  ↑
  ├── git-worktree
  ├── git-diff
  ├── git-history
  ├── git-repo
  ├── git-branch  (git-repo lazily for web URLs)
  └── git-branch-cleanup  (runs through a GitBatchRunner; workspace-git/ssh-git has the SSH one)
```

## Adding new methods

1. Add the implementation to the appropriate module
2. Add a delegating method in `index.ts` → `GitService` class
3. The method is automatically available via `gitService.yourMethod()` everywhere
