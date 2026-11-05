import { spawn } from 'child_process';
import { existsSync } from 'fs';

import { app, shell } from 'electron';

import { IPC } from '../../../shared/constants/ipc-channels';
import { findOnPath } from '../../lib/find-on-path';
import { detectWslDistros } from '../../lib/wsl';
import { handleIpc } from '../validation/ipc-validators';

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

export function registerShellHandlers(): void {
  // Shell handlers
  handleIpc(IPC.SHELL_OPEN_EXTERNAL, async (_, [url]): Promise<void> => {
    await shell.openExternal(url);
  });

  handleIpc(IPC.SHELL_SHOW_ITEM_IN_FOLDER, (_, [fullPath]): void => {
    shell.showItemInFolder(fullPath);
  });

  handleIpc(IPC.SHELL_OPEN_PATH, async (_, [fullPath]): Promise<void> => {
    // shell.openPath resolves with an error message string (empty on
    // success) rather than rejecting — surface it as a thrown error so
    // the renderer can react.
    const error = await shell.openPath(fullPath);
    if (error) throw new Error(error);
  });

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

  handleIpc(IPC.SHELL_GET_AVAILABLE_EDITORS, async (): Promise<{ id: string; name: string }[]> => {
    if (cachedEditors) return cachedEditors;

    // Off macOS, an editor counts when its command is on PATH, as `which` or `where` would
    // find it. Looked up here rather than by running them: Komla asks at launch, and starting a
    // process for each editor kept the main process busy then.
    const onPath =
      process.platform === 'darwin'
        ? new Set<string>()
        : findOnPath(
            knownEditors.flatMap((editor) => (editor.linuxCmd ? [editor.linuxCmd] : [])),
            process.env.PATH ?? '',
            { pathExt: process.env.PATHEXT }
          );
    const available = knownEditors
      .filter((editor) =>
        process.platform === 'darwin'
          ? isMacEditorInstalled(editor)
          : editor.linuxCmd !== undefined && onPath.has(editor.linuxCmd)
      )
      .map((editor) => ({ id: editor.id, name: editor.name }));

    cachedEditors = available;
    return available;
  });

  handleIpc(IPC.SHELL_OPEN_IN_EDITOR, async (_, [editorId, dirPath]): Promise<void> => {
    const editor = knownEditors.find((e) => e.id === editorId);
    if (!editor) throw new Error(`Unknown editor: ${editorId}`);

    if (process.platform === 'darwin' && editor.macAppName) {
      spawn('open', ['-a', editor.macAppName, dirPath], { detached: true, stdio: 'ignore' });
    } else if (editor.linuxCmd) {
      spawn(editor.linuxCmd, [dirPath], { detached: true, stdio: 'ignore' });
    }
  });

  // WSL distro detection (Windows only)
  handleIpc(IPC.SHELL_GET_WSL_DISTROS, async (): Promise<string[]> => {
    return detectWslDistros();
  });
}
