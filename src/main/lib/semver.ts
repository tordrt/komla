/** Compares semantic versions such as 3.7.0 and 3.7.0-staging.3; a prerelease sorts first. */
export function compareSemver(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    if (coreA[i] !== coreB[i]) return coreA[i] - coreB[i];
  }
  if (!preA || !preB) return preA ? -1 : preB ? 1 : 0;
  const idsA = preA.split('.');
  const idsB = preB.split('.');
  for (let i = 0; i < Math.max(idsA.length, idsB.length); i++) {
    if (idsA[i] === undefined) return -1;
    if (idsB[i] === undefined) return 1;
    if (idsA[i] === idsB[i]) continue;
    const numA = /^\d+$/.test(idsA[i]) ? Number(idsA[i]) : NaN;
    const numB = /^\d+$/.test(idsB[i]) ? Number(idsB[i]) : NaN;
    if (!Number.isNaN(numA) && !Number.isNaN(numB)) return numA - numB;
    if (!Number.isNaN(numA)) return -1;
    if (!Number.isNaN(numB)) return 1;
    return idsA[i] < idsB[i] ? -1 : 1;
  }
  return 0;
}

function splitVersion(version: string): [number[], string] {
  const [core, ...pre] = version.split('+')[0].split('-');
  const parts = core.split('.').map((part) => Number(part) || 0);
  return [[parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0], pre.join('-')];
}
