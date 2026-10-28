import { useState, useRef, useCallback } from 'react';

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { useToastStore } from '@/stores/toast.store';

import { useImageFrame, ZoomableImage, ZoomControls, type ImageZoom } from './ZoomableImage';

interface ImagePaneProps {
  data: string;
  mimeType: string;
  fileName: string;
}

export function ImagePane({ data, mimeType, fileName }: ImagePaneProps) {
  const [zoom, setZoom] = useState<ImageZoom>(null);
  const [shownData, setShownData] = useState(data);
  const frame = useImageFrame();
  const imgRef = useRef<HTMLImageElement>(null);

  // Reset zoom when image data changes
  if (shownData !== data) {
    setShownData(data);
    setZoom(null);
  }

  const copyImage = useCallback(async () => {
    try {
      const img = imgRef.current;
      if (!img) return;
      // Draw image to canvas to get a Blob for the clipboard
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) return;
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      useToastStore.getState().addToast('Copied image to clipboard', 'success');
    } catch {
      useToastStore.getState().addToast('Failed to copy image', 'error');
    }
  }, []);

  const fileSize = Math.ceil((data.length * 3) / 4); // approximate decoded size from base64

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="flex min-h-0 flex-1 flex-col">
            <ZoomableImage
              frame={frame}
              zoom={zoom}
              onZoomChange={setZoom}
              src={`data:${mimeType};base64,${data}`}
              alt={fileName}
              imgRef={imgRef}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onClick={() => void copyImage()}>Copy Image</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <div className="flex items-center gap-3 border-t border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
        {frame.dimensions && (
          <span>
            {frame.dimensions.w} x {frame.dimensions.h}
          </span>
        )}
        <span>{formatFileSize(fileSize)}</span>
        <ZoomControls frame={frame} zoom={zoom} onZoomChange={setZoom} />
      </div>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
