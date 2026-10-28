import { statusItemColorProps } from '@/lib/status-item-color';
import { cn } from '@/lib/utils';

/**
 * An image icon Komla's main process checked, as a data URL. With a status item color, its shape
 * shows in that color, so a one-color logo follows the theme; without, it keeps its own colors.
 */
export function CheckedIcon({
  src,
  color,
  className,
}: {
  src: string;
  color?: string;
  className?: string;
}) {
  if (!color) return <img src={src} alt="" draggable={false} className={className} />;
  const colors = statusItemColorProps(color);
  const mask = `url("${src}") center / contain no-repeat`;
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block bg-current', className, colors.className)}
      style={{ ...colors.style, mask, WebkitMask: mask }}
    />
  );
}
