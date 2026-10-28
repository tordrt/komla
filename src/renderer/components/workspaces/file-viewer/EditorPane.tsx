import Editor from '@monaco-editor/react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useMonacoThemeName } from '@/hooks/useKomlaEditorTheme';
import { editorFontSize, KOMLA_EDITOR_BASE_OPTIONS } from '@/lib/monaco-loader';
import { addMonacoShortcutForwarding } from '@/lib/monaco-shortcut-forwarding';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/config.store';
import { useCustomizationStore } from '@/stores/customization.store';

import { BlameGutter } from './BlameGutter';
import {
  computeReloadEdit,
  detectEndOfLine,
  getFileLanguage,
  getShikiLanguage,
  hasBuiltInLanguageIntelligence,
} from './file-viewer-utils';

import type { BlameLineMap } from './useBlameState';
import type { BlameHunk } from '@/types';
import type { editor as monacoEditor } from 'monaco-editor';

const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1 MB

// monaco.editor.EndOfLineSequence's values; this file imports only Monaco's types.
const END_OF_LINE_SEQUENCE: Record<'\n' | '\r\n', monacoEditor.EndOfLineSequence> = {
  '\n': 0,
  '\r\n': 1,
};

// monaco-vim exposes its Vim API on VimMode at runtime but leaves it out of its types.
interface VimApi {
  defineEx(
    name: string,
    prefix: string,
    run: (cm: { editor: monacoEditor.ICodeEditor }) => void
  ): void;
}

interface EditorPaneProps {
  filePath: string | null;
  fileContent: string | null;
  loading: boolean;
  error: string | null;
  missingOnDisk?: boolean;
  onChange?: (content: string) => void;
  onMount?: (editor: monacoEditor.IStandaloneCodeEditor) => void;
  onCloseMissing?: () => void;
  readOnly?: boolean;
  blameEnabled?: boolean;
  blameAnnotations?: BlameHunk[];
  blameLineMap?: BlameLineMap;
  blameLoading?: boolean;
  onBlameHunkClick?: (hunk: BlameHunk) => void;
  onBlameHide?: () => void;
}

export function EditorPane({
  filePath,
  fileContent,
  loading,
  error,
  missingOnDisk = false,
  onChange,
  onMount,
  onCloseMissing,
  readOnly = false,
  blameEnabled = false,
  blameAnnotations,
  blameLineMap,
  blameLoading = false,
  onBlameHunkClick,
  onBlameHide,
}: EditorPaneProps) {
  const monacoLanguage = filePath ? getFileLanguage(filePath) : 'plaintext';
  const editorLanguage =
    filePath && monacoLanguage !== 'plaintext'
      ? getShikiLanguage(filePath, monacoLanguage)
      : monacoLanguage;
  const [editorInstance, setEditorInstance] = useState<monacoEditor.IStandaloneCodeEditor | null>(
    null
  );
  const [forceLargeFile, setForceLargeFile] = useState(false);
  const vimModeEnabled = useConfigStore((s) => s.config?.vimModeEnabled === true);
  const vimModeRef = useRef<{ dispose: () => void } | null>(null);
  const vimStatusRef = useRef<HTMLDivElement>(null);
  const editorWrapperRef = useRef<HTMLDivElement>(null);
  const [vimAttached, setVimAttached] = useState(false);
  const monacoThemeName = useMonacoThemeName();

  // One character wider than the largest line number, so numbers don't touch the left edge.
  // This runs on every keystroke, so it counts line breaks instead of splitting the text.
  const lineNumbersMinChars = useMemo(() => {
    if (!fileContent) return 2;
    let lineCount = 1;
    for (let at = fileContent.indexOf('\n'); at !== -1; at = fileContent.indexOf('\n', at + 1)) {
      lineCount++;
    }
    return String(lineCount).length + 1;
  }, [fileContent]);

  const fontSize = useCustomizationStore((state) =>
    editorFontSize(state.terminalConfig?.font.size)
  );

  // A new options object makes the wrapper call updateOptions, so build one only on change.
  const editorOptions = useMemo<monacoEditor.IStandaloneEditorConstructionOptions>(
    () => ({
      ...KOMLA_EDITOR_BASE_OPTIONS,
      fontSize,
      readOnly,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbers: 'on',
      lineNumbersMinChars,
      lineDecorationsWidth: 8,
      glyphMargin: false,
      folding: true,
      wordWrap: 'on',
      automaticLayout: true,
      renderValidationDecorations: hasBuiltInLanguageIntelligence(monacoLanguage) ? 'on' : 'off',
      padding: { top: 16, bottom: 12 },
      stickyScroll: {
        enabled: true,
        maxLineCount: 3,
      },
    }),
    [fontSize, readOnly, lineNumbersMinChars, monacoLanguage]
  );

  const handleBeforeMount = useCallback((monaco: typeof import('monaco-editor')) => {
    // Disable TypeScript/JavaScript semantic validation for performance
    monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
    monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
      noSemanticValidation: true,
      noSyntaxValidation: true,
    });
  }, []);

  // The `fileContent` the model last matched, typed or applied, so the editor's own edits
  // coming back as `fileContent` are skipped. Null while the model holds the text it mounted with.
  const syncedContentRef = useRef<string | null>(null);
  const applyingFileContentRef = useRef(false);

  const handleChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined || applyingFileContentRef.current) return;
      syncedContentRef.current = value;
      onChange?.(value);
    },
    [onChange]
  );

  // New content from outside the editor, such as an agent rewriting the file. Apply just the
  // changed lines to the live model: given a new `value`, @monaco-editor/react replaces all of
  // the text (or calls setValue when read-only), which loses the cursor, scroll, folds and undo.
  useLayoutEffect(() => {
    const model = editorInstance?.getModel();
    if (!model || fileContent === null || fileContent === syncedContentRef.current) return;
    const mountedText = syncedContentRef.current === null;
    syncedContentRef.current = fileContent;
    const detectedEol = detectEndOfLine(fileContent);
    // Line comparison can't see a file rewritten with other line endings.
    const newEol = detectedEol !== model.getEOL() ? detectedEol : null;
    const edit = computeReloadEdit(model, fileContent, newEol ?? model.getEOL());
    if (!edit && !newEol) return;
    applyingFileContentRef.current = true;
    try {
      if (mountedText) {
        // Nothing to keep yet, such as the empty text mounted while the file couldn't be read.
        model.setValue(fileContent);
      } else {
        model.pushStackElement();
        if (newEol) model.pushEOL(END_OF_LINE_SEQUENCE[newEol]);
        if (edit) model.pushEditOperations([], [edit], () => null);
        model.pushStackElement();
      }
    } finally {
      applyingFileContentRef.current = false;
    }
  }, [editorInstance, fileContent]);

  const handleMount = useCallback(
    (editor: monacoEditor.IStandaloneCodeEditor) => {
      syncedContentRef.current = null;
      setEditorInstance(editor);
      addMonacoShortcutForwarding(editor);
      onMount?.(editor);
    },
    [onMount]
  );

  // Vim mode lifecycle: attach/detach when setting or editor instance changes
  useEffect(() => {
    if (!editorInstance || !vimModeEnabled) {
      if (vimModeRef.current) {
        vimModeRef.current.dispose();
        vimModeRef.current = null;
      }
      setVimAttached(false);
      return;
    }

    let disposed = false;
    // Escape leaves insert mode in vim and does nothing in normal mode, where vim passes it on.
    // Stop it once Monaco has had it, so the file viewer or inline preview around it stays open.
    const editorWrapper = editorWrapperRef.current;
    const keepEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.stopPropagation();
    };
    import('monaco-vim')
      .then(({ initVimMode, VimMode }) => {
        if (disposed) return;
        // :w runs the editor's Save action, registered by whichever surface hosts it.
        (VimMode as unknown as { Vim: VimApi }).Vim.defineEx('write', 'w', (cm) => {
          void cm.editor.getAction('save-file')?.run();
        });
        // Dispose any existing instance before creating a new one
        vimModeRef.current?.dispose();
        vimModeRef.current = initVimMode(editorInstance, vimStatusRef.current);
        editorWrapper?.addEventListener('keydown', keepEscape);
        setVimAttached(true);
      })
      .catch((err) => {
        console.warn('Failed to load monaco-vim:', err);
        setVimAttached(false);
      });

    return () => {
      disposed = true;
      editorWrapper?.removeEventListener('keydown', keepEscape);
      if (vimModeRef.current) {
        vimModeRef.current.dispose();
        vimModeRef.current = null;
      }
      setVimAttached(false);
    };
  }, [editorInstance, vimModeEnabled]);

  // Initialization failures leave Monaco unready; do not hide them behind loading.
  if (loading && !error) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner size="lg" className="mr-2 size-5" />
        Loading...
      </div>
    );
  }

  if (error) {
    return <div className="flex flex-1 items-center justify-center text-error">{error}</div>;
  }

  if (!filePath) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        No file selected
      </div>
    );
  }

  if (missingOnDisk) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <div className="text-sm font-medium text-foreground">File deleted or moved</div>
        <div className="max-w-md text-center font-mono text-xs">{filePath}</div>
        {onCloseMissing && (
          <Button variant="outline" size="sm" onClick={onCloseMissing}>
            Close Tab
          </Button>
        )}
      </div>
    );
  }

  if (fileContent && fileContent.length > LARGE_FILE_THRESHOLD && !forceLargeFile) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <span>Large file ({(fileContent.length / 1024 / 1024).toFixed(1)} MB)</span>
        <span className="text-sm">Editor rendering may be slow</span>
        <Button variant="outline" size="sm" onClick={() => setForceLargeFile(true)}>
          Load Anyway
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        {blameEnabled && (
          <BlameGutter
            editor={editorInstance}
            blameLineMap={blameLineMap ?? new Map()}
            blameAnnotations={blameAnnotations ?? []}
            onHunkClick={onBlameHunkClick ?? (() => {})}
            onHide={onBlameHide ?? (() => {})}
            loading={blameLoading}
          />
        )}
        <div ref={editorWrapperRef} className="min-h-0 flex-1">
          <Editor
            height="100%"
            language={editorLanguage}
            defaultValue={fileContent ?? ''}
            theme={monacoThemeName}
            onChange={handleChange}
            onMount={handleMount}
            beforeMount={handleBeforeMount}
            options={editorOptions}
          />
        </div>
      </div>
      {vimModeEnabled && (
        <div
          ref={vimStatusRef}
          data-vim-status-bar
          className={cn(
            'shrink-0 border-t border-border bg-muted/50 px-3 py-0.5 font-mono text-xs text-muted-foreground',
            !vimAttached && 'hidden'
          )}
        />
      )}
    </div>
  );
}
