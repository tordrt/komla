import { useSyncExternalStore } from 'react';

import {
  getKomlaEditorTheme,
  getMonacoThemeName,
  subscribeKomlaEditorTheme,
} from '@/lib/monaco-loader';

import type { TreeThemeInput } from '@pierre/trees';

export function useKomlaEditorTheme(): TreeThemeInput {
  return useSyncExternalStore(subscribeKomlaEditorTheme, getKomlaEditorTheme, getKomlaEditorTheme);
}

export function useMonacoThemeName(): string {
  return useSyncExternalStore(subscribeKomlaEditorTheme, getMonacoThemeName, getMonacoThemeName);
}
