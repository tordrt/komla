import { Selection, TextSelection } from '@tiptap/pm/state';
import { useEditorState } from '@tiptap/react';
import { useRef } from 'react';

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';

import { SLASH_COMMANDS } from './markdown-slash-commands';
import { shortcut } from './MarkdownToolbar';

import type { ChainedCommands, Editor } from '@tiptap/core';

const MARKS = [
  { label: 'Bold', mark: 'bold', keys: 'Cmd+B', toggle: (c: ChainedCommands) => c.toggleBold() },
  {
    label: 'Italic',
    mark: 'italic',
    keys: 'Cmd+I',
    toggle: (c: ChainedCommands) => c.toggleItalic(),
  },
  {
    label: 'Strikethrough',
    mark: 'strike',
    keys: 'Cmd+Shift+S',
    toggle: (c: ChainedCommands) => c.toggleStrike(),
  },
  {
    label: 'Inline code',
    mark: 'code',
    keys: 'Cmd+E',
    toggle: (c: ChainedCommands) => c.toggleCode(),
  },
];

// Not the commands that add a block: at a right-click's cursor, they'd split the word or table
// under it.
const BLOCK_CONVERSIONS = SLASH_COMMANDS.filter((command) => !command.inserts);

/** Not one that opens a menu instead: Ctrl+click on macOS is reported as a left click. */
export function isPrimaryClick(event: { button: number; ctrlKey: boolean }): boolean {
  return event.button === 0 && !(event.ctrlKey && window.api?.platform === 'darwin');
}

/** The right-click menu for `children`, the part of the Markdown editor it opens over. */
export function MarkdownContextMenu({
  editor,
  readOnly,
  scrollerRef,
  children,
}: {
  editor: Editor;
  readOnly: boolean;
  /** Takes focus in place of a read-only editor, which can't. */
  scrollerRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}) {
  // A menu holds on to focus until it has closed, and clipboard commands act where focus is, so
  // what an item does waits until then.
  const afterCloseRef = useRef<(() => void) | null>(null);

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild onContextMenu={(event) => selectForRightClick(editor, event)}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        // React bubbles this through the portal, to any menu around the editor, such as the pane's.
        onContextMenu={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => {
          const afterClose = afterCloseRef.current;
          if (!afterClose) return;
          afterCloseRef.current = null;
          event.preventDefault();
          editor.view.focus();
          afterClose();
          if (readOnly) scrollerRef.current?.focus();
        }}
      >
        <MarkdownContextMenuItems
          editor={editor}
          readOnly={readOnly}
          runAfterClose={(action) => {
            afterCloseRef.current = action;
          }}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

function MarkdownContextMenuItems({
  editor,
  readOnly,
  runAfterClose,
}: {
  editor: Editor;
  readOnly: boolean;
  runAfterClose: (action: () => void) => void;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      selected: !current.state.selection.empty,
      marks: MARKS.map(({ mark, toggle }) => ({
        active: current.isActive(mark),
        enabled: toggle(current.can().chain()).run(),
      })),
      // Table cells hold only paragraphs, and a selected divider has no text to convert.
      convertible: current.state.selection.$from.parent.inlineContent && !current.isActive('table'),
    }),
  });
  // As real clipboard events, so the editor's own handlers put Markdown on the clipboard and format
  // what they take from it, as they do for the keyboard shortcuts.
  const clipboardItem = (
    label: string,
    command: 'cut' | 'copy' | 'paste',
    keys: string,
    disabled = false
  ) => (
    <ContextMenuItem
      inset
      disabled={disabled}
      onSelect={() => runAfterClose(() => void window.api.runClipboardCommand(command))}
    >
      {label}
      <ContextMenuShortcut>{shortcut(keys)}</ContextMenuShortcut>
    </ContextMenuItem>
  );
  const selectAllItem = (
    <ContextMenuItem inset onSelect={() => runAfterClose(() => editor.commands.selectAll())}>
      Select All
      <ContextMenuShortcut>{shortcut('Cmd+A')}</ContextMenuShortcut>
    </ContextMenuItem>
  );

  if (readOnly) {
    return (
      <>
        {clipboardItem('Copy', 'copy', 'Cmd+C', !state.selected)}
        {selectAllItem}
      </>
    );
  }
  return (
    <>
      {clipboardItem('Cut', 'cut', 'Cmd+X', !state.selected)}
      {clipboardItem('Copy', 'copy', 'Cmd+C', !state.selected)}
      {clipboardItem('Paste', 'paste', 'Cmd+V')}
      {selectAllItem}
      <ContextMenuSeparator />
      {MARKS.map(({ label, keys, toggle }, index) => (
        <ContextMenuCheckboxItem
          key={label}
          checked={state.marks[index].active}
          disabled={!state.marks[index].enabled}
          onSelect={() => runAfterClose(() => toggle(editor.chain()).run())}
        >
          {label}
          <ContextMenuShortcut>{shortcut(keys)}</ContextMenuShortcut>
        </ContextMenuCheckboxItem>
      ))}
      <ContextMenuSub>
        <ContextMenuSubTrigger inset disabled={!state.convertible}>
          Block
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {BLOCK_CONVERSIONS.map((command) => (
            <ContextMenuItem
              key={command.title}
              onSelect={() => runAfterClose(() => command.apply(editor.chain()).run())}
            >
              <command.icon />
              {command.title}
            </ContextMenuItem>
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  );
}

/**
 * A right-click acts on the selection it lands in, and otherwise on where it landed. Chromium has
 * already moved the DOM selection for it (on macOS, onto the word under it), but ProseMirror
 * wouldn't read that once the menu has taken focus, so its next command would act on the old one.
 */
function selectForRightClick(editor: Editor, event: React.MouseEvent): void {
  const { view, state } = editor;
  // A menu opened from the keyboard isn't a right-click, and the margin holds no text.
  if (event.button === -1 || isPrimaryClick(event) || !(event.target instanceof Node)) return;
  if (!view.dom.contains(event.target)) return;
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return;
  const { from, to } = state.selection;
  if (!state.selection.empty && at.pos >= from && at.pos <= to) return;

  const select = (selection: Selection) =>
    editor.commands.command(({ tr }) => {
      tr.setSelection(selection);
      return true;
    });
  const dom = window.getSelection();
  if (dom && !dom.isCollapsed && dom.anchorNode && dom.focusNode) {
    if (view.dom.contains(dom.anchorNode) && view.dom.contains(dom.focusNode)) {
      const anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset);
      const head = view.posAtDOM(dom.focusNode, dom.focusOffset);
      if (at.pos >= Math.min(anchor, head) && at.pos <= Math.max(anchor, head)) {
        select(TextSelection.between(state.doc.resolve(anchor), state.doc.resolve(head)));
        return;
      }
    }
  }
  // Near, as the click may have landed where no text can go, such as on a divider.
  select(Selection.near(state.doc.resolve(at.pos)));
}
