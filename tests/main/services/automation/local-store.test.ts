/* eslint-disable import/order -- Vitest's hoisted mocks must precede service imports. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

vi.mock('electron', () => mockElectron());

import { LocalAutomationStore } from '../../../../src/main/services/automation/local-store';
import { MAX_AUTOMATION_RUNS } from '../../../../src/shared/types/automation';

import type { Automation } from '../../../../src/shared/types/automation';

const automation: Automation = {
  id: 'nightly',
  name: 'Nightly deps',
  prompt: 'Update dependencies',
  projectId: 'project-1',
  target: { kind: 'local' },
  schedule: { cron: '0 9 * * *', timeZone: 'UTC' },
  enabled: true,
  missedRunGraceMinutes: 720,
  createdAt: 1,
  updatedAt: 1,
};

describe('LocalAutomationStore', () => {
  let directory: string | undefined;
  const path = () => {
    directory ??= mkdtempSync(join(tmpdir(), 'komla-automations-'));
    return join(directory, 'automations.json');
  };

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it('keeps automations and their newest runs across restarts', async () => {
    const store = new LocalAutomationStore(path());
    await store.saveAutomation(automation);
    for (let index = 0; index < MAX_AUTOMATION_RUNS + 5; index += 1) {
      await store.addRun({
        id: `run-${index}`,
        automationId: 'nightly',
        trigger: 'schedule',
        scheduledFor: index,
        startedAt: index,
        status: 'started',
      });
    }

    const reloaded = new LocalAutomationStore(path()).read();
    expect(reloaded.automations).toEqual([automation]);
    expect(reloaded.runs.nightly).toHaveLength(MAX_AUTOMATION_RUNS);
    expect(reloaded.runs.nightly?.[0]?.id).toBe(`run-${MAX_AUTOMATION_RUNS + 4}`);
  });

  it('forgets an automation’s runs with it', async () => {
    const store = new LocalAutomationStore(path());
    await store.saveAutomation(automation);
    await store.addRun({
      id: 'run',
      automationId: 'nightly',
      trigger: 'manual',
      startedAt: 1,
      status: 'started',
    });
    await store.deleteAutomation('nightly');

    expect(JSON.parse(readFileSync(path(), 'utf8'))).toEqual({
      version: 1,
      automations: [],
      runs: {},
    });
  });

  it('keeps the newest scheduled run past the limit, so its time isn’t started again', async () => {
    const store = new LocalAutomationStore(path());
    await store.saveAutomation(automation);
    await store.addRun({
      id: 'scheduled',
      automationId: 'nightly',
      trigger: 'schedule',
      scheduledFor: 5,
      startedAt: 5,
      status: 'started',
    });
    for (let index = 0; index < MAX_AUTOMATION_RUNS + 5; index += 1) {
      await store.addRun({
        id: `manual-${index}`,
        automationId: 'nightly',
        trigger: 'manual',
        startedAt: 10 + index,
        status: 'started',
      });
    }

    const runs = new LocalAutomationStore(path()).read().runs.nightly ?? [];
    expect(runs).toHaveLength(MAX_AUTOMATION_RUNS + 1);
    expect(runs[0]?.id).toBe(`manual-${MAX_AUTOMATION_RUNS + 4}`);
    expect(runs.at(-1)?.id).toBe('scheduled');
  });

  it('drops a run of an automation deleted while it was starting', async () => {
    const store = new LocalAutomationStore(path());

    await store.addRun({
      id: 'run',
      automationId: 'deleted',
      trigger: 'schedule',
      scheduledFor: 1,
      startedAt: 1,
      status: 'started',
    });

    expect(store.read().runs).toEqual({});
  });

  it('skips entries it cannot read', () => {
    writeFileSync(
      path(),
      JSON.stringify({ version: 1, automations: [automation, { id: 'broken' }], runs: {} })
    );
    expect(new LocalAutomationStore(path()).read().automations).toEqual([automation]);
  });

  it('leaves a file it can’t read as it is, and says why', async () => {
    writeFileSync(path(), '{not json');
    const broken = new LocalAutomationStore(path());
    expect(broken.read()).toMatchObject({
      automations: [],
      runs: {},
      error: expect.stringContaining("Couldn't read"),
    });
    await expect(broken.saveAutomation(automation)).rejects.toThrow("Couldn't read");
    expect(readFileSync(path(), 'utf8')).toBe('{not json');

    const newer = JSON.stringify({ version: 2, automations: [{ id: 'future' }], runs: {} });
    writeFileSync(path(), newer);
    const downgraded = new LocalAutomationStore(path());
    expect(downgraded.read().error).toContain('newer version of Komla');
    await expect(downgraded.saveAutomation(automation)).rejects.toThrow('newer version');
    expect(readFileSync(path(), 'utf8')).toBe(newer);
  });
});
