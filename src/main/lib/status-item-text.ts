import {
  isStatusGapSegment,
  isStatusIconSegment,
  isStatusTextSegment,
  MAX_STATUS_ITEM_TEXT,
  type StatusGapSegment,
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

// A gap after the parts kept so far, past the space before it, unless it would start them or follow
// another gap.
function addGap(kept: StatusItemSegment[], gap: StatusGapSegment): void {
  let previous = kept[kept.length - 1];
  while (previous && isStatusTextSegment(previous) && !previous.text.trim()) {
    kept.pop();
    previous = kept[kept.length - 1];
  }
  if (!previous || isStatusGapSegment(previous)) return;
  if (isStatusTextSegment(previous)) {
    kept[kept.length - 1] = { ...previous, text: previous.text.trimEnd() };
  }
  kept.push(gap);
}

/**
 * Parts with one gap between groups: none at the ends or one after another, and no space beside a
 * gap, which is the space between the parts. Text left empty goes too.
 */
export function tidyGaps(segments: StatusItemSegment[]): StatusItemSegment[] {
  const kept: StatusItemSegment[] = [];
  const last = (): StatusItemSegment | undefined => kept[kept.length - 1];
  for (const segment of segments) {
    if (isStatusGapSegment(segment)) {
      addGap(kept, segment);
      continue;
    }
    if (!isStatusTextSegment(segment)) {
      kept.push(segment);
      continue;
    }
    const previous = last();
    const text = previous && isStatusGapSegment(previous) ? segment.text.trimStart() : segment.text;
    if (text) kept.push(text === segment.text ? segment : { ...segment, text });
  }
  const end = last();
  if (end && isStatusGapSegment(end)) kept.pop();
  return kept;
}

// How many characters a part takes of an item's text: a gap reads as a space.
function textLength(segment: StatusItemSegment): number {
  if (isStatusTextSegment(segment)) return segment.text.length;
  return isStatusGapSegment(segment) ? 1 : 0;
}

// The parts as text, as where an item is said or shown plainly: each gap reads as one space, past
// the space around it, such as after an icon.
function plainText(segments: StatusItemSegment[]): string {
  let text = '';
  let afterGap = false;
  for (const segment of segments) {
    if (isStatusGapSegment(segment)) {
      text = `${text.trimEnd()} `;
      afterGap = true;
    } else if (isStatusTextSegment(segment)) {
      text += afterGap ? segment.text.trimStart() : segment.text;
      afterGap = afterGap && !segment.text.trim();
    }
  }
  return text.trim();
}

/**
 * The text segments read as, with the space beside gaps and repeated gaps as the bar tidies them,
 * such as for checking an item's length.
 */
export function segmentsPlainText(segments: StatusItemSegment[]): string {
  return plainText(
    tidyGaps(
      segments.map((segment) =>
        isStatusTextSegment(segment)
          ? { ...segment, text: segment.text.replace(ANSI_ESCAPE, '') }
          : segment
      )
    )
  );
}

/**
 * Colored runs, icons and gaps as the bar shows them: the text trimmed at both ends and cut as the
 * item's text is, each gap counting as a space, and gaps tidied as tidyGaps does. Undefined when no
 * run has a color or weight of its own and there is no icon or gap, so the item's text and color
 * are all it needs.
 */
function fitSegments(segments: StatusItemSegment[]): StatusItemSegment[] | undefined {
  const runs = tidyGaps(segments);
  const styled = (segment: StatusItemSegment) =>
    !isStatusTextSegment(segment) || segment.color || segment.bold;
  if (!runs.some(styled)) return undefined;
  const blank = (segment: StatusItemSegment) =>
    isStatusTextSegment(segment) && !segment.text.trim();
  while (runs.length > 0 && blank(runs[0])) runs.shift();
  while (runs.length > 0 && blank(runs[runs.length - 1])) runs.pop();
  if (runs.length === 0) return undefined;
  const first = runs[0];
  if (isStatusTextSegment(first)) runs[0] = { ...first, text: first.text.trimStart() };
  const last = runs[runs.length - 1];
  if (isStatusTextSegment(last)) runs[runs.length - 1] = { ...last, text: last.text.trimEnd() };
  const length = runs.reduce((sum, segment) => sum + textLength(segment), 0);
  if (length <= MAX_STATUS_ITEM_TEXT) return runs;
  const result: StatusItemSegment[] = [];
  let room = MAX_STATUS_ITEM_TEXT - 1;
  let lastText = -1;
  for (const segment of runs) {
    if (room <= 0) break;
    if (!isStatusTextSegment(segment)) {
      result.push(segment);
      room -= textLength(segment);
      continue;
    }
    lastText = result.push({ ...segment, text: segment.text.slice(0, room) }) - 1;
    room -= segment.text.length;
  }
  // A gap that took the last of the room would end the item.
  while (result.length > 0 && isStatusGapSegment(result[result.length - 1])) result.pop();
  const cut = result[lastText] as StatusTextSegment;
  result[lastText] = { ...cut, text: `${cut.text}…` };
  return result;
}

/** An item's text from a line that may carry terminal colors: what it reads, and its colored runs. */
export function statusItemText(line: string): {
  text: string;
  segments?: StatusItemSegment[];
} {
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
      return {
        icon: segment.icon,
        ...(segment.color && { color: segment.color }),
      };
    }
    if (isStatusGapSegment(segment)) return { gap: true };
    const { text, color, bold } = segment;
    return {
      text: text.replace(ANSI_ESCAPE, ''),
      ...(color && { color }),
      ...(bold && { bold }),
    };
  });
  const fitted = fitSegments(runs);
  return {
    text: truncate(plainText(fitted ?? runs), MAX_STATUS_ITEM_TEXT),
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
