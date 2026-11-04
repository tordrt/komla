// The Focus timer's code: one timer for every workspace, kept here rather than in the page, so it
// runs on while the panel is closed and every window shows the same one. It keeps the timer in a
// file outside the plugin's folder, which the status item's command reads and which brings the
// timer back when the plugin starts again.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import type { KomlaPlugin } from '@komla/sdk/plugin';

const PANEL = 'focus';
const STATUS_ITEM = 'focus.clock';
const FILE = join(homedir(), '.cache', 'komla-focus-timer');

type Timer =
  | { state: 'idle' }
  | { state: 'running'; endsAt: number }
  | { state: 'paused'; left: number }
  | { state: 'done'; at: number };

const seconds = () => Math.floor(Date.now() / 1000);

/** The timer the file holds, as the status item reads it: `<state> <time>`. */
function load(): Timer {
  try {
    const [state, value] = readFileSync(FILE, 'utf8').trim().split(/\s+/);
    const time = Number(value);
    if (!Number.isFinite(time)) return { state: 'idle' };
    if (state === 'running')
      return time > seconds() ? { state, endsAt: time } : { state: 'done', at: time };
    if (state === 'paused') return { state, left: time };
    if (state === 'done') return { state, at: time };
  } catch {
    // No timer yet.
  }
  return { state: 'idle' };
}

function save(timer: Timer): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const line =
    timer.state === 'running'
      ? `running ${timer.endsAt}`
      : timer.state === 'paused'
        ? `paused ${timer.left}`
        : timer.state === 'done'
          ? `done ${timer.at}`
          : 'idle 0';
  writeFileSync(FILE, `${line}\n`);
}

export function activate(komla: KomlaPlugin) {
  let timer = load();
  /** The workspace that last started the timer, which hears when it's up. */
  let startedIn: string | undefined;

  const length = () => {
    const minutes = Number(komla.settings.get('minutes'));
    return Math.round((Number.isFinite(minutes) && minutes > 0 ? minutes : 25) * 60);
  };
  const left = () =>
    timer.state === 'running'
      ? Math.max(0, timer.endsAt - seconds())
      : timer.state === 'paused'
        ? timer.left
        : timer.state === 'done'
          ? 0
          : length();

  /** Tells every window: the pages, and the status item at once, not at its interval. */
  const changed = async () => {
    save(timer);
    komla.panels.post(PANEL, { ...timer, left: left(), length: length() });
    const { workspaces } = await komla.workspace.list();
    await Promise.allSettled(
      workspaces.map((workspace) =>
        komla.status.refresh({ id: STATUS_ITEM }, { workspace: workspace.id })
      )
    );
  };

  setInterval(() => {
    if (timer.state !== 'running') return;
    if (timer.endsAt <= seconds()) {
      timer = { state: 'done', at: seconds() };
      void changed();
      if (startedIn) {
        void komla.workspace
          .notify({ title: 'Focus time is up', kind: 'turn-complete' }, { workspace: startedIn })
          .catch(() => {});
      }
    }
  }, 1000);

  komla.panels.onMessage(PANEL, async (message, { workspace }) => {
    const type = (message as { type?: unknown })?.type;
    if (type === 'start') {
      timer = {
        state: 'running',
        endsAt: seconds() + (timer.state === 'paused' ? timer.left : length()),
      };
      startedIn = workspace;
    } else if (type === 'pause' && timer.state === 'running') {
      timer = { state: 'paused', left: left() };
    } else if (type === 'reset') {
      timer = { state: 'idle' };
    } else if (type !== 'get') {
      throw new Error('Unknown message');
    }
    await changed();
    return { ...timer, left: left(), length: length() };
  });

  komla.settings.onChange(() => void changed());
  void changed();
}
