import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reportError } from '../../../src/renderer/lib/error-reporting';

describe('reportError', () => {
  let mockReportError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockReportError = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      api: {
        reportError: mockReportError,
      },
    });
  });

  it('calls window.api.reportError with error details', () => {
    const error = new Error('test error');
    reportError(error, 'renderer');

    expect(mockReportError).toHaveBeenCalledWith({
      message: 'test error',
      stack: error.stack,
      type: 'renderer',
      context: undefined,
    });
  });

  it('passes context when provided', () => {
    const error = new Error('with context');
    const context = { component: 'Sidebar', action: 'click' };
    reportError(error, 'ui', context);

    expect(mockReportError).toHaveBeenCalledWith({
      message: 'with context',
      stack: error.stack,
      type: 'ui',
      context,
    });
  });

  it('does not throw when api.reportError rejects', () => {
    mockReportError.mockRejectedValue(new Error('network failure'));

    expect(() => {
      reportError(new Error('test'), 'renderer');
    }).not.toThrow();
  });

  it('passes error.stack which may be undefined', () => {
    const error = new Error('no stack');
    error.stack = undefined;
    reportError(error, 'test');

    expect(mockReportError).toHaveBeenCalledWith(expect.objectContaining({ stack: undefined }));
  });
});
