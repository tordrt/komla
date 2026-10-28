import type { ITerminalOptions } from '@xterm/xterm';

/**
 * Tells xterm its PTY is Windows ConPTY, as VS Code does. ConPTY keeps its own screen and
 * adds rows at the bottom when the terminal grows; this makes xterm do the same instead of
 * pulling scrollback down. Builds before 21376 also turn off xterm's reflow, which fights
 * that ConPTY's. Every Windows PTY is ConPTY, whichever conpty.dll is in use.
 */
export function terminalWindowsPtyOptions(
  platform: string | undefined,
  systemVersion: string | undefined,
  useConptyDll: boolean
): Pick<ITerminalOptions, 'windowsPty' | 'reflowCursorLine'> {
  if (platform !== 'win32') return {};
  // Windows reports its version as major.minor.build, e.g. 10.0.22631.
  const buildNumber = Number(systemVersion?.split('.')[2]);
  return {
    windowsPty:
      Number.isInteger(buildNumber) && buildNumber > 0
        ? { backend: 'conpty', buildNumber }
        : { backend: 'conpty' },
    // Komla's newer ConPTY reflows the prompt line too; without this, resizing can lose it
    // (VS Code does the same: microsoft/vscode#274372).
    ...(useConptyDll && { reflowCursorLine: true }),
  };
}
