import type { EvaluatedModules } from 'vite/module-runner';

/** Vitest's own modules, and mocks, which vi.resetModules() leaves loaded too. */
const VITEST_MODULES = [/\/vitest\/dist\//, /vitest-virtual-\w+\/dist/, /@vitest\/dist/, /^mock:/];

/**
 * Modules that hold no state between tests: src/shared/ is contracts, schemas,
 * constants and pure helpers, and it imports nothing from the main process or
 * the renderer, so a module kept here never holds on to one that was reset.
 */
const STATELESS_MODULES = [/\/src\/shared\//, /\/packages\/remote-protocol\//];

/**
 * vi.resetModules(), keeping the stateless modules loaded. Re-evaluating them for
 * every test, the zod schemas above all, cost the WorkspaceService tests about
 * 25 ms each. Mirrors Vitest's resetModules(), which has no option to keep modules.
 */
export function resetModulesKeepingShared(): void {
  const worker = (globalThis as { __vitest_worker__?: { evaluatedModules?: EvaluatedModules } })
    .__vitest_worker__;
  if (!worker?.evaluatedModules) {
    throw new Error('Vitest no longer exposes its module graph; use vi.resetModules() instead.');
  }
  for (const [id, node] of worker.evaluatedModules.idToModuleMap) {
    if (VITEST_MODULES.some((pattern) => pattern.test(id))) continue;
    if (STATELESS_MODULES.some((pattern) => pattern.test(id))) continue;
    node.promise = undefined;
    node.exports = undefined;
    node.evaluated = false;
    node.importers.clear();
  }
}
