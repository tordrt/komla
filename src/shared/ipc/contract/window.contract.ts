import { IPC } from '../../constants/ipc-channels';
import {
  setPaneSurfaceWorkspacesArgsSchema,
  setUnsavedFilesArgsSchema,
  setShownWorkspaceArgsSchema,
  moveWorkspaceToWindowArgsSchema,
  saveWorkspaceLayoutsArgsSchema,
  focusWorkspaceWindowArgsSchema,
  setTitleBarOverlayArgsSchema,
  showMessageBoxArgsSchema,
} from '../schemas/window-ipc.schemas';

import { invoke, send, sync } from './define';

export const windowContract = {
  [IPC.WINDOW_CREATE]: invoke().returns<string>(),
  [IPC.WINDOW_GET_ALL_IDS]: invoke().returns<{ id: string; displayNumber: number }[]>(),
  [IPC.WINDOW_RENDERER_READY]: send(),
  [IPC.WORKSPACE_SET_PANE_SURFACE_WORKSPACES]: send(setPaneSurfaceWorkspacesArgsSchema),
  [IPC.WINDOW_SET_UNSAVED_FILES]: send(setUnsavedFilesArgsSchema),
  [IPC.WINDOW_SET_SHOWN_WORKSPACE]: send(setShownWorkspaceArgsSchema),
  [IPC.WORKSPACE_SAVE_LAYOUTS_ON_CLOSE]: sync(saveWorkspaceLayoutsArgsSchema),
  [IPC.WORKSPACE_MOVE_TO_WINDOW]: invoke(moveWorkspaceToWindowArgsSchema).returns<void>(),
  [IPC.WORKSPACE_FOCUS_WINDOW]: invoke(focusWorkspaceWindowArgsSchema).returns<boolean>(),
  [IPC.WINDOW_MINIMIZE]: invoke().returns<void>(),
  [IPC.WINDOW_MAXIMIZE]: invoke().returns<void>(),
  [IPC.WINDOW_CLOSE]: invoke().returns<void>(),
  [IPC.WINDOW_IS_MAXIMIZED]: invoke().returns<boolean>(),
  [IPC.WINDOW_IS_FULLSCREEN]: invoke().returns<boolean>(),
  [IPC.WINDOW_SET_TITLE_BAR_OVERLAY]: invoke(setTitleBarOverlayArgsSchema).returns<void>(),
  [IPC.DIALOG_SHOW_MESSAGE_BOX]: invoke(showMessageBoxArgsSchema).returns<number>(),
} as const;
