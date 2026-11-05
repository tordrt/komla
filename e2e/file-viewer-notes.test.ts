import { test as base, expect, seedDefaultProject } from './electron-app';

const test = base.extend({
  seedSandbox: async ({ cleanSandbox: _cleanSandbox }, provide) => {
    seedDefaultProject({
      branchPrefix: 'viewer-notes/',
      initialFile: { name: 'server.ts', content: "import http from 'http';\n" },
    });
    await provide();
  },
});

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test('opens a note inside the full-screen file and diff viewer, leaving it open', async ({
  appWindow,
}) => {
  test.setTimeout(60_000);
  await appWindow.getByRole('button', { name: 'New Workspace' }).first().click();
  const createDialog = appWindow.getByRole('dialog', { name: 'Create Workspace' });
  await createDialog.locator('input[placeholder$="swift-fox"]').fill('viewer-notes/plan');
  await createDialog.getByRole('button', { name: /^(Launch|Create)/ }).click();
  const terminal = appWindow.locator('.xterm').filter({ visible: true }).first();
  await expect(terminal).toBeVisible({ timeout: 10_000 });
  // A change, for the diff view to show.
  await terminal.locator('.xterm-screen').click();
  await appWindow.keyboard.type(
    'echo "http.createServer().listen(3000);" >> server.ts && echo todo > other.txt'
  );
  await appWindow.keyboard.press('Enter');

  await appWindow.keyboard.press(`${mod}+Shift+E`);
  const viewer = appWindow.getByRole('dialog', { name: 'plan' });
  await expect(viewer).toBeVisible({ timeout: 10_000 });
  const file = viewer.getByRole('treeitem', { name: 'server.ts' });
  await file.click();
  const editor = viewer.locator('.monaco-editor').first();
  await expect(editor).toContainText('import http', { timeout: 10_000 });

  // A new note opens over the file, in the viewer.
  await appWindow.keyboard.press(`${mod}+Shift+M`);
  const note = viewer.locator('[contenteditable="true"]');
  await expect(note).toBeFocused({ timeout: 10_000 });
  await appWindow.keyboard.type('Plan for the server');
  const notes = viewer.getByRole('region', { name: 'Notes' });
  const noteRow = notes.getByRole('button', { name: /Plan for the server/ });
  await expect(noteRow).toBeVisible({ timeout: 10_000 });
  await expect(noteRow).toHaveAttribute('aria-current', 'true');

  // The file, back from the tree, as it was.
  await file.click();
  await expect(note).toBeHidden();
  await expect(editor).toBeVisible();
  await expect(editor).toContainText('import http');

  // And the note again, from its row, the viewer still open.
  await noteRow.click();
  await expect(note).toHaveText('Plan for the server');
  await expect(viewer).toBeVisible();

  // Escape goes back to the file too, giving its editor focus, rather than closing the viewer.
  await note.click();
  await appWindow.keyboard.press('Escape');
  await expect(note).toBeHidden();
  await expect(viewer).toBeVisible();
  await expect
    .poll(() => appWindow.evaluate(() => !!document.activeElement?.closest('.monaco-editor')))
    .toBe(true);

  // With unsaved edits, the file's own row goes straight back to it, edits kept.
  await appWindow.keyboard.press(`${mod}+End`);
  await appWindow.keyboard.type('\n// edited');
  await noteRow.click();
  await expect(note).toBeVisible();
  await file.click();
  await expect(note).toBeHidden();
  await expect(editor).toContainText('// edited');

  // Another file asks first, and Cancel keeps both the note and the edits.
  await noteRow.click();
  await viewer.getByRole('treeitem', { name: 'other.txt' }).click();
  const unsaved = appWindow.getByRole('dialog', { name: 'Unsaved Changes' });
  await unsaved.getByRole('button', { name: 'Cancel' }).click();
  await expect(note).toHaveText('Plan for the server');

  // Its close button goes back to the file, edits and all.
  await viewer.getByRole('button', { name: 'Close note' }).click();
  await expect(note).toBeHidden();
  await expect(editor).toContainText('// edited');
  await appWindow.keyboard.press(`${mod}+S`);

  // Switching to the diff view goes back to the file; a note opens over the diff too.
  await appWindow.keyboard.press(`${mod}+2`);
  await expect(note).toBeHidden();
  await viewer.getByRole('treeitem', { name: 'server.ts' }).click();
  await expect(viewer.locator('.monaco-diff-editor')).toBeVisible({ timeout: 10_000 });
  await noteRow.click();
  await expect(note).toHaveText('Plan for the server');
  await expect(viewer).toBeVisible();
  await appWindow.screenshot({ path: test.info().outputPath('note-over-diff.png') });

  // A second click on its row closes it, back to the diff.
  await noteRow.click();
  await expect(note).toBeHidden();
  await expect(viewer.locator('.monaco-diff-editor')).toBeVisible();

  // The toolbar's button opens the prompt draft, whose own button puts in the file on screen.
  // At its default size, not where an earlier run left it.
  await appWindow.evaluate(() => window.localStorage.removeItem('komla.promptDraftRect'));
  await viewer.getByRole('button', { name: 'Prompt draft' }).click();
  const draft = viewer.getByRole('dialog', { name: 'Prompt draft' });
  const prompt = draft.getByRole('textbox', { name: 'Prompt' });
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('');
  await expect(prompt).toHaveAttribute('placeholder', /^Draft a prompt/);
  await draft.getByRole('button', { name: 'Insert @path to server.ts' }).click();
  await expect(prompt).toHaveValue('@server.ts ');

  // It resizes from its left edge, the right one staying put.
  const before = (await draft.boundingBox())!;
  const left = draft.locator('[data-resize-edge="w"]');
  const grip = (await left.boundingBox())!;
  const at = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await appWindow.mouse.move(at.x, at.y);
  await appWindow.mouse.down();
  await appWindow.mouse.move(at.x - 120, at.y, { steps: 4 });
  await appWindow.mouse.up();
  const after = (await draft.boundingBox())!;
  expect(after.width).toBeCloseTo(before.width + 120, 0);
  expect(after.x + after.width).toBeCloseTo(before.x + before.width, 0);
  await appWindow.screenshot({ path: test.info().outputPath('prompt-draft-over-diff.png') });

  // Its edges leave the header's buttons alone, right up to their corners.
  const close = draft.getByRole('button', { name: 'Close' });
  const closeBox = (await close.boundingBox())!;
  await close.click({ position: { x: closeBox.width - 3, y: 3 } });
  await expect(draft).toBeHidden();
});
