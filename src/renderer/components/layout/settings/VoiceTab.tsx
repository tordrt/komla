import { useEffect } from 'react';

import { SettingsCard } from '@/components/layout/settings/SettingsCard';
import { SettingsRow } from '@/components/layout/settings/SettingsRow';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useConfigStore } from '@/stores/config.store';
import { getDoubleTapKey, isDoubleTapShortcut, useShortcutsStore } from '@/stores/shortcuts.store';
import { useVoiceStore } from '@/stores/voice.store';

export function VoiceTab() {
  const config = useConfigStore((s) => s.config);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  const voiceShortcutRaw = useShortcutsStore((s) => s.getShortcut('voice.record'));
  const voiceShortcutDisplay = useShortcutsStore((s) => s.getDisplayShortcut('voice.record'));

  const {
    models,
    downloadingModelId,
    downloadProgress,
    loadModels,
    selectModel,
    downloadModel,
    deleteModel,
    cancelDownload,
  } = useVoiceStore();

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // Dictation uses the current model, so another downloaded model doesn't make it ready.
  const hasReadyModel = models.some((model) => model.isCurrent && model.status === 'ready');

  return (
    <div className="space-y-6">
      <SettingsCard
        title="Voice input"
        description={
          <>
            Dictate prompts instead of typing
            {hasReadyModel ? ':' : '. Download a model below, then'}{' '}
            <VoiceShortcutHint raw={voiceShortcutRaw} display={voiceShortcutDisplay} /> to record in
            any terminal or the new workspace dialog.{' '}
            <button
              type="button"
              onClick={() =>
                window.dispatchEvent(new CustomEvent('open-settings', { detail: 'shortcuts' }))
              }
              className="font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:decoration-foreground"
            >
              Change shortcut
            </button>
          </>
        }
      >
        <SettingsRow
          label="Auto-record in workspace dialog"
          description="Start recording when the workspace dialog opens. Typing cancels it; Enter or the shortcut transcribes."
        >
          <Switch
            checked={config?.voice?.autoRecord === true}
            onCheckedChange={(checked) =>
              void updateConfig({
                voice: {
                  ...config?.voice,
                  modelId: config?.voice?.modelId ?? 'parakeet-tdt-0.6b-v3-int8',
                  modelPath: config?.voice?.modelPath ?? null,
                  enabled: config?.voice?.enabled ?? false,
                  autoRecord: checked,
                  transcribeAction: 'fill',
                },
              })
            }
          />
        </SettingsRow>
      </SettingsCard>

      <SettingsCard
        title="Transcription model"
        description={
          hasReadyModel
            ? 'Speech-to-text runs on this computer. Memory use is approximate and varies by machine.'
            : 'Download a model to start dictating. Speech-to-text runs on this computer.'
        }
      >
        {models.length === 0 && (
          <p className="text-[13px] text-muted-foreground">Loading models…</p>
        )}
        <VoiceModelList
          models={models}
          downloadingModelId={downloadingModelId}
          downloadProgress={downloadProgress}
          onDownload={downloadModel}
          onCancelDownload={cancelDownload}
          onSelect={selectModel}
          onDelete={deleteModel}
        />
      </SettingsCard>
    </div>
  );
}

type VoiceModelStatus =
  | 'unknown'
  | 'not-downloaded'
  | 'downloading'
  | 'extracting'
  | 'ready'
  | 'error';

interface VoiceModelListItem {
  id: string;
  name: string;
  description: string;
  sizeMB: number;
  runtimeMemoryMB: string;
  status: VoiceModelStatus;
  isCurrent: boolean;
}

interface VoiceModelListProps {
  models: VoiceModelListItem[];
  downloadingModelId: string | null;
  downloadProgress: { percent: number } | null;
  onDownload: (id: string) => Promise<void>;
  onCancelDownload: () => Promise<void>;
  onSelect: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function VoiceModelList(props: VoiceModelListProps) {
  // Derive the in-flight model from authoritative status as well as the local
  // downloadingModelId — the latter is null after a renderer reload mid-download.
  const inFlightModel = props.models.find(
    (m) => m.status === 'downloading' || m.status === 'extracting'
  );
  const inFlightId = props.downloadingModelId ?? inFlightModel?.id ?? null;
  return (
    <>
      {props.models.map((model) => (
        <VoiceModelRow
          key={model.id}
          model={model}
          isDownloading={inFlightId === model.id}
          anotherDownloading={inFlightId !== null && inFlightId !== model.id}
          downloadProgress={props.downloadProgress}
          onDownload={props.onDownload}
          onCancelDownload={props.onCancelDownload}
          onSelect={props.onSelect}
          onDelete={props.onDelete}
        />
      ))}
    </>
  );
}

interface VoiceModelRowProps {
  model: VoiceModelListItem;
  isDownloading: boolean;
  anotherDownloading: boolean;
  downloadProgress: { percent: number } | null;
  onDownload: (id: string) => Promise<void>;
  onCancelDownload: () => Promise<void>;
  onSelect: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function VoiceModelRow({
  model,
  isDownloading,
  anotherDownloading,
  downloadProgress,
  onDownload,
  onCancelDownload,
  onSelect,
  onDelete,
}: VoiceModelRowProps) {
  const showProgress = isDownloading && downloadProgress;
  const inUse = model.isCurrent && model.status === 'ready';
  return (
    <div className="flex items-center gap-3 !py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{model.name}</span>
          {inUse && <Badge tone="primary">In use</Badge>}
          {model.status === 'ready' && !inUse && <Badge tone="success">Downloaded</Badge>}
          {model.status === 'error' && <Badge tone="error">Error</Badge>}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{model.description}</p>
        <p className="text-xs text-muted-foreground/80">
          ~{model.sizeMB} MB download · {model.runtimeMemoryMB} memory while transcribing
        </p>{' '}
        {showProgress && (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 w-32 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${downloadProgress.percent}%` }}
              />
            </div>
            <span className="text-2xs text-muted-foreground tabular-nums">
              {Math.round(downloadProgress.percent)}%
            </span>
          </div>
        )}
        {model.status === 'extracting' && (
          <div className="mt-1">
            <span className="text-2xs text-muted-foreground">
              <Spinner size="xs" className="mr-1 inline" />
              Extracting...
            </span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {model.status === 'not-downloaded' && !isDownloading && !anotherDownloading && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void onDownload(model.id)}
          >
            Download
          </Button>
        )}
        {model.status === 'downloading' && isDownloading && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => void onCancelDownload()}
          >
            Cancel
          </Button>
        )}
        {model.status === 'error' && !anotherDownloading && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void onDownload(model.id)}
          >
            Retry
          </Button>
        )}
        {model.status === 'ready' && !model.isCurrent && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => void onSelect(model.id)}
          >
            Use
          </Button>
        )}
        {model.status === 'ready' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground hover:text-destructive"
            onClick={() => void onDelete(model.id)}
          >
            Delete
          </Button>
        )}
      </div>
    </div>
  );
}

const isMacPlatform = typeof window !== 'undefined' && window.api?.platform === 'darwin';

const DOUBLE_TAP_KEY_SYMBOL: Record<string, { mac: string; other: string }> = {
  Shift: { mac: '⇧', other: 'Shift' },
  Meta: { mac: '⌘', other: 'Meta' },
  Ctrl: { mac: '⌃', other: 'Ctrl' },
  Alt: { mac: '⌥', other: 'Alt' },
};

function VoiceShortcutHint({ raw, display }: { raw: string | null; display: string }) {
  if (!raw) {
    return <span className="font-medium text-foreground">set a shortcut</span>;
  }

  if (isDoubleTapShortcut(raw)) {
    const key = getDoubleTapKey(raw);
    const symbolEntry = key ? DOUBLE_TAP_KEY_SYMBOL[key] : undefined;
    const symbol = symbolEntry
      ? isMacPlatform
        ? symbolEntry.mac
        : symbolEntry.other
      : (key ?? '');
    return (
      <>
        <span className="font-medium text-foreground">double-press</span>{' '}
        <Kbd className="mx-0.5">{symbol}</Kbd>
      </>
    );
  }

  return (
    <>
      press <Kbd className="mx-0.5">{display}</Kbd>
    </>
  );
}
