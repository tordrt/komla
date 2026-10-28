import { Check, CircleDashed, Question, Warning } from '@phosphor-icons/react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import type { AgentState } from '../../shared/lib/agent-state';
import type { AgentsMenuBarImage } from '../../shared/types';

// Sized as the menu bar's own icons and text, in points; drawn at twice that.
const HEIGHT = 18;
const ICON = 13;
const ICON_GAP = 3;
const STATE_GAP = 8;
/** The pill the states sit in, with room either side. */
const PILL_PADDING = 7;
const FONT = '500 12.5px system-ui, -apple-system, sans-serif';
const SCALE = 2;

/**
 * In light mode the menu bar is light or dark by the wallpaper, and Komla can't tell which, so
 * each state keeps its theme color's hue at a lightness both read. In dark mode it's always dark,
 * so the states take the brighter lightness of the dark theme's colors, and working the near-white
 * of the menu bar's own icons.
 */
const MENU_BAR_LIGHTNESS = 0.6;
const DARK_MENU_BAR_LIGHTNESS = 0.8;
const DARK_MENU_BAR_WORKING_LIGHTNESS = 0.95;
const STATE_TOKENS = { input: '--attention', error: '--error', done: '--success' } as const;
/** A see-through gray: lighter than a dark menu bar and darker than a light one. */
const PILL_COLOR = `oklch(${MENU_BAR_LIGHTNESS} 0 0 / 0.24)`;

function stateColor(state: AgentState, dark: boolean): string {
  const working = `oklch(${dark ? DARK_MENU_BAR_WORKING_LIGHTNESS : MENU_BAR_LIGHTNESS} 0 0)`;
  if (state === 'working') return working;
  const channels = getComputedStyle(document.documentElement)
    .getPropertyValue(STATE_TOKENS[state])
    .trim()
    .split(/\s+/);
  const [, chroma, hue] = channels;
  const lightness = dark ? DARK_MENU_BAR_LIGHTNESS : MENU_BAR_LIGHTNESS;
  return chroma && hue ? `oklch(${lightness} ${chroma} ${hue})` : working;
}

/**
 * The status bar's icon for each state, but for working: a spinner turned by swapping images
 * stutters in the menu bar, and a still one looks stuck, so working agents show a dashed circle,
 * which reads as in progress without moving.
 */
const ICONS = { input: Question, error: Warning, done: Check, working: CircleDashed } as const;

/** The state's icon, as SVG markup in its color. */
function iconSvg(state: AgentState, color: string): string {
  const Icon = ICONS[state];
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(<Icon weight="bold" color={color} size={ICON * SCALE} />));
  const svg = host.innerHTML;
  root.unmount();
  // An image's SVG needs its namespace, which Phosphor's icons may leave to the page.
  return svg.includes('xmlns=')
    ? svg
    : svg.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ');
}

function loadImage(svg: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

/**
 * The menu bar item's image: each state's icon and count in the status bar's colors, together in
 * one pill, brighter on a dark menu bar.
 */
export async function drawAgentsMenuBarImage(
  counts: AgentsMenuBarImage['counts'],
  dark: boolean
): Promise<AgentsMenuBarImage> {
  const colors = counts.map(({ state }) => stateColor(state, dark));
  const icons = await Promise.all(
    counts.map(({ state }, index) => loadImage(iconSvg(state, colors[index])))
  );
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  context.font = FONT;
  const texts = counts.map(({ count }) => {
    const text = String(count);
    return { text, width: context.measureText(text).width };
  });
  const width = Math.ceil(
    texts.reduce((sum, { width: textWidth }) => sum + ICON + ICON_GAP + textWidth, 0) +
      STATE_GAP * (texts.length - 1) +
      PILL_PADDING * 2
  );
  canvas.width = width * SCALE;
  canvas.height = HEIGHT * SCALE;

  context.scale(SCALE, SCALE);
  context.fillStyle = PILL_COLOR;
  context.beginPath();
  context.roundRect(0, 0, width, HEIGHT, HEIGHT / 2);
  context.fill();
  context.font = FONT;
  context.textBaseline = 'middle';
  let x = PILL_PADDING;
  texts.forEach(({ text, width: textWidth }, index) => {
    context.drawImage(icons[index], x, (HEIGHT - ICON) / 2, ICON, ICON);
    x += ICON + ICON_GAP;
    context.fillStyle = colors[index];
    context.fillText(text, x, HEIGHT / 2 + 0.5);
    x += textWidth + STATE_GAP;
  });
  return { counts: [...counts], dataUrl: canvas.toDataURL('image/png'), width, height: HEIGHT };
}
