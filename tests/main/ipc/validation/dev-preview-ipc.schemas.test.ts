import { describe, expect, it } from 'vitest';

import {
  devPreviewCaptureArgsSchema,
  devPreviewCloseArgsSchema,
  devPreviewDetectServicesArgsSchema,
  devPreviewHideArgsSchema,
  devPreviewNavigateArgsSchema,
  devPreviewReloadArgsSchema,
  devPreviewSyncArgsSchema,
} from '../../../../src/main/ipc/validation/dev-preview-ipc.schemas';

describe('dev preview IPC schemas', () => {
  it('accepts finite DOM bounds for any web page in a tab', () => {
    for (const url of ['http://127.0.0.1:5173/app', 'https://example.com/docs']) {
      expect(
        devPreviewSyncArgsSchema.parse([
          'workspace-1',
          'tab-1',
          url,
          { x: 1.5, y: 2, width: 300, height: 200 },
        ])
      ).toEqual(['workspace-1', 'tab-1', url, { x: 1.5, y: 2, width: 300, height: 200 }]);
    }
  });

  it('rejects pages that are not on the web, a missing tab, and unusable bounds', () => {
    const bounds = { x: 0, y: 0, width: 300, height: 200 };
    expect(() =>
      devPreviewSyncArgsSchema.parse(['workspace-1', 'tab-1', 'file:///etc/passwd', bounds])
    ).toThrow();
    expect(() =>
      devPreviewSyncArgsSchema.parse(['workspace-1', 'http://localhost:5173', bounds])
    ).toThrow();
    expect(() =>
      devPreviewSyncArgsSchema.parse([
        'workspace-1',
        'tab-1',
        'http://localhost:5173',
        { x: 0, y: 0, width: 0, height: 200 },
      ])
    ).toThrow();
  });

  it('validates hide, close and reload arguments', () => {
    expect(devPreviewHideArgsSchema.parse(['workspace-1', 'tab-1'])).toEqual([
      'workspace-1',
      'tab-1',
    ]);
    expect(devPreviewCloseArgsSchema.parse(['workspace-1', 'tab-1'])).toEqual([
      'workspace-1',
      'tab-1',
    ]);
    expect(() => devPreviewCloseArgsSchema.parse(['workspace-1'])).toThrow();
    expect(devPreviewReloadArgsSchema.parse(['workspace-1', 'tab-1', true])).toEqual([
      'workspace-1',
      'tab-1',
      true,
    ]);
    expect(devPreviewNavigateArgsSchema.parse(['workspace-1', 'tab-1', 'back'])).toEqual([
      'workspace-1',
      'tab-1',
      'back',
    ]);
    expect(() =>
      devPreviewNavigateArgsSchema.parse(['workspace-1', 'tab-1', 'sideways'])
    ).toThrow();
  });

  it('validates capture arguments', () => {
    expect(devPreviewCaptureArgsSchema.parse(['workspace-1', 'tab-1'])).toEqual([
      'workspace-1',
      'tab-1',
    ]);
    expect(() => devPreviewCaptureArgsSchema.parse(['workspace-1', 42])).toThrow();
    expect(() => devPreviewCaptureArgsSchema.parse(['workspace-1'])).toThrow();
  });

  it('accepts bounded lists of local, SSH host and own TCP ports for service detection', () => {
    expect(
      devPreviewDetectServicesArgsSchema.parse(['workspace-1', [3000, 5173], [8000], [5901]])
    ).toEqual(['workspace-1', [3000, 5173], [8000], [5901]]);
    expect(devPreviewDetectServicesArgsSchema.parse(['workspace-1', [], [], []])).toEqual([
      'workspace-1',
      [],
      [],
      [],
    ]);
  });

  it('rejects service detection ports outside the TCP range or past the limit', () => {
    for (const ports of [[0], [65536], [3000.5], ['3000'], Array.from({ length: 33 }, () => 80)]) {
      expect(() =>
        devPreviewDetectServicesArgsSchema.parse(['workspace-1', ports, [], []])
      ).toThrow();
      expect(() =>
        devPreviewDetectServicesArgsSchema.parse(['workspace-1', [], ports, []])
      ).toThrow();
      expect(() =>
        devPreviewDetectServicesArgsSchema.parse(['workspace-1', [], [], ports])
      ).toThrow();
    }
    expect(() => devPreviewDetectServicesArgsSchema.parse(['workspace-1', [], []])).toThrow();
  });
});
