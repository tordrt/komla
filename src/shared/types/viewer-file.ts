/** Where the file viewer reads a file from: the workspace, or wherever the terminal that printed it runs. */
export type ViewerFileSource =
  | { kind: 'workspace'; filePath: string }
  | { kind: 'terminal'; fullPath: string };

export interface ViewerFile {
  /** The file's bytes, base64-encoded. */
  data: string;
  mimeType: string;
}

/** A folder, or a file the file viewer can show, from a listing of their folder. */
export interface ViewerFolderFile {
  /** The entry's name, ending in a slash for a folder. */
  name: string;
  /** When the file was last modified, in milliseconds since the epoch, if known. */
  modifiedMs?: number;
}
