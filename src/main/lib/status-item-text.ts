import {
  isStatusIconSegment,
  MAX_STATUS_ITEM_TEXT,
  type StatusItemSegment,
  type StatusTextSegment,
} from '../../shared/types/status-items';

import { ANSI_ESCAPE, ansiSegments } from './ansi-colors';

export { ANSI_ESCAPE };

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** The text an item shows, without the escapes in it, such as for checking its length. */
export function visibleStatusText(text: string): string {
  return text.replace(ANSI_ESCAPE, '').trim();
}

/**
 * Colored runs and icons as the bar shows them: the text trimmed at both ends and cut as the item's
 * text is. Undefined when no run has a color or weight of its own and there is no icon, so the
 * item's text and color are all it needs.
 */
function fitSegments(segments: StatusItemSegment[]): StatusItemSegment[] | undefined {
  const runs = segments.filter((segment) => isStatusIconSegment(segment) || segment.text);
  const styled = (segment: StatusItemSegment) =>
    isStatusIconSegment(segment) || segment.color || segment.bold;
  if (!runs.some(styled)) return undefined;
  const blank = (segment: StatusItemSegment) =>
    !isStatusIconSegment(segment) && !segment.text.trim();
  while (runs.length > 0 && blank(runs[0])) runs.shift();
  while (runs.length > 0 && blank(runs[runs.length - 1])) runs.pop();
  if (runs.length === 0) return undefined;
  const first = runs[0];
  if (!isStatusIconSegment(first)) runs[0] = { ...first, text: first.text.trimStart() };
  const last = runs[runs.length - 1];
  if (!isStatusIconSegment(last)) runs[runs.length - 1] = { ...last, text: last.text.trimEnd() };
  const length = runs.reduce(
    (sum, segment) => sum + (isStatusIconSegment(segment) ? 0 : segment.text.length),
    0
  );
  if (length <= MAX_STATUS_ITEM_TEXT) return runs;
  const result: StatusItemSegment[] = [];
  let room = MAX_STATUS_ITEM_TEXT - 1;
  let lastText = -1;
  for (const segment of runs) {
    if (room <= 0) break;
    if (isStatusIconSegment(segment)) {
      result.push(segment);
      continue;
    }
    lastText = result.push({ ...segment, text: segment.text.slice(0, room) }) - 1;
    room -= segment.text.length;
  }
  const cut = result[lastText] as StatusTextSegment;
  result[lastText] = { ...cut, text: `${cut.text}…` };
  return result;
}

/** An item's text from a line that may carry terminal colors: what it reads, and its colored runs. */
export function statusItemText(line: string): { text: string; segments?: StatusItemSegment[] } {
  const segments = fitSegments(ansiSegments(line));
  return {
    text: truncate(visibleStatusText(line), MAX_STATUS_ITEM_TEXT),
    ...(segments && { segments }),
  };
}

/** An item's text from runs that each name their color and weight, and icons, such as from JSON. */
export function statusItemSegmentsText(segments: StatusItemSegment[]): {
  text: string;
  segments?: StatusItemSegment[];
} {
  const runs = segments.map((segment): StatusItemSegment => {
    if (isStatusIconSegment(segment)) {
      return { icon: segment.icon, ...(segment.color && { color: segment.color }) };
    }
    const { text, color, bold } = segment;
    return { text: text.replace(ANSI_ESCAPE, ''), ...(color && { color }), ...(bold && { bold }) };
  });
  const fitted = fitSegments(runs);
  const text = runs
    .map((segment) => (isStatusIconSegment(segment) ? '' : segment.text))
    .join('')
    .trim();
  return {
    text: truncate(text, MAX_STATUS_ITEM_TEXT),
    ...(fitted && { segments: fitted }),
  };
}

/** An item's segments with an icon before its text, as an `icon` field puts it. */
export function withLeadingIcon(
  { text, segments }: { text: string; segments?: StatusItemSegment[] },
  icon: string,
  color?: string
): StatusItemSegment[] {
  const rest = segments ?? (text ? [{ text }] : []);
  return [{ icon, ...(color && { color }) }, ...(text ? [{ text: ' ' }] : []), ...rest];
}
