// The Pull requests plugin's code. Komla runs it in a process of its own while the plugin is on.
// It asks GitHub once for each repository, however many workspaces show it, and gives each
// workspace's panel the pull requests and a badge with how many wait on the user's review. It asks
// again every three minutes, and soon after a workspace's branch changes or an agent finishes there.
import type { KomlaPlugin } from '@komla/sdk/plugin';

const PANEL = 'prs';
const EVERY_MS = 3 * 60_000;
const SETTLE_MS = 5_000;

// Trims the checks down to what the page shows, so the output stays small.
const QUERY = [
  "me=$(gh api user --jq '.login|tojson')",
  'repo=$(gh repo view --json nameWithOwner,url)',
  'prs=$(gh pr list --state open --limit 60 --json number,title,url,author,headRefName,baseRefName,isDraft,reviewDecision,reviewRequests,statusCheckRollup,mergeable,updatedAt,additions,deletions --jq \'map(.statusCheckRollup |= map({name: (.name // .context), state: (if (.conclusion // "") != "" then .conclusion elif .state then .state else .status end), url: (.detailsUrl // .targetUrl)}))\')',
  'printf \'{"me":%s,"repo":%s,"prs":%s}\' "$me" "$repo" "$prs"',
].join(' && ');

interface PullRequests {
  me: string;
  repo: { nameWithOwner: string; url: string };
  prs: { author?: { login: string }; reviewRequests?: { login?: string }[]; isDraft?: boolean }[];
}

/** The workspaces whose panel opened, by the repository they show, as their project. */
const watched = new Map<string, Set<string>>();
const repoOf = new Map<string, string>();
const settling = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Map<string, Promise<void>>();

function waitingOnMe({ me, prs }: PullRequests): number {
  return prs.filter(
    (pr) =>
      pr.author?.login !== me && (pr.reviewRequests ?? []).some((request) => request.login === me)
  ).length;
}

export function activate(komla: KomlaPlugin) {
  /** Asks GitHub for a repository's pull requests where one of its workspaces is. */
  const refresh = (repo: string): Promise<void> => {
    const already = running.get(repo);
    if (already) return already;
    const workspaces = [...(watched.get(repo) ?? [])];
    if (workspaces.length === 0) return Promise.resolve();
    const run = (async () => {
      try {
        const data = JSON.parse(
          await komla.exec(QUERY, { workspace: workspaces[0], timeoutSeconds: 60 })
        ) as PullRequests;
        // As the user set it in Settings → Plugins.
        if (komla.settings.get('hide_drafts') === true) {
          data.prs = data.prs.filter((pr) => !pr.isDraft);
        }
        const waiting = waitingOnMe(data);
        for (const workspace of workspaces) {
          komla.panels.post(PANEL, data, { workspace });
          komla.panels.setBadge(PANEL, waiting && { text: waiting, tone: 'warning' }, { workspace });
        }
      } catch (error) {
        // The page shows what went wrong, such as gh missing or signed out, with what to do.
        const message = error instanceof Error ? error.message : String(error);
        for (const workspace of workspaces) komla.panels.post(PANEL, message, { workspace });
      }
    })().finally(() => running.delete(repo));
    running.set(repo, run);
    return run;
  };

  const watch = async (workspace: string): Promise<string> => {
    let repo = repoOf.get(workspace);
    if (!repo) {
      const { workspaces } = await komla.workspace.list();
      repo = workspaces.find((each) => each.id === workspace)?.project?.id ?? workspace;
      repoOf.set(workspace, repo);
    }
    const workspaces = watched.get(repo) ?? new Set();
    workspaces.add(workspace);
    watched.set(repo, workspaces);
    return repo;
  };

  komla.panels.onOpen(PANEL, ({ workspace }) => {
    void watch(workspace).then(refresh);
  });

  // The page's refresh button.
  komla.panels.onMessage(PANEL, async (message, { workspace }) => {
    if ((message as { type?: unknown })?.type !== 'refresh') throw new Error('Unknown message');
    await refresh(await watch(workspace));
    return 'refreshed';
  });

  // A push or an agent's work can change the pull requests; a burst of events asks once.
  for (const type of ['branch.changed', 'agent.done', 'workspace.trashed'] as const) {
    komla.on(type, ({ workspaceId }) => {
      const repo = repoOf.get(workspaceId);
      if (!repo) return;
      if (type === 'workspace.trashed') {
        watched.get(repo)?.delete(workspaceId);
        repoOf.delete(workspaceId);
        return;
      }
      clearTimeout(settling.get(repo));
      settling.set(
        repo,
        setTimeout(() => {
          settling.delete(repo);
          void refresh(repo);
        }, SETTLE_MS)
      );
    });
  }

  const refreshAll = () => {
    for (const repo of watched.keys()) void refresh(repo);
  };
  setInterval(refreshAll, EVERY_MS);
  komla.settings.onChange(refreshAll);
}
