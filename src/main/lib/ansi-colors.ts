import type { StatusItemThemeColor, StatusTextSegment } from '../../shared/types/status-items';

// The eight terminal colors as theme colors, so they read well in every theme. Magenta and cyan
// have no theme color of their own.
const BASIC_COLORS: StatusItemThemeColor[] = [
  'muted',
  'error',
  'success',
  'warning',
  'info',
  'info',
  'info',
  'foreground',
];

// Colors and links printed for a terminal, which the status bar shows only as colored runs.
export const ANSI_ESCAPE =
  // oxlint-disable-next-line no-control-regex
  /\u001b\[([0-?]*)([ -/]*[@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const hex = (value: number) => Math.max(0, Math.min(255, value)).toString(16).padStart(2, '0');

// The 256-color palette past the first 16: a 6×6×6 cube, then 24 grays.
function paletteColor(index: number): string | undefined {
  if (index < 16) return BASIC_COLORS[index % 8];
  if (index > 255) return undefined;
  if (index >= 232) {
    const gray = 8 + (index - 232) * 10;
    return `#${hex(gray)}${hex(gray)}${hex(gray)}`;
  }
  const cube = index - 16;
  const level = (value: number) => (value === 0 ? 0 : 55 + value * 40);
  return `#${hex(level(Math.floor(cube / 36)))}${hex(level(Math.floor(cube / 6) % 6))}${hex(level(cube % 6))}`;
}

/**
 * A 256-color or RGB color from what follows 38: `5;n` or `2;r;g;b`. Colon-separated RGB can name
 * a color space first, so its last three numbers are the color.
 */
function extendedColor(args: number[], colons = false): string | undefined {
  if (!args.every(Number.isFinite)) return undefined;
  if (args[0] === 5) return args.length >= 2 ? paletteColor(args[1]) : undefined;
  if (args[0] !== 2 || args.length < 4) return undefined;
  const [r, g, b] = colons ? args.slice(-3) : args.slice(1, 4);
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * Splits a line a command printed for a terminal into runs of text by color and weight. Only
 * foreground colors and bold count; other escapes are dropped.
 */
export function ansiSegments(line: string): StatusTextSegment[] {
  const segments: StatusTextSegment[] = [];
  let color: string | undefined;
  let bold = false;
  let last = 0;
  const push = (text: string) => {
    if (!text) return;
    const previous = segments.at(-1);
    if (previous && previous.color === color && Boolean(previous.bold) === bold) {
      previous.text += text;
    } else {
      segments.push({ text, ...(color && { color }), ...(bold && { bold }) });
    }
  };
  for (const match of line.matchAll(ANSI_ESCAPE)) {
    push(line.slice(last, match.index));
    last = match.index + match[0].length;
    if (match[2] !== 'm') continue;
    const params = (match[1] || '0').split(';');
    for (let i = 0; i < params.length; i++) {
      // A color can come as one parameter with its arguments after colons, as in 38:2::255:0:0.
      if (params[i].includes(':')) {
        const [code, ...args] = params[i].split(':').map((value) => Number(value || 0));
        if (code === 38) color = extendedColor(args, true) ?? color;
        continue;
      }
      const code = Number(params[i] || 0);
      if (code === 0) {
        color = undefined;
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = undefined;
      else if (code >= 30 && code <= 37) color = BASIC_COLORS[code - 30];
      else if (code >= 90 && code <= 97) color = BASIC_COLORS[code - 90];
      else if (code === 38 || code === 48 || code === 58) {
        // Background and underline colors are left out, past their arguments. Arguments that
        // are missing leave nothing after them to read.
        const args = params.slice(i + 1, i + 5).map((value) => Number(value || 0));
        const argCount = args[0] === 5 ? 2 : args[0] === 2 ? 4 : params.length;
        if (code === 38 && i + argCount < params.length) color = extendedColor(args) ?? color;
        i += argCount;
      }
    }
  }
  push(line.slice(last));
  return segments;
}
