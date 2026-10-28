// Set by electron.vite.config.ts. Release builds (scripts/release.sh) pass
// KOMLA_DISTRIBUTION=official and the utility token; a build from source
// leaves both unset.
declare const __KOMLA_DISTRIBUTION__: string | undefined;
declare const __KOMLA_UTILITY_TOKEN__: string | undefined;

export type BuildDistribution = 'official' | 'source';

/** Whether this app came from the official release pipeline or was built from source. */
export function getBuildDistribution(): BuildDistribution {
  return typeof __KOMLA_DISTRIBUTION__ !== 'undefined' && __KOMLA_DISTRIBUTION__ === 'official'
    ? 'official'
    : 'source';
}

/** App token for the Komla-managed utility endpoint; empty when the build has none. */
export function getUtilityAppToken(): string {
  return typeof __KOMLA_UTILITY_TOKEN__ !== 'undefined' ? __KOMLA_UTILITY_TOKEN__ : '';
}
