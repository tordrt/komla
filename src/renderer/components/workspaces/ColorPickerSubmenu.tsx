import { Palette } from '@phosphor-icons/react';
import React from 'react';

import {
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from '@/components/ui/context-menu';
import { PROJECT_COLORS } from '@/lib/project-colors';
import { cn } from '@/lib/utils';

interface ColorSwatchGridProps {
  currentColor: string | null | undefined;
  onColorChange: (color: string) => void;
  className?: string;
}

export function ColorSwatchGrid({ currentColor, onColorChange, className }: ColorSwatchGridProps) {
  return (
    <div className={cn('flex gap-1.5', className)}>
      {PROJECT_COLORS.map((color, index) => (
        <button
          key={color}
          type="button"
          aria-label={`Color ${index + 1}`}
          aria-pressed={color === currentColor}
          className={cn(
            'size-5 rounded-full border-2 transition-transform hover:scale-110',
            color === currentColor ? 'border-white ring-2 ring-white/20' : 'border-transparent'
          )}
          style={{ backgroundColor: color }}
          onClick={() => onColorChange(color)}
        />
      ))}
    </div>
  );
}

interface ColorPickerSubmenuProps {
  currentColor: string | null | undefined;
  onColorChange: (color: string) => void;
}

export function ColorPickerSubmenu({ currentColor, onColorChange }: ColorPickerSubmenuProps) {
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <Palette />
        Color
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ColorSwatchGrid
          currentColor={currentColor}
          onColorChange={onColorChange}
          className="p-2"
        />
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
