import { beforeEach, describe, expect, it, vi } from 'vitest';

const popup = vi.fn();
const buildFromTemplate = vi.fn((_template: Electron.MenuItemConstructorOptions[]) => ({ popup }));

vi.mock('electron', () => ({
  Menu: { buildFromTemplate },
}));

const { attachEditContextMenu } = await import('../../../src/main/lib/edit-context-menu');

type ContextMenuListener = (event: unknown, params: Partial<Electron.ContextMenuParams>) => void;

const ALL_ENABLED = {
  canUndo: true,
  canRedo: true,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canSelectAll: true,
};

function openMenu(params: Partial<Electron.ContextMenuParams>) {
  let listener: ContextMenuListener | undefined;
  const window = {
    webContents: {
      on: vi.fn((_event: string, callback: ContextMenuListener) => {
        listener = callback;
      }),
    },
  } as unknown as Electron.BrowserWindow;
  attachEditContextMenu(window);
  expect(window.webContents.on).toHaveBeenCalledWith('context-menu', expect.any(Function));
  listener?.({}, params);
  return window;
}

describe('attachEditContextMenu', () => {
  beforeEach(() => {
    popup.mockClear();
    buildFromTemplate.mockClear();
  });

  it('pops up the edit commands over a text field', () => {
    const window = openMenu({
      isEditable: true,
      editFlags: ALL_ENABLED as Electron.EditFlags,
    });

    expect(popup).toHaveBeenCalledWith({ window });
    const template = buildFromTemplate.mock.calls[0]?.[0] ?? [];
    expect(template.map((item) => item.role ?? item.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'selectAll',
    ]);
    expect(template.filter((item) => item.role).every((item) => item.enabled)).toBe(true);
  });

  it('disables what the field says it can not do', () => {
    openMenu({
      isEditable: true,
      editFlags: { ...ALL_ENABLED, canCut: false, canCopy: false } as Electron.EditFlags,
    });

    const template = buildFromTemplate.mock.calls[0]?.[0] ?? [];
    const enabled = Object.fromEntries(template.map((item) => [item.role, item.enabled]));
    expect(enabled).toMatchObject({ cut: false, copy: false, paste: true });
  });

  it('pops up nothing outside a text field', () => {
    openMenu({ isEditable: false, editFlags: ALL_ENABLED as Electron.EditFlags });

    expect(popup).not.toHaveBeenCalled();
  });
});
