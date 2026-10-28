/** How the working spinner looks on workspace cards, in the Overview and the Command Center. */
export const ACTIVITY_SPINNER_STYLES = [
  'arc',
  'rays',
  'dots',
  'pulse',
  'bars',
  'braille',
  'still',
] as const;

export type ActivitySpinnerStyle = (typeof ACTIVITY_SPINNER_STYLES)[number];

export const DEFAULT_ACTIVITY_SPINNER: ActivitySpinnerStyle = 'arc';
