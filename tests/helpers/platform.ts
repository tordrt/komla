/**
 * The platform a test pretends to run on. CI runs the suite on macOS, Linux and Windows, so a
 * test of one platform's behaviour pins it rather than assuming the host's: Local copy, for one,
 * never runs on Windows. tests/setup.ts puts the host's platform back after every test, so a pin
 * can't leak into the next test, or into the next file of a worker that shares its `process`.
 */
// Recorded on `process` itself, the first time any file loads this: the dom project's files each
// load it again in a worker that shares `process`, and a pin one of them left would otherwise
// pass for the host's.
const HOST_PLATFORM = Symbol.for('komla.tests.hostPlatform');
const shared = process as unknown as Record<symbol, NodeJS.Platform | undefined>;
const hostPlatform = (shared[HOST_PLATFORM] ??= process.platform);

// Counts every change to the platform, so a restore that comes late can tell whether its pin is
// still the latest one, rather than another that happens to name the same platform.
let changes = 0;

/** Pins process.platform for the rest of the test. */
export function pinPlatform(platform: NodeJS.Platform): void {
  changes += 1;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * Runs `run` with process.platform pinned, then puts back the platform from before, once the
 * promise `run` returns settles when it returns one, so code after an `await` sees the pin too.
 * A promise that settles after something else changed the platform, such as the next pin or
 * the restore after the test, leaves that change in place.
 */
export function onPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const previous = process.platform;
  pinPlatform(platform);
  const pin = changes;
  let result: T;
  try {
    result = run();
  } catch (error) {
    pinPlatform(previous);
    throw error;
  }
  // Any promise-like result: one from another realm, as a dom file's VM context can get from
  // Node, isn't an instance of this realm's Promise.
  if (typeof (result as { then?: unknown } | null)?.then === 'function') {
    return Promise.resolve(result).finally(() => {
      if (changes === pin) pinPlatform(previous);
    }) as T;
  }
  pinPlatform(previous);
  return result;
}

/** Puts back the host's platform; tests/setup.ts does after every test. */
export function restoreHostPlatform(): void {
  if (process.platform === hostPlatform) changes += 1;
  else pinPlatform(hostPlatform);
}
