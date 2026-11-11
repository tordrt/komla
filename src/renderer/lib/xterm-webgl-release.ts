import type { WebglAddon } from '@xterm/addon-webgl';

interface WebglAddonInternals {
  _renderer?: {
    _gl?: Pick<WebGL2RenderingContext, 'getExtension' | 'isContextLost'>;
  };
}

/**
 * Disposes a WebGL addon and gives its context back. xterm only removes the canvas, which leaves
 * the context among the 16 Chromium allows a window until it is garbage collected. Chromium makes
 * room for the next one by taking the context drawn to longest ago, a hidden terminal's, which
 * then drew with xterm's DOM renderer and built a new context when shown. Uses the addon's
 * private renderer; if an upgrade removes it, contexts are freed by garbage collection as before.
 */
export function disposeWebglAddon(addon: WebglAddon): void {
  const gl = (addon as unknown as WebglAddonInternals)._renderer?._gl;
  try {
    addon.dispose();
  } finally {
    // After the addon stops listening, so it doesn't take this for a loss to recover from.
    if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
