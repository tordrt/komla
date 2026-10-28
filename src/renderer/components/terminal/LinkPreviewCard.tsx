import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLinkPreviewImage } from '@/hooks/useLinkPreviews';

import type { LinkPreview } from '../../../shared/types';
import type { ReactElement } from 'react';

/** The site's icon, sized for a list row. */
export function LinkPreviewIcon({ preview }: { preview: LinkPreview | undefined }) {
  if (!preview?.iconDataUrl) return null;
  return <img src={preview.iconDataUrl} alt="" className="size-3.5 shrink-0 rounded-sm" />;
}

function LinkPreviewCard({ url, preview }: { url: string; preview: LinkPreview }) {
  const image = useLinkPreviewImage(preview.imageUrl);
  return (
    <div className="flex flex-col">
      {preview.imageUrl &&
        image !== null &&
        (image ? (
          <img src={image} alt="" className="aspect-[1.91/1] w-full border-b object-cover" />
        ) : (
          <div className="flex aspect-[1.91/1] w-full items-center justify-center border-b bg-muted/40">
            <Spinner size="xs" />
          </div>
        ))}
      <div className="flex flex-col gap-1 p-2.5">
        {preview.siteName && (
          <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <LinkPreviewIcon preview={preview} />
            <span className="truncate">{preview.siteName}</span>
          </div>
        )}
        {preview.title && (
          <div className="line-clamp-2 text-xs font-medium text-foreground">{preview.title}</div>
        )}
        {preview.description && (
          <div className="line-clamp-3 text-2xs text-muted-foreground">{preview.description}</div>
        )}
        <div className="truncate font-mono text-2xs text-muted-foreground">{url}</div>
      </div>
    </div>
  );
}

/**
 * Shows the page's og:image and description beside a link row on hover. A row
 * whose page has neither keeps just the row.
 */
export function LinkPreviewHoverCard({
  url,
  preview,
  children,
}: {
  url: string;
  preview: LinkPreview | undefined;
  children: ReactElement;
}) {
  if (!preview?.imageUrl && !preview?.description) return children;
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="left" align="start" sideOffset={12} className="w-72 p-0">
        <LinkPreviewCard url={url} preview={preview} />
      </TooltipContent>
    </Tooltip>
  );
}
