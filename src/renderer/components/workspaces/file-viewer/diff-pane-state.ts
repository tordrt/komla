import type { FileDiffContent } from '@/types';

export function hasRenderableTextDiff(fileContent: FileDiffContent): boolean {
  return fileContent.oldContent !== null || fileContent.newContent !== null;
}

export function shouldShowDiffLoadingPlaceholder(params: {
  fileContent: FileDiffContent | null;
  loadingFile: boolean;
}): boolean {
  const { fileContent, loadingFile } = params;
  return (
    loadingFile && (!fileContent || (!fileContent.isBinary && !hasRenderableTextDiff(fileContent)))
  );
}

export function shouldShowMissingDiffPanel(params: {
  fileContent: FileDiffContent | null;
  selectedFile: string | null;
  loadingFile: boolean;
}): boolean {
  const { fileContent, selectedFile, loadingFile } = params;
  const path = fileContent?.path ?? selectedFile;
  if (!path) return false;
  if (loadingFile) return false;
  return !!fileContent && !fileContent.isBinary && !hasRenderableTextDiff(fileContent);
}
