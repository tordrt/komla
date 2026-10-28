import { setTerminalRendererWebglLimit } from '@/lib/terminal-renderer-runtime';

// Enough for a tab split four ways; terminals past it draw without WebGL's GPU memory.
const REDUCED_WEBGL_CONTEXTS = 4;

/**
 * Applies the Reduce effects setting, for slower computers: globals.css holds animations still
 * and drops background blur under `data-reduce-effects`, and fewer terminals keep WebGL.
 */
export function applyReduceEffects(reduce: boolean): void {
  document.documentElement.toggleAttribute('data-reduce-effects', reduce);
  setTerminalRendererWebglLimit(reduce ? REDUCED_WEBGL_CONTEXTS : undefined);
}
