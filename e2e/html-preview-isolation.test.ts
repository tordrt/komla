import fs from 'fs';
import path from 'path';

import { test as base, expect, seedDefaultProject } from './electron-app';

import type { ElectronApplication, Page } from '@playwright/test';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({ branchPrefix: 'preview/' });
    await provide();
  },
});

// Reports whether the page's module script ran and what it read of the file beside it.
const PROBE_PAGE = `<!doctype html>
<script type="module" src="app.js"></script>
<script>
addEventListener('load', async () => {
  const sibling = await fetch('sibling.txt').then(
    (response) => (response.ok ? response.text() : 'blocked'),
    () => 'blocked'
  );
  parent.postMessage({ isolationProbe: { module: window.probeModule ?? 'failed', sibling } }, '*');
});
</script>`;

// Loads a script and fetches from an https: CDN, and fetches from a server on this computer.
const WEB_PAGE = `<!doctype html>
<script src="https://cdn.komla.test/lib.js"></script>
<script>
addEventListener('load', async () => {
  const attempt = (url) => fetch(url).catch(() => {});
  await Promise.all([attempt('https://cdn.komla.test/data.json'), attempt('http://127.0.0.1:9/api')]);
  parent.postMessage({ isolationProbe: 'done' }, '*');
});
</script>`;

/** Records, and cancels, every request the app makes to the probe pages' hosts. */
async function recordProbeRequests(
  electronApp: ElectronApplication
): Promise<() => Promise<string[]>> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const requests: string[] = [];
    (globalThis as { probeRequests?: string[] }).probeRequests = requests;
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes('/renderer/index.html')
    );
    window?.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const probed = /^https:\/\/cdn\.komla\.test\/|^http:\/\/127\.0\.0\.1:9\//.test(details.url);
      if (probed) requests.push(details.url);
      callback({ cancel: probed });
    });
  });
  return () =>
    electronApp.evaluate(() => (globalThis as { probeRequests?: string[] }).probeRequests ?? []);
}

function writeProbe(folder: string): string {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'index.html'), PROBE_PAGE);
  fs.writeFileSync(path.join(folder, 'app.js'), "window.probeModule = 'ran';");
  fs.writeFileSync(path.join(folder, 'sibling.txt'), 'sibling contents');
  return path.join(folder, 'index.html');
}

/** Opens a terminal link's page in a preview frame, as the file viewer does, and probes it. */
async function probeTerminalLink(
  appWindow: Page,
  ids: { workspaceId: string; terminalId: string },
  fullPath: string
): Promise<unknown> {
  return appWindow.evaluate(
    async ({ workspaceId, terminalId, fullPath }) => {
      const url = await window.api.getViewerPreviewUrl(workspaceId, terminalId, {
        kind: 'terminal',
        fullPath,
      });
      const frame = document.createElement('iframe');
      let onMessage: (event: MessageEvent) => void = () => {};
      try {
        return await new Promise<unknown>((resolve, reject) => {
          setTimeout(() => reject(new Error('The probe page never reported')), 10_000);
          onMessage = (event) => {
            const data = event.data as { isolationProbe?: unknown } | null;
            if (event.source === frame.contentWindow && data?.isolationProbe) {
              resolve(data.isolationProbe);
            }
          };
          addEventListener('message', onMessage);
          // As BrowserPreviewFrame sets it.
          frame.setAttribute('sandbox', 'allow-forms allow-scripts');
          frame.src = url;
          document.body.append(frame);
        });
      } finally {
        removeEventListener('message', onMessage);
        frame.remove();
      }
    },
    { ...ids, fullPath }
  );
}

/** A worktree workspace with a host shell terminal to open terminal links from. */
async function createPreviewTerminal(appWindow: Page) {
  const created = await appWindow.evaluate(() =>
    window.api.createWorkspace({
      mode: 'worktree',
      projectId: 'e2e-project',
      branchName: 'preview/isolation',
    })
  );
  expect(created).not.toHaveProperty('__workspaceCreateError');
  const { id: workspaceId, workingDirectory } = created as {
    id: string;
    workingDirectory: string;
  };
  await expect
    .poll(() =>
      appWindow.evaluate(
        async (id) =>
          (await window.api.getWorkspaces()).find((w) => w.id === id)?.provisioning ?? false,
        workspaceId
      )
    )
    .toBe(false);
  const terminal = await appWindow.evaluate(
    (id) => window.api.addTerminal(id, 'Preview terminal', null, 'tab', 'host-shell'),
    workspaceId
  );
  return { ids: { workspaceId, terminalId: terminal.id }, workingDirectory };
}

test.describe('HTML preview isolation', () => {
  test.describe.configure({ timeout: 90_000 });

  test('a page reads its own folder in a worktree, and only itself elsewhere', async ({
    appWindow,
  }) => {
    const { ids, workingDirectory } = await createPreviewTerminal(appWindow);

    // In a worktree, the page is served from its folder, so its module script and files load.
    const inWorktree = writeProbe(path.join(workingDirectory, 'site'));
    expect(await probeTerminalLink(appWindow, ids, inWorktree)).toEqual({
      module: 'ran',
      sibling: 'sibling contents',
    });

    // Playwright's output folder is outside the workspace, Komla's worktrees and the temp
    // folders, like ~/Downloads: the page is shown on its own and can't read what's beside it.
    const outside = writeProbe(test.info().outputPath('outside'));
    expect(await probeTerminalLink(appWindow, ids, outside)).toEqual({
      module: 'failed',
      sibling: 'blocked',
    });
  });

  test('a page loads from https: sites but not from servers on this computer', async ({
    appWindow,
    electronApp,
  }) => {
    const { ids, workingDirectory } = await createPreviewTerminal(appWindow);
    const requests = await recordProbeRequests(electronApp);
    const outside = test.info().outputPath('web');

    // In a worktree and shown on its own alike.
    for (const folder of [path.join(workingDirectory, 'web'), outside]) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'index.html'), WEB_PAGE);
      expect(await probeTerminalLink(appWindow, ids, path.join(folder, 'index.html'))).toBe('done');
    }
    expect(await requests()).toEqual([
      'https://cdn.komla.test/lib.js',
      'https://cdn.komla.test/data.json',
      'https://cdn.komla.test/lib.js',
      'https://cdn.komla.test/data.json',
    ]);
  });
});
