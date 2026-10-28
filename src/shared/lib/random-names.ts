// Random name generator for session branch suffixes

const adjectives = [
  'agile',
  'amber',
  'ample',
  'arid',
  'ashen',
  'azure',
  'bleak',
  'bold',
  'brave',
  'brief',
  'bright',
  'brisk',
  'broad',
  'calm',
  'clean',
  'clear',
  'close',
  'cool',
  'coral',
  'crisp',
  'dark',
  'deep',
  'deft',
  'dense',
  'dim',
  'dry',
  'dusk',
  'dusty',
  'eager',
  'even',
  'faded',
  'faint',
  'fair',
  'fast',
  'fierce',
  'fine',
  'firm',
  'first',
  'flat',
  'fleet',
  'fond',
  'free',
  'fresh',
  'full',
  'gaunt',
  'gilt',
  'glad',
  'gold',
  'grand',
  'gray',
  'green',
  'grim',
  'hale',
  'hardy',
  'hazel',
  'high',
  'hushed',
  'icy',
  'idle',
  'iron',
  'jade',
  'just',
  'keen',
  'kind',
  'late',
  'lean',
  'light',
  'lithe',
  'lofty',
  'lone',
  'long',
  'lost',
  'lucid',
  'lunar',
  'lush',
  'meek',
  'mild',
  'mute',
  'near',
  'neat',
  'new',
  'next',
  'noble',
  'odd',
  'olive',
  'onyx',
  'opal',
  'open',
  'pale',
  'pearl',
  'plain',
  'prime',
  'proud',
  'pure',
  'quick',
  'quiet',
  'rapid',
  'rare',
  'raw',
  'rich',
  'ripe',
  'rosy',
  'rough',
  'royal',
  'ruby',
  'rustic',
  'safe',
  'sage',
  'salt',
  'sane',
  'sharp',
  'sheer',
  'short',
  'shy',
  'silent',
  'silver',
  'sleek',
  'slick',
  'slim',
  'slow',
  'small',
  'smart',
  'smooth',
  'snug',
  'sober',
  'soft',
  'solar',
  'solid',
  'spare',
  'stark',
  'steady',
  'steel',
  'steep',
  'stern',
  'still',
  'stout',
  'stray',
  'strong',
  'sunny',
  'sure',
  'swift',
  'tame',
  'tart',
  'terse',
  'thick',
  'thin',
  'tidy',
  'tight',
  'tiny',
  'trim',
  'true',
  'twin',
  'vast',
  'vivid',
  'warm',
  'west',
  'wide',
  'wild',
  'wise',
  'worn',
  'wry',
  'young',
];

const nouns = [
  'alder',
  'aloe',
  'anvil',
  'arch',
  'ash',
  'aspen',
  'basin',
  'bay',
  'beak',
  'beam',
  'bell',
  'bend',
  'birch',
  'blaze',
  'bloom',
  'bluff',
  'bolt',
  'bone',
  'bough',
  'briar',
  'brook',
  'brush',
  'cairn',
  'cave',
  'cedar',
  'chalk',
  'chase',
  'chime',
  'clay',
  'cliff',
  'cloud',
  'coal',
  'coast',
  'cone',
  'coral',
  'cove',
  'crane',
  'creek',
  'crest',
  'crow',
  'dale',
  'dart',
  'dawn',
  'dell',
  'dew',
  'dove',
  'drift',
  'dune',
  'eagle',
  'edge',
  'elm',
  'ember',
  'fawn',
  'fern',
  'finch',
  'flame',
  'flare',
  'flax',
  'flint',
  'forge',
  'fox',
  'frost',
  'gale',
  'gem',
  'glade',
  'glass',
  'glen',
  'glow',
  'gorge',
  'grain',
  'grass',
  'grit',
  'grove',
  'gust',
  'hare',
  'hawk',
  'haze',
  'heath',
  'hedge',
  'helm',
  'heron',
  'holt',
  'horn',
  'hound',
  'isle',
  'ivy',
  'jade',
  'kelp',
  'knoll',
  'lake',
  'lance',
  'lark',
  'latch',
  'leaf',
  'ledge',
  'lily',
  'lime',
  'loch',
  'lodge',
  'loft',
  'lotus',
  'lynx',
  'maple',
  'marl',
  'marsh',
  'mesa',
  'mill',
  'mink',
  'mint',
  'mist',
  'moat',
  'moon',
  'moss',
  'mound',
  'nest',
  'newt',
  'north',
  'notch',
  'oak',
  'opal',
  'ore',
  'owl',
  'palm',
  'pass',
  'path',
  'peak',
  'pear',
  'peat',
  'pike',
  'pine',
  'pitch',
  'plume',
  'pond',
  'quail',
  'quartz',
  'rain',
  'range',
  'raven',
  'ray',
  'reed',
  'reef',
  'ridge',
  'rim',
  'river',
  'rock',
  'root',
  'rose',
  'rush',
  'rust',
  'rye',
  'sage',
  'sand',
  'seal',
  'seed',
  'shade',
  'shard',
  'shell',
  'shoal',
  'shore',
  'silk',
  'silt',
  'slate',
  'slope',
  'smoke',
  'snow',
  'soil',
  'spark',
  'spire',
  'spray',
  'spring',
  'spruce',
  'star',
  'stem',
  'stone',
  'storm',
  'strand',
  'stream',
  'sun',
  'surf',
  'talon',
  'thorn',
  'tide',
  'timber',
  'tor',
  'trail',
  'trout',
  'twig',
  'vale',
  'vault',
  'veil',
  'vent',
  'vine',
  'watch',
  'wave',
  'web',
  'wheat',
  'whim',
  'wick',
  'willow',
  'wind',
  'wing',
  'wood',
  'wren',
  'yarn',
  'yew',
];

function randomElement<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generates a random branch suffix like "swift-fox" or "calm-river"
 */
export function generateBranchSuffix(): string {
  return `${randomElement(adjectives)}-${randomElement(nouns)}`;
}

/**
 * Converts a branch suffix to a title case session name
 * e.g., "swift-fox" -> "Swift Fox"
 */
export function branchSuffixToName(suffix: string): string {
  return suffix
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Sanitizes a string into a git-safe branch suffix.
 * Lowercase, hyphen-separated, no special chars.
 */
export function sanitizeBranchSuffix(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/**
 * Sanitizes a string into a valid git branch name per git-check-ref-format rules.
 * Preserves `/` for namespaced branches (e.g. "feature/my-branch").
 * Strips characters that git rejects: spaces, `~`, `^`, `:`, `?`, `*`, `[`, `\`,
 * control chars, `..`, `.lock` component suffixes, leading/trailing dots and slashes.
 * Lone `@` is allowed; only the `@{` sequence is forbidden.
 */
export function sanitizeBranchName(raw: string): string {
  return (
    raw
      // Replace the forbidden @{ sequence before stripping individual chars
      .replace(/@\{/g, '-')
      // Replace disallowed characters with hyphens (note: @ is allowed, only @{ is not)
      .replace(/[\s~^:?*[\]\\{}"'!#$%&()+=<>,;|`]/g, '-')
      // Remove control characters and DEL — intentional; git rejects these in ref names.
      // oxlint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, '')
      // Collapse consecutive dots (git rejects "..")
      .replace(/\.{2,}/g, '.')
      // Collapse consecutive slashes
      .replace(/\/{2,}/g, '/')
      // Collapse consecutive hyphens
      .replace(/-{2,}/g, '-')
      // Per-component cleanup: strip leading/trailing dots/hyphens and trailing .lock
      .split('/')
      .map((part) => part.replace(/^[-.]|[-.]$/g, '').replace(/\.lock$/i, ''))
      .filter(Boolean)
      .join('/')
  );
}

/**
 * Names Windows reserves at the OS level — creating a file or folder with one
 * of these basenames (with or without extension) fails. Compared
 * case-insensitively against the basename portion of the segment.
 */
const WINDOWS_RESERVED_BASENAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * Sanitizes a project name into a filesystem-safe path segment for worktree
 * directories. Preserves Unicode and case so non-English names stay legible
 * (e.g. "Müller App" → "Müller-App"). Replaces whitespace runs and characters
 * that are invalid on Windows with hyphens, and prefixes Windows-reserved
 * device names so they remain creatable. Falls back to "project" when the
 * input collapses to an empty string.
 */
export function sanitizeWorktreeProjectSegment(raw: string): string {
  const cleaned = raw
    .normalize('NFC')
    // Strip null bytes, control characters, and DEL
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    // Replace path separators and Windows-invalid characters with hyphens
    .replace(/[<>:"/\\|?*]/g, '-')
    // Replace any whitespace run with a single hyphen
    .replace(/\s+/g, '-')
    // Collapse repeated hyphens introduced above
    .replace(/-{2,}/g, '-')
    // Trim leading/trailing hyphens and dots (the latter avoids hidden folders
    // and ".."-only segments after sanitization)
    .replace(/^[-.]+|[-.]+$/g, '');

  if (!cleaned) return 'project';

  // Windows treats reserved device names as reserved across all extensions
  // (`con`, `con.txt`, `NUL.anything` all fail). Prefix to keep the name usable.
  const basename = cleaned.split('.', 1)[0].toUpperCase();
  if (WINDOWS_RESERVED_BASENAMES.has(basename)) {
    return `_${cleaned}`;
  }

  return cleaned;
}
