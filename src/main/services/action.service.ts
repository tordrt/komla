import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { BrowserWindow } from 'electron';

import {
  buildCustomizePrompt,
  SUGGEST_STATUS_ITEMS,
} from '../../shared/constants/customize-prompt';
import { IPC } from '../../shared/constants/ipc-channels';
import { buildProjectSetupPrompt } from '../../shared/constants/project-setup-prompt';
import { moveItem } from '../../shared/lib/move-item';
import { writeFileAtomicSync } from '../lib/atomic-write';
import { migrate } from '../lib/migration';

import { FileWatcher } from './file-watcher';
import { getKomlaBasePath } from './paths';

import type { Action, ActionSshExecutionLocation } from '../../shared/types';

type ActionUsageTracker = (type: 'prompt' | 'command') => void;

let registeredUsageTracker: ActionUsageTracker | null = null;

/** Register the telemetry callback at app boot without creating a service import cycle. */
export function registerActionUsageTracker(tracker: ActionUsageTracker): void {
  registeredUsageTracker = tracker;
}

const ACTIONS_VERSION = 1;
const ACTIONS_MIGRATIONS: Record<
  number,
  (data: Record<string, unknown>) => Record<string, unknown>
> = {};

interface ActionsConfig {
  _version?: number;
  actions: Action[];
}

interface CreateActionParams {
  title: string;
  content: string;
  type?: 'prompt' | 'command';
  projectIds?: string[];
  presetId?: string;
  launchModeId?: string;
  sshExecutionLocation?: ActionSshExecutionLocation;
  background?: boolean;
}

interface UpdateActionParams {
  title?: string;
  content?: string;
  type?: 'prompt' | 'command';
  projectIds?: string[];
  presetId?: string | null;
  launchModeId?: string | null;
  sshExecutionLocation?: ActionSshExecutionLocation | null;
  background?: boolean | null;
}

function stripUtf8Bom(data: string): string {
  return data.charCodeAt(0) === 0xfeff ? data.slice(1) : data;
}

function buildBuiltinActions(): Array<{ title: string; content: string }> {
  // First, so a new user's run button starts on it.
  return [
    {
      title: 'Set up project in Komla',
      content: buildProjectSetupPrompt(),
    },
    {
      title: 'Customize Komla',
      content: buildCustomizePrompt(SUGGEST_STATUS_ITEMS),
    },
    {
      title: 'Review current branch',
      content: `# Review changes diverging from {{target_branch}}

You are a senior engineer performing a focused code review.

## What to review

Only review commits unique to this branch and any uncommitted changes — not the full difference between the two branches. Ignore files that are pure renames or moves with no logic changes.

\`\`\`bash
git log {{target_branch}}..HEAD --oneline
git diff --stat {{target_branch}}...HEAD
git diff {{target_branch}}...HEAD
git diff
\`\`\`

## Review checklist

**Correctness:**
- Bugs, regressions, and risky assumptions?
- Edge cases handled?
- Proper error handling?

**Security:**
- Injection risks, credential exposure, unsafe data handling?

**Architecture:**
- Clean separation of concerns?
- Sound design decisions?
- Performance implications?

**Testing:**
- Tests actually test logic (not just mocks)?
- Missing or insufficient tests for changed code?
- Edge cases covered?

Do not flag style issues unless they obscure meaning.

## Output format

### Strengths
[What's well done — be specific with file:line references.]

### Issues

#### Critical (must fix)
[Bugs, security issues, data loss risks, broken functionality]

#### Important (should fix)
[Architecture problems, missing error handling, test gaps]

#### Minor (nice to have)
[Optimization opportunities, naming, documentation]

**For each issue:**
- File and line reference
- What's wrong
- Why it matters
- Concrete fix (if not obvious)

### Assessment

**Ready to merge?** [Yes / No / With fixes]

**Reasoning:** [1-2 sentence technical assessment]

## Rules

- Base findings on diffs, commits, and test results only
- Categorize by actual severity — not everything is critical
- If the diff is large, focus on the riskiest files first and note which files you prioritized
- If nothing significant is found, say so — don't invent issues`,
    },
    {
      title: 'Create PR draft with gh',
      content: `# Create a pull request targeting {{target_branch}}

Use \`gh pr create\` to create the PR.

## Steps

1. Check if a PR already exists for this branch (\`gh pr list --head <branch>\`). If so, report it and stop.
2. Review commits and diffs unique to this branch (use three-dot diff: \`git diff {{target_branch}}...HEAD\` and \`git log {{target_branch}}..HEAD\`)
3. Write a PR title in imperative mood, under 72 characters (e.g., "Add user search endpoint")
4. Write a PR body with these sections:
   - **Summary** — 1-3 bullet points covering what changed and why
   - **Key changes** — file-level highlights of the most important modifications
   - **Testing** — what was tested and how (test output, manual verification)
   - **Breaking changes** — if any, otherwise omit this section
5. Push the branch if needed and run \`gh pr create --draft\` to create a draft PR.
6. Return the PR URL so the user can review and publish it on GitHub.`,
    },
  ];
}

function createDefaultActions(): Action[] {
  return buildBuiltinActions().map((action) => ({
    id: randomUUID(),
    title: action.title,
    content: action.content,
  }));
}

function createDefaultActionsConfig(): ActionsConfig {
  return {
    actions: createDefaultActions(),
  };
}

export class ActionService {
  private settingsPath: string;
  private actionsPath: string;
  private defaultsPath: string;
  private defaultActionsPath: string;
  private watcher: FileWatcher | null = null;
  private actions: Map<string, Action> = new Map();
  private initialized = false;
  private selfWriteRevision: string | null = null;

  constructor() {
    this.settingsPath = join(getKomlaBasePath(), 'settings');
    this.actionsPath = join(this.settingsPath, 'actions.json');
    this.defaultsPath = join(this.settingsPath, 'defaults');
    this.defaultActionsPath = join(this.defaultsPath, 'actions.json');

    this.ensureSettingsDirectory();
    this.loadConfig();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.startWatcher();
  }

  private ensureSettingsDirectory(): void {
    if (!existsSync(this.settingsPath)) {
      mkdirSync(this.settingsPath, { recursive: true });
    }

    if (!existsSync(this.defaultsPath)) {
      mkdirSync(this.defaultsPath, { recursive: true });
    }

    if (!existsSync(this.defaultActionsPath)) {
      writeFileSync(
        this.defaultActionsPath,
        JSON.stringify(createDefaultActionsConfig(), null, 2),
        'utf-8'
      );
    }

    if (!existsSync(this.actionsPath)) {
      writeFileSync(
        this.actionsPath,
        JSON.stringify(createDefaultActionsConfig(), null, 2),
        'utf-8'
      );
    }
  }

  private loadConfig(): void {
    try {
      if (existsSync(this.actionsPath)) {
        const data = readFileSync(this.actionsPath, 'utf-8');
        const config = migrate(
          JSON.parse(stripUtf8Bom(data)) as Record<string, unknown>,
          ACTIONS_VERSION,
          ACTIONS_MIGRATIONS
        ) as unknown as ActionsConfig;
        this.actions.clear();
        for (const action of config.actions ?? []) {
          this.actions.set(action.id, action);
        }
        return;
      }
    } catch (error) {
      console.error('Failed to load actions config:', error);
    }

    const fallback = createDefaultActionsConfig();
    this.actions.clear();
    for (const action of fallback.actions) {
      this.actions.set(action.id, action);
    }
  }

  private saveConfig(): void {
    try {
      const config: ActionsConfig = {
        _version: ACTIONS_VERSION,
        actions: this.list(),
      };
      writeFileAtomicSync(this.actionsPath, JSON.stringify(config, null, 2));
    } catch (error) {
      console.error('Failed to save actions config:', error);
    }
  }

  private async startWatcher(): Promise<void> {
    this.watcher = new FileWatcher(this.actionsPath, () => {
      let revision: string;
      try {
        revision = this.getStorageRevision();
      } catch (error) {
        console.error('Failed to read actions revision:', error);
        return;
      }
      if (revision === this.selfWriteRevision) {
        this.selfWriteRevision = null;
        return;
      }
      this.loadConfig();
      this.notifyRenderer();
    });
    await this.watcher.start();
  }

  private notifyRenderer(): void {
    const actions = this.list();
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC.ACTIONS_CHANGED, actions);
      }
    }
  }

  get(id: string): Action | undefined {
    return this.actions.get(id);
  }

  list(): Action[] {
    return Array.from(this.actions.values());
  }

  getStorageRevision(): string {
    const contents = readFileSync(this.actionsPath, 'utf-8');
    return createHash('sha256').update(contents).digest('hex');
  }

  getStorageRevisionState():
    | { status: 'current'; revision: string }
    | { status: 'changed' | 'unreadable' } {
    try {
      const contents = readFileSync(this.actionsPath, 'utf-8');
      const config = migrate(
        JSON.parse(stripUtf8Bom(contents)) as Record<string, unknown>,
        ACTIONS_VERSION,
        ACTIONS_MIGRATIONS
      ) as unknown as ActionsConfig;
      if (JSON.stringify(config.actions ?? []) !== JSON.stringify(this.list())) {
        return { status: 'changed' };
      }
      return {
        status: 'current',
        revision: createHash('sha256').update(contents).digest('hex'),
      };
    } catch {
      return { status: 'unreadable' };
    }
  }

  replaceAll(expectedRevision: string, actions: Action[]): string {
    if (this.getStorageRevision() !== expectedRevision) {
      throw new Error('Actions revision changed');
    }

    const previous = this.actions;
    const replacement = new Map(actions.map((action) => [action.id, action]));
    const config: ActionsConfig = { _version: ACTIONS_VERSION, actions };
    this.actions = replacement;
    try {
      writeFileAtomicSync(this.actionsPath, JSON.stringify(config, null, 2), undefined, () => {
        if (this.getStorageRevision() !== expectedRevision) {
          throw new Error('Actions revision changed');
        }
      });
    } catch (error) {
      this.actions = previous;
      throw error;
    }

    const revision = this.getStorageRevision();
    this.selfWriteRevision = revision;
    this.notifyRenderer();
    return revision;
  }

  reorder(id: string, newOrder: number): void {
    const actions = this.list();
    const sourceIndex = actions.findIndex((action) => action.id === id);
    if (sourceIndex < 0) {
      throw new Error(`Action with id "${id}" not found`);
    }

    const reordered = moveItem(actions, sourceIndex, newOrder);
    if (reordered === actions) return;

    this.actions.clear();
    for (const action of reordered) {
      this.actions.set(action.id, action);
    }
    this.saveConfig();
    this.notifyRenderer();
  }

  create(params: CreateActionParams): Action {
    const action: Action = {
      id: randomUUID(),
      title: params.title,
      content: params.content,
      ...(params.type ? { type: params.type } : {}),
      ...(params.projectIds?.length ? { projectIds: params.projectIds } : {}),
      ...(params.presetId ? { presetId: params.presetId } : {}),
      ...(params.presetId && params.launchModeId ? { launchModeId: params.launchModeId } : {}),
      ...(params.type === 'command' && params.sshExecutionLocation
        ? { sshExecutionLocation: params.sshExecutionLocation }
        : {}),
      ...(params.type === 'command' && params.background ? { background: true } : {}),
    };
    this.actions.set(action.id, action);
    this.saveConfig();
    this.notifyRenderer();
    return action;
  }

  update(id: string, updates: UpdateActionParams): Action {
    const action = this.actions.get(id);
    if (!action) {
      throw new Error(`Action with id "${id}" not found`);
    }

    // null clears a field: the old value stays here and the checks below drop it.
    const assigned = Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== null)
    ) as { [K in keyof UpdateActionParams]?: Exclude<UpdateActionParams[K], null> };
    const updated: Action = {
      ...action,
      ...assigned,
    };
    // Clean up empty/default fields so they don't persist in JSON
    if (!updated.projectIds?.length) {
      delete updated.projectIds;
    }
    if (!updated.type || updated.type === 'prompt') {
      delete updated.type;
    }
    // Handle null clearing for preset fields
    if (updates.presetId === null || !updated.presetId) {
      delete updated.presetId;
      delete updated.launchModeId; // launchModeId is meaningless without presetId
    }
    if (updates.launchModeId === null || !updated.launchModeId) {
      delete updated.launchModeId;
    }
    if (
      updates.sshExecutionLocation === null ||
      !updated.sshExecutionLocation ||
      updated.type !== 'command'
    ) {
      delete updated.sshExecutionLocation;
    }
    if (updates.background === null || !updated.background || updated.type !== 'command') {
      delete updated.background;
    }
    this.actions.set(id, updated);
    this.saveConfig();
    this.notifyRenderer();
    return updated;
  }

  /**
   * A pasted prompt keeps its last use as it was: the most recently used Action stands in for
   * the run button's default, and pasting into a terminal doesn't pick that.
   */
  recordUsage(id: string, userInput?: string, pasted = false): Action {
    const action = this.actions.get(id);
    if (!action) {
      throw new Error(`Action with id "${id}" not found`);
    }

    const updated: Action = {
      ...action,
      ...(pasted ? {} : { lastUsedAt: Date.now() }),
      ...(userInput?.trim() ? { lastUserInput: userInput.trim() } : {}),
    };
    this.actions.set(id, updated);
    this.saveConfig();
    this.notifyRenderer();
    registeredUsageTracker?.(updated.type ?? 'prompt');
    return updated;
  }

  delete(id: string): void {
    if (!this.actions.has(id)) {
      throw new Error(`Action with id "${id}" not found`);
    }

    this.actions.delete(id);
    this.saveConfig();
    this.notifyRenderer();
  }

  clearPresetReferences(presetId: string): void {
    let changed = false;
    for (const action of this.actions.values()) {
      if (action.presetId === presetId) {
        delete action.presetId;
        delete action.launchModeId;
        changed = true;
      }
    }
    if (changed) {
      this.saveConfig();
      this.notifyRenderer();
    }
  }

  clearLaunchModeReferences(presetId: string, launchModeIds: string[]): void {
    let changed = false;
    for (const action of this.actions.values()) {
      if (
        action.presetId === presetId &&
        action.launchModeId &&
        launchModeIds.includes(action.launchModeId)
      ) {
        delete action.launchModeId;
        changed = true;
      }
    }
    if (changed) {
      this.saveConfig();
      this.notifyRenderer();
    }
  }

  async dispose(): Promise<void> {
    if (this.watcher) {
      await this.watcher.stop();
      this.watcher = null;
    }
  }
}

export const actionService = new ActionService();
