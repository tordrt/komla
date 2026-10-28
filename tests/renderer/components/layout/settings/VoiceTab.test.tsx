/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const voice = vi.hoisted(() => ({
  models: [] as Array<Record<string, unknown>>,
  cancelDownload: vi.fn(),
}));

vi.mock('../../../../../src/renderer/stores/voice.store', () => ({
  useVoiceStore: () => ({
    models: voice.models,
    downloadingModelId: null,
    downloadProgress: null,
    loadModels: vi.fn(),
    selectModel: vi.fn(),
    downloadModel: vi.fn(),
    deleteModel: vi.fn(),
    cancelDownload: voice.cancelDownload,
  }),
}));

vi.mock('../../../../../src/renderer/stores/config.store', () => ({
  useConfigStore: (selector: (state: { config: null; updateConfig: () => void }) => unknown) =>
    selector({ config: null, updateConfig: vi.fn() }),
}));

vi.mock('../../../../../src/renderer/stores/shortcuts.store', () => ({
  useShortcutsStore: (
    selector: (state: { getShortcut: () => string; getDisplayShortcut: () => string }) => unknown
  ) => selector({ getShortcut: () => 'Cmd+Shift+V', getDisplayShortcut: () => '⌘⇧V' }),
  isDoubleTapShortcut: () => false,
  getDoubleTapKey: () => null,
}));

import { VoiceTab } from '../../../../../src/renderer/components/layout/settings/VoiceTab';

function model(id: string, status: string, isCurrent: boolean) {
  return {
    id,
    name: id,
    description: '',
    sizeMB: 100,
    runtimeMemoryMB: '~200 MB',
    status,
    isCurrent,
  };
}

describe('VoiceTab', () => {
  beforeEach(() => {
    voice.models = [];
  });

  it('asks for a download while only a model other than the current one is downloaded', () => {
    voice.models = [model('v3', 'not-downloaded', true), model('small', 'ready', false)];
    render(<VoiceTab />);

    expect(screen.getByText(/Download a model to start dictating/)).toBeInTheDocument();
    expect(screen.getByText(/Download a model below, then/)).toBeInTheDocument();
  });

  it('says how to record once the current model is downloaded', () => {
    voice.models = [model('v3', 'ready', true)];
    render(<VoiceTab />);

    expect(screen.queryByText(/Download a model/)).not.toBeInTheDocument();
    expect(screen.getByText('In use')).toBeInTheDocument();
  });

  it('can cancel a download in progress', () => {
    voice.models = [model('v3', 'downloading', true)];
    render(<VoiceTab />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(voice.cancelDownload).toHaveBeenCalled();
  });
});
