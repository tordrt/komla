import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));

import { createLogger } from '../../../src/main/lib/logger';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function logAtEveryLevel(logLevel: string) {
  vi.stubEnv('LOG_LEVEL', logLevel);
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const info = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const logger = createLogger('LoggerTest');
  logger.debug('debug entry');
  logger.info('info entry');
  logger.error('error entry');
  return { debug, info, error };
}

describe('createLogger', () => {
  it('reads LOG_LEVEL case-insensitively', () => {
    const { debug, info } = logAtEveryLevel('DEBUG');

    expect(debug).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledOnce();
  });

  it.each(['trace', 'verbose'])('falls back to info for unknown LOG_LEVEL %s', (logLevel) => {
    const { debug, info, error } = logAtEveryLevel(logLevel);

    expect(debug).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
  });
});
