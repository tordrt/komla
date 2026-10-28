import { useRef, useState, type DragEvent } from 'react';

import { openFolder } from '@/lib/open-folder';
import { useToastStore } from '@/stores/toast.store';

// Files from outside Komla. The sidebar's own drags, such as moving a workspace, carry other types.
const isFileDrag = (event: DragEvent) => event.dataTransfer.types.includes('Files');

/** The first folder dropped; dropped files have no folder to open. */
function droppedFolder(dataTransfer: DataTransfer): string | undefined {
  const items = Array.from(dataTransfer.items);
  const index = items.findIndex((item) => item.webkitGetAsEntry()?.isDirectory);
  const file = index >= 0 ? items[index].getAsFile() : null;
  return file ? window.api.getPathForFile(file) || undefined : undefined;
}

/** Opens a folder dropped on the element, as Open Folder opens a picked one. */
export function useFolderDrop() {
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  // dragenter and dragleave fire for every child the drag crosses.
  const depth = useRef(0);

  const onDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    depth.current += 1;
    setIsDraggingOver(true);
  };
  const onDragOver = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setIsDraggingOver(false);
  };
  const onDrop = (event: DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    depth.current = 0;
    setIsDraggingOver(false);
    const folder = droppedFolder(event.dataTransfer);
    if (folder) void openFolder(folder);
    else useToastStore.getState().addToast('Drop a folder to open it in Komla.', 'info');
  };

  return { isDraggingOver, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
