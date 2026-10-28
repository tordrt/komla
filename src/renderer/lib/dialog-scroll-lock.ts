import type { WheelEventHandler } from 'react';

/**
 * For menus portalled out of a modal dialog: the dialog's scroll lock would
 * otherwise swallow their wheel and touchpad scrolling.
 */
export const stopWheelPropagation: WheelEventHandler = (event) => event.stopPropagation();
