import { useEffect, useState } from 'react';

import { readIconColors } from '@/lib/icon-colors';

const NONE: string[] = [];

/**
 * The colors of an icon's data URL, most of the icon first. Empty while reading, for no icon,
 * and for an icon in gray or black and white only.
 */
export function useIconColors(icon: string): string[] {
  const [read, setRead] = useState<{ icon: string; colors: string[] }>();

  useEffect(() => {
    if (!icon) return;
    let cancelled = false;
    readIconColors(icon)
      .then((colors) => {
        if (!cancelled) setRead({ icon, colors });
      })
      .catch((err) => console.error('Failed to read the icon colors:', err));
    return () => {
      cancelled = true;
    };
  }, [icon]);

  // Another icon's colors never show while this one's are read.
  return icon && read?.icon === icon ? read.colors : NONE;
}
