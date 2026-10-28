import { MagnifyingGlassMinus, MagnifyingGlassPlus } from '@phosphor-icons/react';
import { useEffect, useEffectEvent, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';

import {
  centeredView,
  clampView,
  fitView,
  panBy,
  stepScale,
  wheelZoomFactor,
  zoomTo,
  type ImageView,
  type Size,
} from './image-zoom';

/** null fits the image to its viewport, refitting as it resizes. */
export type ImageZoom = ImageView | null;

type Point = { x: number; y: number };

/** The viewport and image sizes one zoomable image is laid out from. */
export interface ImageFrame {
  element: HTMLDivElement | null;
  ref: (element: HTMLDivElement | null) => void;
  viewport: Size | null;
  dimensions: Size | null;
  handleImageLoad: (e: React.SyntheticEvent<HTMLImageElement>) => void;
}

export function useImageFrame(): ImageFrame {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<Size | null>(null);
  const [dimensions, setDimensions] = useState<Size | null>(null);

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport({ w: element.clientWidth, h: element.clientHeight })
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  return {
    element,
    ref: setElement,
    viewport,
    dimensions,
    handleImageLoad: (e) => {
      const img = e.currentTarget;
      setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    },
  };
}

export function frameView({ viewport, dimensions }: ImageFrame, zoom: ImageZoom) {
  if (!viewport || !dimensions) return null;
  return zoom ? clampView(zoom, viewport, dimensions) : fitView(viewport, dimensions);
}

/** Zooms to `scale` around `anchor`, or the viewport's center. */
function zoomFrame(frame: ImageFrame, zoom: ImageZoom, scale: number, anchor?: Point) {
  const view = frameView(frame, zoom);
  const { viewport, dimensions } = frame;
  if (!view || !viewport || !dimensions) return null;
  const point = anchor ?? { x: viewport.w / 2, y: viewport.h / 2 };
  return zoomTo(view, scale, point, viewport, dimensions);
}

function actualSize({ viewport, dimensions }: ImageFrame) {
  return viewport && dimensions ? centeredView(1, viewport, dimensions) : null;
}

const checkerboardStyle = {
  backgroundImage: `
    linear-gradient(45deg, oklch(var(--muted)) 25%, transparent 25%),
    linear-gradient(-45deg, oklch(var(--muted)) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, oklch(var(--muted)) 75%),
    linear-gradient(-45deg, transparent 75%, oklch(var(--muted)) 75%)
  `,
  backgroundSize: '20px 20px',
  backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
};

interface ZoomableImageProps {
  frame: ImageFrame;
  zoom: ImageZoom;
  onZoomChange: (zoom: ImageZoom) => void;
  src: string;
  alt: string;
  imgRef?: React.Ref<HTMLImageElement>;
}

/**
 * An image on a transparency checkerboard. Pinch and Ctrl/Cmd+wheel zoom toward
 * the cursor, scrolling and dragging pan, double-click toggles fit and 100%, and
 * +, -, 0 and 1 zoom from the keyboard.
 */
export function ZoomableImage({ frame, zoom, onZoomChange, src, alt, imgRef }: ZoomableImageProps) {
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number; view: ImageView } | null>(null);
  const { element, viewport, dimensions } = frame;
  const view = frameView(frame, zoom);
  const canPan =
    !!view &&
    !!viewport &&
    !!dimensions &&
    (dimensions.w * view.scale > viewport.w + 0.5 || dimensions.h * view.scale > viewport.h + 0.5);

  const zoomAround = (scale: number, anchor?: Point) => {
    const next = zoomFrame(frame, zoom, scale, anchor);
    if (next) onZoomChange(next);
  };

  // Pinch and Ctrl/Cmd+wheel zoom toward the cursor; plain scrolling pans
  const handleWheel = useEffectEvent((e: WheelEvent) => {
    e.preventDefault();
    if (!view || !viewport || !dimensions) return;
    if (e.ctrlKey || e.metaKey) {
      zoomAround(view.scale * wheelZoomFactor(e.deltaY), pointIn(element, e));
    } else if (canPan) {
      onZoomChange(panBy(view, -e.deltaX, -e.deltaY, viewport, dimensions));
    }
  });

  // React's wheel listeners are passive, so preventDefault needs a native one
  useEffect(() => {
    if (!element) return;
    const onWheel = (e: WheelEvent) => handleWheel(e);
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [element]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !canPan || !view) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = { x: e.clientX, y: e.clientY, view };
    setDragging(true);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const start = dragStart.current;
    if (!start || !viewport || !dimensions) return;
    onZoomChange(panBy(start.view, e.clientX - start.x, e.clientY - start.y, viewport, dimensions));
  };

  const handlePointerUp = () => {
    dragStart.current = null;
    setDragging(false);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    if (!view) return;
    if (zoom) onZoomChange(null);
    else zoomAround(view.scale < 1 ? 1 : 2, pointIn(element, e));
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!view || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomAround(stepScale(view.scale, 1));
    else if (e.key === '-') zoomAround(stepScale(view.scale, -1));
    else if (e.key === '0') onZoomChange(null);
    else if (e.key === '1') onZoomChange(actualSize(frame));
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={frame.ref}
      role="group"
      aria-label={`${alt} image viewer`}
      tabIndex={0}
      className="relative min-h-0 flex-1 overflow-hidden outline-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      style={{
        cursor: canPan ? (dragging ? 'grabbing' : 'grab') : 'default',
        ...checkerboardStyle,
      }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className="absolute top-0 left-0 max-w-none select-none"
        draggable={false}
        onLoad={frame.handleImageLoad}
        style={
          view && dimensions
            ? {
                width: dimensions.w,
                height: dimensions.h,
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
                transformOrigin: '0 0',
              }
            : { opacity: 0 }
        }
      />
    </div>
  );
}

interface ZoomControlsProps {
  frame: ImageFrame;
  zoom: ImageZoom;
  onZoomChange: (zoom: ImageZoom) => void;
}

/** Zoom out, the zoom level, zoom in, Fit and 1:1, zooming around the center of `frame`. */
export function ZoomControls({ frame, zoom, onZoomChange }: ZoomControlsProps) {
  const scale = frameView(frame, zoom)?.scale ?? 1;
  const zoomStep = (direction: 1 | -1) => {
    const next = zoomFrame(frame, zoom, stepScale(scale, direction));
    if (next) onZoomChange(next);
  };

  return (
    <div className="ml-auto flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1"
        aria-label="Zoom out"
        title="Zoom out (-)"
        onClick={() => zoomStep(-1)}
      >
        <MagnifyingGlassMinus className="size-3.5" />
      </Button>
      <span className="w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1"
        aria-label="Zoom in"
        title="Zoom in (+)"
        onClick={() => zoomStep(1)}
      >
        <MagnifyingGlassPlus className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-xs"
        title="Fit to window (0)"
        disabled={!zoom}
        onClick={() => onZoomChange(null)}
      >
        Fit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 px-1.5 text-xs"
        title="Actual size (1)"
        disabled={scale === 1}
        onClick={() => onZoomChange(actualSize(frame))}
      >
        1:1
      </Button>
    </div>
  );
}

function pointIn(element: HTMLElement | null, e: { clientX: number; clientY: number }) {
  const rect = element?.getBoundingClientRect();
  return rect ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : undefined;
}
