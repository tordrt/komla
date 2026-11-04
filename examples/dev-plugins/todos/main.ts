// The TODOs plugin's code: finds the repository's TODOs where a workspace opened the panel, posts
// them to its page. It looks again as files change.
import type { KomlaPlugin } from '@komla/sdk/plugin';

const PANEL = 'todos';
const watched = new Set<string>();
const settling = new Map<string, ReturnType<typeof setTimeout>>();

interface Todo {
  file: string;
  line: number;
  text: string;
}

export function activate(komla: KomlaPlugin) {
  const refresh = async (workspace: string) => {
    const words = String(komla.settings.get('words') || 'TODO|FIXME').replace(/'/g, '');
    try {
      const out = await komla.exec(
        `git grep -n -I -E '\\b(${words})\\b' -- . ':!*.min.*' ':!*.lock' ':!package-lock.json' | head -300 || true`,
        { workspace, timeoutSeconds: 30 }
      );
      const todos: Todo[] = out
        .split('\n')
        .map((row) => /^(.*?):(\d+):(.*)$/.exec(row))
        .filter((match): match is RegExpExecArray => match !== null)
        .map(([, file, line, text]) => ({ file, line: Number(line), text: text.trim() }));
      komla.panels.post(PANEL, { todos, words }, { workspace });
    } catch (error) {
      komla.panels.post(PANEL, error instanceof Error ? error.message : String(error), {
        workspace,
      });
    }
  };

  komla.panels.onOpen(PANEL, ({ workspace }) => {
    watched.add(workspace);
    void refresh(workspace);
  });
  komla.panels.onMessage(PANEL, async (message, { workspace }) => {
    if ((message as { type?: unknown })?.type !== 'refresh') throw new Error('Unknown message');
    await refresh(workspace);
    return 'refreshed';
  });
  for (const type of ['working-tree.changed', 'branch.changed', 'agent.done'] as const) {
    komla.on(type, ({ workspaceId }) => {
      if (!watched.has(workspaceId)) return;
      clearTimeout(settling.get(workspaceId));
      settling.set(
        workspaceId,
        setTimeout(() => void refresh(workspaceId), 1500)
      );
    });
  }
  komla.on('workspace.trashed', ({ workspaceId }) => watched.delete(workspaceId));
  komla.settings.onChange(() => {
    for (const workspace of watched) void refresh(workspace);
  });
}
