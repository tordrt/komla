import { exec, spawn } from 'child_process';
import { existsSync } from 'fs';

import { app, ipcMain, shell } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { detectWslDistros } from '../../lib/wsl';
import {
  shellOpenExternalArgsSchema,
  shellOpenInEditorArgsSchema,
  shellPathArgsSchema,
} from '../validation/config-ipc.schemas';
import { handleValidated } from '../validation/ipc-validators';

interface KnownEditor {
  id: string;
  name: string;
  macAppName?: string;
  linuxCmd?: string;
}

function isMacEditorInstalled(editor: KnownEditor): boolean {
  if (!editor.macAppName) return false;
  const paths = [
    `/Applications/${editor.macAppName}.app`,
    `${app.getPath('home')}/Applications/${editor.macAppName}.app`,
  ];
  return paths.some((p) => existsSync(p));
}

async function isCliEditorInstalled(editor: KnownEditor): Promise<boolean> {
  if (!editor.linuxCmd) return false;
  const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    await new Promise<void>((resolve, reject) => {
      exec(`${lookupCmd} ${editor.linuxCmd}`, (err) => (err ? reject(err) : resolve()));
    });
    return true;
  } catch {
    return false;
  }
}

export function registerShellHandlers(): void {
  // Shell handlers
  ipcMain.handle(
    IPC.SHELL_OPEN_EXTERNAL,
    handleValidated(
      IPC.SHELL_OPEN_EXTERNAL,
      shellOpenExternalArgsSchema,
      async (_, [url]): Promise<void> => {
        await shell.openExternal(url);
      }
    )
  );

  ipcMain.handle(
    IPC.SHELL_SHOW_ITEM_IN_FOLDER,
    handleValidated(IPC.SHELL_SHOW_ITEM_IN_FOLDER, shellPathArgsSchema, (_, [fullPath]): void => {
      shell.showItemInFolder(fullPath);
    })
  );

  ipcMain.handle(
    IPC.SHELL_OPEN_PATH,
    handleValidated(
      IPC.SHELL_OPEN_PATH,
      shellPathArgsSchema,
      async (_, [fullPath]): Promise<void> => {
        // shell.openPath resolves with an error message string (empty on
        // success) rather than rejecting — surface it as a thrown error so
        // the renderer can react.
        const error = await shell.openPath(fullPath);
        if (error) throw new Error(error);
      }
    )
  );

  // External editor handlers
  const knownEditors: KnownEditor[] = [
    { id: 'vscode', name: 'VS Code', macAppName: 'Visual Studio Code', linuxCmd: 'code' },
    { id: 'cursor', name: 'Cursor', macAppName: 'Cursor', linuxCmd: 'cursor' },
    { id: 'windsurf', name: 'Windsurf', macAppName: 'Windsurf', linuxCmd: 'windsurf' },
    { id: 'zed', name: 'Zed', macAppName: 'Zed', linuxCmd: 'zed' },
    { id: 'webstorm', name: 'WebStorm', macAppName: 'WebStorm', linuxCmd: 'webstorm' },
    { id: 'intellij', name: 'IntelliJ IDEA', macAppName: 'IntelliJ IDEA', linuxCmd: 'idea' },
    { id: 'pycharm', name: 'PyCharm', macAppName: 'PyCharm', linuxCmd: 'pycharm' },
    { id: 'goland', name: 'GoLand', macAppName: 'GoLand', linuxCmd: 'goland' },
    { id: 'rubymine', name: 'RubyMine', macAppName: 'RubyMine', linuxCmd: 'rubymine' },
    { id: 'phpstorm', name: 'PhpStorm', macAppName: 'PhpStorm', linuxCmd: 'phpstorm' },
    { id: 'clion', name: 'CLion', macAppName: 'CLion', linuxCmd: 'clion' },
    { id: 'rider', name: 'Rider', macAppName: 'Rider', linuxCmd: 'rider' },
    { id: 'sublime', name: 'Sublime Text', macAppName: 'Sublime Text', linuxCmd: 'subl' },
    { id: 'xcode', name: 'Xcode', macAppName: 'Xcode' },
  ];

  let cachedEditors: { id: string; name: string }[] | null = null;

  ipcMain.handle(
    IPC.SHELL_GET_AVAILABLE_EDITORS,
    async (): Promise<{ id: string; name: string }[]> => {
      if (cachedEditors) return cachedEditors;

      const isDarwin = process.platform === 'darwin';
      const available: { id: string; name: string }[] = [];
      for (const editor of knownEditors) {
        const installed = isDarwin
          ? isMacEditorInstalled(editor)
          : await isCliEditorInstalled(editor);
        if (installed) available.push({ id: editor.id, name: editor.name });
      }

      cachedEditors = available;
      return available;
    }
  );

  ipcMain.handle(
    IPC.SHELL_OPEN_IN_EDITOR,
    handleValidated(
      IPC.SHELL_OPEN_IN_EDITOR,
      shellOpenInEditorArgsSchema,
      async (_, [editorId, dirPath]): Promise<void> => {
        const editor = knownEditors.find((e) => e.id === editorId);
        if (!editor) throw new Error(`Unknown editor: ${editorId}`);

        if (process.platform === 'darwin' && editor.macAppName) {
          spawn('open', ['-a', editor.macAppName, dirPath], { detached: true, stdio: 'ignore' });
        } else if (editor.linuxCmd) {
          spawn(editor.linuxCmd, [dirPath], { detached: true, stdio: 'ignore' });
        }
      }
    )
  );

  // WSL distro detection (Windows only)
  ipcMain.handle(IPC.SHELL_GET_WSL_DISTROS, async (): Promise<string[]> => {
    return detectWslDistros();
  });
}
