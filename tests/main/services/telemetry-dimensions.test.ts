import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetStatus = vi.fn();

vi.mock('../../../src/main/services/license.service', () => ({
  licenseService: { getStatus: mockGetStatus },
}));

vi.mock('../../../src/main/services/agent-preset.service', () => ({
  BUILTIN_PRESETS: [],
}));

const { getTelemetryCohortDimensions } =
  await import('../../../src/main/services/telemetry-dimensions');

describe('getTelemetryCohortDimensions', () => {
  beforeEach(() => {
    mockGetStatus.mockReset();
  });

  it('reports only the free cohort when unlicensed', () => {
    mockGetStatus.mockReturnValue({ isLicensed: false, licenseType: null });

    expect(getTelemetryCohortDimensions()).toEqual({ licenseCohort: 'free' });
  });

  it('reports a lapsed subscription as free', () => {
    mockGetStatus.mockReturnValue({ isLicensed: false, licenseType: 'monthly' });

    expect(getTelemetryCohortDimensions()).toEqual({ licenseCohort: 'free' });
  });

  it('reports the paid cohort and license type when licensed', () => {
    mockGetStatus.mockReturnValue({ isLicensed: true, licenseType: 'yearly' });

    expect(getTelemetryCohortDimensions()).toEqual({
      licenseCohort: 'paid_yearly',
      licenseType: 'yearly',
    });
  });
});
