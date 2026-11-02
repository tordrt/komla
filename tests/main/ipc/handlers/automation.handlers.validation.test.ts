import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockElectron } from '../../../mocks/electron';

const electronMock = mockElectron();
vi.mock('electron', () => electronMock);

const automationService = {
  list: vi.fn(),
  save: vi.fn(),
  setEnabled: vi.fn(),
  delete: vi.fn(),
  runNow: vi.fn(),
};
const previewAutomationCommand = vi.fn();
vi.mock('../../../../src/main/services/automation.service', () => ({
  automationService,
  previewAutomationCommand,
}));

const params = {
  name: 'Nightly deps',
  prompt: 'Update dependencies',
  projectId: 'project-1',
  target: { kind: 'ssh', hostId: 'host-1' },
  schedule: { cron: '0 9 * * 1-5', timeZone: 'Europe/Oslo' },
  enabled: true,
  missedRunGraceMinutes: 720,
};

async function handler(channel: string) {
  const { registerAutomationHandlers } =
    await import('../../../../src/main/ipc/handlers/automation.handlers');
  registerAutomationHandlers();
  return electronMock.ipcMain._getHandler(channel);
}

describe('automation IPC validation', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('passes a valid automation to the service', async () => {
    automationService.save.mockResolvedValue({ id: 'a' });
    const save = await handler('automation:save');

    await expect(save?.({}, params)).resolves.toEqual({ id: 'a' });
    expect(automationService.save).toHaveBeenCalledWith(params);
  });

  it('passes the branch an automation starts from', async () => {
    const save = await handler('automation:save');

    await save?.({}, { ...params, startBranch: 'release/1.x' });
    expect(automationService.save).toHaveBeenCalledWith({ ...params, startBranch: 'release/1.x' });
  });

  it.each([
    ['an unknown target', { ...params, target: { kind: 'cloud' } }],
    ['a missing project', { ...params, projectId: '  ' }],
    ['a negative grace', { ...params, missedRunGraceMinutes: -1 }],
    ['an unknown field', { ...params, command: 'rm -rf /' }],
    ['an empty schedule', { ...params, schedule: { cron: '', timeZone: 'UTC' } }],
    ['a start branch that is an option', { ...params, startBranch: '--upload-pack=x' }],
    ['a start branch with revision syntax', { ...params, startBranch: 'main@{1}' }],
    ['extra arguments on two lines', { ...params, extraArguments: '-v\nrm -rf ~' }],
    ['a reasoning level that is no id', { ...params, reasoningLevelId: '  ' }],
  ])('rejects %s', async (_label, invalid) => {
    const save = await handler('automation:save');

    await expect(Promise.resolve().then(() => save?.({}, invalid))).rejects.toMatchObject({
      code: 'IPC_VALIDATION_ERROR',
    });
    expect(automationService.save).not.toHaveBeenCalled();
  });

  it('passes the reasoning level and extra arguments', async () => {
    const save = await handler('automation:save');
    const tuned = { ...params, reasoningLevelId: 'high', extraArguments: '--model opus' };

    await save?.({}, tuned);
    expect(automationService.save).toHaveBeenCalledWith(tuned);
  });

  it('previews the command of a valid agent choice only', async () => {
    previewAutomationCommand.mockReturnValue({ command: 'claude <prompt>' });
    const preview = await handler('automation:preview-command');
    const choice = { target: { kind: 'local' }, presetId: 'claude', extraArguments: '-v' };

    await expect(preview?.({}, choice)).resolves.toEqual({ command: 'claude <prompt>' });
    expect(previewAutomationCommand).toHaveBeenCalledWith(choice);
    await expect(
      Promise.resolve().then(() => preview?.({}, { ...choice, extraArguments: 'a\rb' }))
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
    await expect(
      Promise.resolve().then(() => preview?.({}, { ...choice, prompt: 'x' }))
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
  });

  it('runs an automation on its target', async () => {
    automationService.runNow.mockResolvedValue({ status: 'started' });
    const runNow = await handler('automation:run-now');

    await runNow?.({}, { kind: 'local' }, 'nightly');
    expect(automationService.runNow).toHaveBeenCalledWith({ kind: 'local' }, 'nightly');
    await expect(
      Promise.resolve().then(() => runNow?.({}, { kind: 'ssh' }, 'nightly'))
    ).rejects.toMatchObject({ code: 'IPC_VALIDATION_ERROR' });
  });
});
