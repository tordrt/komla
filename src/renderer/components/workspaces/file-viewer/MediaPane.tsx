import { Play, WarningCircle } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface MediaPaneProps {
  data: string | null;
  mimeType: string;
  kind: 'audio' | 'video';
  fileName: string;
  fileSize?: number | null;
  loading?: boolean;
  error?: string | null;
  onLoadPreview?: () => void;
}

export function MediaPane({
  data,
  mimeType,
  kind,
  fileName,
  fileSize,
  loading = false,
  error = null,
  onLoadPreview,
}: MediaPaneProps) {
  const src = data ? `data:${mimeType};base64,${data}` : null;

  if (!src) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-8">
        <div className="flex max-w-md flex-col items-center gap-3 text-center">
          <div className="text-sm font-medium text-foreground">{fileName}</div>
          <div className="text-xs text-muted-foreground">
            {kind === 'audio' ? 'Audio' : 'Video'} · {formatFileSize(fileSize)}
          </div>
          {error && (
            <div className="flex items-center gap-1.5 text-xs text-error">
              <WarningCircle className="size-4" />
              <span>{error}</span>
            </div>
          )}
          <Button
            type="button"
            size="sm"
            onClick={onLoadPreview}
            disabled={loading || !onLoadPreview}
          >
            {loading ? <Spinner className="mr-1.5" /> : <Play className="mr-1.5 size-4" />}
            Load Preview
          </Button>
        </div>
      </div>
    );
  }

  if (kind === 'audio') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-8">
        <audio controls className="w-full max-w-2xl" src={src}>
          <track kind="captions" />
        </audio>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      <video controls className="max-h-full max-w-full" src={src} title={fileName}>
        <track kind="captions" />
      </video>
    </div>
  );
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
