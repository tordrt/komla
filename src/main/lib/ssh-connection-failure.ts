// ssh exits with 255 when it can't connect or loses the connection. Any other code is the
// remote command's, which ssh passes through.
const SSH_ERROR_EXIT_CODE = 255;
const MAX_MESSAGE_LENGTH = 300;
// CSI, OSC, then any other escape: ESC, intermediate bytes, a final byte (e.g. ESC ( B, ESC 7).
const ESCAPE_SEQUENCE =
  // oxlint-disable-next-line no-control-regex
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])/g;
// oxlint-disable-next-line no-control-regex
const COLOR_SEQUENCE = /^\x1b\[[0-9;]*m$/;

/**
 * Why an ssh process failed, from the last line it printed, or undefined when it didn't fail
 * (e.g. the remote shell exited). ssh prints its error last, under whatever the session showed.
 */
export function sshConnectionFailure(exitCode: number, output: string): string | undefined {
  if (exitCode !== SSH_ERROR_EXIT_CODE) return undefined;
  // A full-screen program such as tmux moves the cursor between rows instead of printing
  // newlines, and ssh prints its error wherever the cursor was, so a move ends a line too.
  const lastLine = output
    .replace(ESCAPE_SEQUENCE, (sequence) => (COLOR_SEQUENCE.test(sequence) ? '' : '\n'))
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!lastLine) return 'The SSH connection failed.';
  // Anything ssh's error was printed after comes first.
  return lastLine.length > MAX_MESSAGE_LENGTH
    ? `…${lastLine.slice(-(MAX_MESSAGE_LENGTH - 1))}`
    : lastLine;
}
