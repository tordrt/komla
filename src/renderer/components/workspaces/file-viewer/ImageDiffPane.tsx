import { useState } from 'react';

import { useImageFrame, ZoomableImage, ZoomControls, type ImageZoom } from './ZoomableImage';

import type { FileChange } from '@/types';

interface ImageDiffPaneProps {
  oldImageData: string | null;
  newImageData: string | null;
  mimeType: string;
  status: FileChange['status'];
  fileName: string;
}

export function ImageDiffPane({
  oldImageData,
  newImageData,
  mimeType,
  status,
  fileName,
}: ImageDiffPaneProps) {
  // Both sides share one zoom so the same region stays side by side
  const [zoom, setZoom] = useState<ImageZoom>(null);
  const [shownData, setShownData] = useState({ oldImageData, newImageData });
  const oldFrame = useImageFrame();
  const newFrame = useImageFrame();

  if (shownData.oldImageData !== oldImageData || shownData.newImageData !== newImageData) {
    setShownData({ oldImageData, newImageData });
    setZoom(null);
  }

  const showOld = oldImageData && status !== 'added' && status !== 'untracked';
  const showNew = newImageData && status !== 'deleted';
  const isSingleSide = !showOld || !showNew;

  const oldLabel = status === 'deleted' ? 'Deleted' : 'Old';
  const newLabel = status === 'added' || status === 'untracked' ? 'Added' : 'New';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex min-h-0 flex-1 ${isSingleSide ? '' : 'gap-px'}`}>
        {showOld && (
          <ImageDiffSide
            label={oldLabel}
            frame={oldFrame}
            zoom={zoom}
            onZoomChange={setZoom}
            src={`data:${mimeType};base64,${oldImageData}`}
            alt={`${fileName} (old)`}
          />
        )}
        {showOld && showNew && <div className="w-px shrink-0 bg-border" />}
        {showNew && (
          <ImageDiffSide
            label={newLabel}
            frame={newFrame}
            zoom={zoom}
            onZoomChange={setZoom}
            src={`data:${mimeType};base64,${newImageData}`}
            alt={`${fileName} (new)`}
          />
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border bg-background px-3 py-1.5 text-xs text-muted-foreground">
        <ZoomControls frame={showNew ? newFrame : oldFrame} zoom={zoom} onZoomChange={setZoom} />
      </div>
    </div>
  );
}

function ImageDiffSide({
  label,
  frame,
  ...imageProps
}: { label: string } & React.ComponentProps<typeof ZoomableImage>) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <div className="border-b border-border bg-background px-3 py-1 text-xs font-medium text-muted-foreground">
        {label}
      </div>
      <ZoomableImage frame={frame} {...imageProps} />
      {frame.dimensions && (
        <div className="border-t border-border bg-background px-3 py-1 text-xs text-muted-foreground">
          {frame.dimensions.w} x {frame.dimensions.h}
        </div>
      )}
    </div>
  );
}
