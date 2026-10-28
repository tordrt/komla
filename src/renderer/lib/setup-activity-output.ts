// What a run's terminal wrote that isn't text: OSC titles and links, CSI colors and modes, and
// other escapes. Carriage returns stay for readableRunOutput.
const TERMINAL_CONTROL =
  // oxlint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-_]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

// The shell's echo of the command Komla typed for a run, prompt and all, and what a login shell
// says as that command exits it; see BackgroundProcessService.
const TYPED_COMMAND_ECHO = /; exit \$\?\s*$/;
const LOGIN_SHELL_EXIT = /\n?logout\s*$/;

/**
 * A setup or background command run's output as text. A line redrawn after carriage returns, as
 * a progress bar is, shows as it was last drawn, and the shell's echo of the typed command is
 * left out.
 */
export function readableRunOutput(output: string): string {
  return output
    .replace(TERMINAL_CONTROL, '')
    .split('\n')
    .map((line) => line.split('\r').findLast((drawn) => drawn !== '') ?? '')
    .filter((line) => !TYPED_COMMAND_ECHO.test(line))
    .join('\n')
    .replace(LOGIN_SHELL_EXIT, '');
}
