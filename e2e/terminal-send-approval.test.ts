import fs from 'node:fs';
import path from 'node:path';

import { connectKomla } from '../packages/sdk/src/index';
import { getWorkspaceDisplayTitle } from '../src/shared/lib/workspace-title';
import { test as base, expect, SANDBOX_DIR, seedDefaultProject } from './electron-app';

// `komla send` types into a terminal and presses Enter, so Komla asks the user first: once per
// sender and terminal, through the same API the CLI uses (ADR 0008).
const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'send/' });
    await provide();
  },
});

test.describe('Allowing komla send', () => {
  test('asks before the first message, then lets later ones through', async ({ appWindow }) => {
    const created = await appWindow.evaluate(() =>
      window.api.createWorkspace({
        mode: 'worktree',
        projectId: 'e2e-project',
        branchName: 'send/shell',
        windowId: new URLSearchParams(window.location.search).get('windowId') ?? undefined,
      })
    );
    expect(created).not.toHaveProperty('__workspaceCreateError');
    const workspace = (created as { id: string }).id;
    const komla = connectKomla({
      env: { KOMLA_DATA_DIR: SANDBOX_DIR },
      cwd: SANDBOX_DIR,
      capabilities: ['terminal.read', 'terminal.send'],
    });
    const asking = appWindow.getByRole('heading', { name: 'Allow this message?' });

    // A call from outside any terminal can only name the shell of the workspace it targets.
    let terminal = '';
    await expect
      .poll(async () => {
        terminal = (await komla.terminal.list({}, { workspace })).terminals[0]?.id ?? '';
        if (!terminal) return false;
        return komla.terminal.read({ terminal }, { workspace }).then(
          () => true,
          () => false
        );
      })
      .toBe(true);

    // Declining types nothing, and the sender is told.
    const declined = komla.terminal.send({ terminal, text: 'echo first-message' }, { workspace });
    const refusal = expect(declined).rejects.toMatchObject({ code: 'TERMINAL_SEND_DECLINED' });
    await expect(asking).toBeVisible();
    await expect(appWindow.getByText('echo first-message', { exact: true })).toBeVisible();
    // It names the workspace it goes to, and no sender, since nothing in Komla sent it.
    await expect(appWindow.getByText('Workspace:', { exact: true })).toBeVisible();
    await expect(appWindow.getByText('A program outside Komla’s terminals')).toBeVisible();
    await expect(appWindow.getByText('From', { exact: true })).toHaveCount(0);
    await appWindow.screenshot({ path: test.info().outputPath('send-approval.png') });
    await appWindow.getByRole('button', { name: 'Cancel' }).click();
    await refusal;
    await expect(asking).toHaveCount(0);

    // Allowing it types it, and later messages from the same sender don't ask again.
    const second = komla.terminal.send({ terminal, text: 'echo second-message' }, { workspace });
    await expect(asking).toBeVisible();
    await appWindow.getByRole('button', { name: 'Send message' }).click();
    await expect(second).resolves.toMatchObject({ sent: true });
    await expect
      .poll(async () => (await komla.terminal.read({ terminal }, { workspace })).text)
      .toContain('second-message');

    await komla.terminal.send({ terminal, text: 'echo third-message' }, { workspace });
    await expect
      .poll(async () => (await komla.terminal.read({ terminal }, { workspace })).text)
      .toContain('third-message');
    await expect(asking).toHaveCount(0);
    // The declined message would have shown before the second one, which has.
    expect((await komla.terminal.read({ terminal }, { workspace })).text).not.toContain(
      'first-message'
    );
  });

  test('names the workspace it goes to when a terminal in another one sends it', async ({
    appWindow,
  }) => {
    const create = async (branchName: string) => {
      const created = await appWindow.evaluate(
        (branch) =>
          window.api.createWorkspace({
            mode: 'worktree',
            projectId: 'e2e-project',
            branchName: branch,
            windowId: new URLSearchParams(window.location.search).get('windowId') ?? undefined,
          }),
        branchName
      );
      expect(created).not.toHaveProperty('__workspaceCreateError');
      const id = (created as { id: string }).id;
      // Both would be titled Workspace, which tells them apart no better than the dialog does.
      await appWindow.evaluate(
        ([workspaceId, customName]) => window.api.updateWorkspace(workspaceId, { customName }),
        [id, `Title of ${branchName}`]
      );
      return id;
    };
    const lead = await create('send/lead');
    const review = await create('send/review');
    const reader = connectKomla({
      env: { KOMLA_DATA_DIR: SANDBOX_DIR },
      cwd: SANDBOX_DIR,
      capabilities: ['terminal.read'],
    });
    const terminalOf = async (workspace: string) => {
      let terminal = '';
      await expect
        .poll(async () => {
          terminal = (await reader.terminal.list({}, { workspace })).terminals[0]?.id ?? '';
          return terminal;
        })
        .not.toBe('');
      return terminal;
    };
    const [leadTerminal, reviewTerminal] = [await terminalOf(lead), await terminalOf(review)];
    const titleOf = async (id: string) =>
      getWorkspaceDisplayTitle(
        await appWindow.evaluate(
          async (workspaceId) =>
            (await window.api.getWorkspaces()).find((workspace) => workspace.id === workspaceId)!,
          id
        )
      );

    // The lead workspace's terminal sends to the review workspace's, as the CLI's `--workspace`
    // does: it names the workspace to act on, and its own terminal as the caller.
    const port = Number(fs.readFileSync(path.join(SANDBOX_DIR, 'port'), 'utf8').trim());
    const sending = fetch(`http://127.0.0.1:${port}/api/v1/commands`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Komla-Workspace-Id': review,
        'X-Komla-Target-Workspace-Id': review,
        'X-Komla-Terminal-Id': leadTerminal,
        'X-Komla-Caller-Terminal-Id': leadTerminal,
      },
      body: JSON.stringify({
        type: 'terminal.send',
        terminal: reviewTerminal,
        text: 'echo from-lead',
      }),
    });

    await expect(appWindow.getByRole('heading', { name: 'Allow this message?' })).toBeVisible();
    await expect(appWindow.getByText('An agent or program in another terminal')).toBeVisible();
    const goesTo = appWindow.getByText('Workspace:', { exact: true }).locator('..');
    await expect(goesTo).toContainText(await titleOf(review));
    await expect(goesTo).not.toContainText(await titleOf(lead));
    await appWindow.screenshot({ path: test.info().outputPath('send-approval-from-terminal.png') });
    await appWindow.getByRole('button', { name: 'Cancel' }).click();
    const response = await sending;
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'TERMINAL_SEND_DECLINED' } });
  });
});
