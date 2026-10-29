import type { Workspace } from '@/types';
import type { ReactElement, ReactNode } from 'react';

/** Draws a surface pane's header: the drag handle, its title and a close button. */
export type SurfaceHeader = (
  title: ReactNode,
  options?: {
    icon?: ReactNode;
    actions?: ReactNode;
    titleTooltip?: string;
    /** The title is a tab strip, whose first tab meets the pane's left edge. */
    tabs?: boolean;
  }
) => ReactElement;

export interface SurfaceBodyProps {
  surfaceId: string;
  workspace: Workspace;
  isTabActive: boolean;
  isFocused: boolean;
  header: SurfaceHeader;
  /** The header's close button, for a surface that draws its own top row instead. */
  closeButton: ReactElement;
  onClose: () => void;
}
