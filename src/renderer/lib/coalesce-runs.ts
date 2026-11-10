/**
 * Runs `task` one run at a time. Calls made while a run is under way share a single run that
 * starts once it ends: after every one of those calls, so it reads whatever they were made for.
 * A burst of calls costs two runs rather than one each.
 */
export function coalesceRuns(task: () => Promise<void>): () => Promise<void> {
  let running: Promise<void> | null = null;
  let next: Promise<void> | null = null;

  const start = (): Promise<void> => {
    const run = task().finally(() => {
      if (running === run) running = null;
    });
    running = run;
    return run;
  };

  return () => {
    if (next) return next;
    if (!running) return start();
    next = running
      .catch(() => {})
      .then(() => {
        next = null;
        return start();
      });
    return next;
  };
}
