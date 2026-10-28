/**
 * Whether the environment turns off all telemetry and crash reports, whatever
 * the settings say: `DO_NOT_TRACK=1` (https://consoledonottrack.com) or
 * `KOMLA_TELEMETRY=off` (also `0` or `false`).
 */
export function telemetryDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const doNotTrack = env.DO_NOT_TRACK?.trim();
  if (doNotTrack && doNotTrack !== '0' && doNotTrack.toLowerCase() !== 'false') return true;
  const komla = env.KOMLA_TELEMETRY?.trim().toLowerCase();
  return komla === 'off' || komla === '0' || komla === 'false';
}
