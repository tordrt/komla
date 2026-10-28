/** A settings file whose changes are recorded, so they can be undone from Settings. */
export type SettingsHistoryFile =
  | 'theme.json'
  | 'terminal.json'
  | 'shortcuts.json'
  | 'actions.json'
  | 'categories.json'
  | 'agent-presets.json'
  | 'projects.json'
  | 'status-items.json'
  | 'hooks.json';

/** One recorded change to a settings file, however it was made: in Komla, by an agent or by hand. */
export interface SettingsHistoryEntry {
  id: string;
  file: SettingsHistoryFile;
  /** When the change was last seen; changes to one file in quick succession make one entry. */
  at: number;
  /** The settings that changed, as dotted paths such as `colors.accent`; empty when unparseable. */
  changedKeys: string[];
  /** The id of the entry this change reverted. */
  revertOf?: string;
  /** How many later changes to the same file reverting this one also undoes. */
  laterChanges: number;
}
