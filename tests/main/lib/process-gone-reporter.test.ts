import { describe, it, expect, vi, beforeEach } from 'vitest';

const reportError = vi.fn();
vi.mock('../../../src/main/services/error-reporting.service', () => ({
  errorReportingService: { report: reportError },
}));

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('reportChildProcessGone', () => {
  beforeEach(() => {
    reportError.mockClear();
  });

  it('skips clean-exit', async () => {
    const { reportChildProcessGone } = await import('../../../src/main/lib/process-gone-reporter');
    const logger = makeLogger();

    reportChildProcessGone(
      { type: 'Utility', reason: 'clean-exit', exitCode: 0, name: 'svc' },
      logger
    );

    expect(logger.error).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it('logs and reports non-clean exits with processType context', async () => {
    const { reportChildProcessGone } = await import('../../../src/main/lib/process-gone-reporter');
    const logger = makeLogger();

    reportChildProcessGone(
      { type: 'GPU', reason: 'crashed', exitCode: 134, name: 'gpu-process' },
      logger
    );

    expect(logger.error).toHaveBeenCalledWith('Child process gone', {
      type: 'GPU',
      reason: 'crashed',
      exitCode: 134,
      name: 'gpu-process',
    });

    expect(reportError).toHaveBeenCalledTimes(1);
    const [errArg, typeArg, ctxArg] = reportError.mock.calls[0];
    expect(errArg).toBeInstanceOf(Error);
    expect((errArg as Error).message).toContain('GPU');
    expect((errArg as Error).message).toContain('crashed');
    expect((errArg as Error).message).toContain('134');
    expect(typeArg).toBe('processGone');
    expect(ctxArg).toEqual({ processType: 'GPU', reason: 'crashed', exitCode: 134 });
  });

  it('includes the Windows system error code of a failed launch', async () => {
    const { reportChildProcessGone } = await import('../../../src/main/lib/process-gone-reporter');
    const logger = makeLogger();

    reportChildProcessGone(
      {
        type: 'Utility',
        reason: 'launch-failed',
        exitCode: 18,
        systemErrorCode: 5,
        name: 'voice-transcription',
      },
      logger
    );

    expect(logger.error).toHaveBeenCalledWith(
      'Child process gone',
      expect.objectContaining({ reason: 'launch-failed', systemErrorCode: 5 })
    );
    const [errArg] = reportError.mock.calls[0];
    expect((errArg as Error).message).toBe(
      'Child process gone: Utility launch-failed (exitCode 18, systemErrorCode 5)'
    );
  });

  it('reports oom and other non-clean reasons', async () => {
    const { reportChildProcessGone } = await import('../../../src/main/lib/process-gone-reporter');
    const logger = makeLogger();

    reportChildProcessGone(
      { type: 'Utility', reason: 'oom', exitCode: 9, name: 'utility' },
      logger
    );

    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][2]).toEqual({
      processType: 'Utility',
      reason: 'oom',
      exitCode: 9,
    });
  });
});
