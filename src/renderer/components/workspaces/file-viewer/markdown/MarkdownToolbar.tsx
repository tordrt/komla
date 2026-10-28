import {
  CaretDown,
  Code,
  CodeBlock,
  LinkSimple,
  ListBullets,
  ListChecks,
  ListNumbers,
  Minus,
  Quotes,
  Table,
  TextB,
  TextItalic,
  TextStrikethrough,
} from '@phosphor-icons/react';
import { useEditorState } from '@tiptap/react';
import { useState } from 'react';

import { usePaneDragBar } from '@/components/terminal/PaneDragGrip';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { formatShortcutForDisplay } from '@/stores/shortcuts.store';

import type { Editor } from '@tiptap/core';

const BLOCK_TYPES = [
  { label: 'Text', level: 0 },
  { label: 'Heading 1', level: 1 },
  { label: 'Heading 2', level: 2 },
  { label: 'Heading 3', level: 3 },
] as const;

function shortcut(keys: string): string {
  return formatShortcutForDisplay(keys, window.api?.platform);
}

function readToolbarState(editor: Editor) {
  const heading = editor.getAttributes('heading').level as number | undefined;
  return {
    blockLabel: editor.isActive('heading') ? `Heading ${heading}` : 'Text',
    canSetBlock: editor.can().setParagraph(),
    bold: editor.isActive('bold'),
    italic: editor.isActive('italic'),
    strike: editor.isActive('strike'),
    code: editor.isActive('code'),
    link: editor.isActive('link'),
    bulletList: editor.isActive('bulletList'),
    orderedList: editor.isActive('orderedList'),
    taskList: editor.isActive('taskList'),
    blockquote: editor.isActive('blockquote'),
    codeBlock: editor.isActive('codeBlock'),
    table: editor.isActive('table'),
  };
}

/** Formatting controls for the rich Markdown editor; `children` sits at the end of the row. */
export function MarkdownToolbar({
  editor,
  readOnly,
  children,
}: {
  editor: Editor;
  readOnly: boolean;
  children?: React.ReactNode;
}) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => readToolbarState(current),
  });
  const chain = () => editor.chain().focus();
  const toggle = (active: boolean) => (active ? 'secondary' : 'ghost');
  // In a pane, the space between the buttons drags the pane.
  const dragBar = usePaneDragBar();

  return (
    <div
      className={cn(
        'flex h-8 shrink-0 items-center gap-2 border-b border-border px-2',
        dragBar && 'cursor-grab active:cursor-grabbing'
      )}
      {...dragBar}
    >
      {/* Scrolls sideways when the panel is narrow, keeping the end of the row in view. */}
      {readOnly ? (
        <div className="flex-1" />
      ) : (
        <div className="flex min-w-0 flex-1 [scrollbar-width:none] items-center gap-0.5 overflow-x-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-24 shrink-0 justify-between gap-1 px-2 text-xs font-normal"
                disabled={!editor.isEditable || !state.canSetBlock}
                aria-label={`Block type: ${state.blockLabel}`}
              >
                {state.blockLabel}
                <CaretDown className="size-3 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
              {BLOCK_TYPES.map(({ label, level }) => (
                <DropdownMenuItem
                  key={label}
                  onSelect={() =>
                    level ? chain().setHeading({ level }).run() : chain().setParagraph().run()
                  }
                >
                  {label}
                  <span className="ml-auto pl-4 text-[11px] text-muted-foreground">
                    {shortcut(`Cmd+Alt+${level}`)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Divider />
          <IconButton
            size="xs"
            label="Bold"
            shortcut={shortcut('Cmd+B')}
            variant={toggle(state.bold)}
            onClick={() => chain().toggleBold().run()}
          >
            <TextB className="size-3.5" />
          </IconButton>
          <IconButton
            size="xs"
            label="Italic"
            shortcut={shortcut('Cmd+I')}
            variant={toggle(state.italic)}
            onClick={() => chain().toggleItalic().run()}
          >
            <TextItalic className="size-3.5" />
          </IconButton>
          <IconButton
            size="xs"
            label="Strikethrough"
            shortcut={shortcut('Cmd+Shift+S')}
            variant={toggle(state.strike)}
            onClick={() => chain().toggleStrike().run()}
          >
            <TextStrikethrough className="size-3.5" />
          </IconButton>
          <IconButton
            size="xs"
            label="Inline code"
            shortcut={shortcut('Cmd+E')}
            variant={toggle(state.code)}
            onClick={() => chain().toggleCode().run()}
          >
            <Code className="size-3.5" />
          </IconButton>
          <LinkButton editor={editor} active={state.link} />
          <Divider />
          <IconButton
            size="xs"
            label="Bullet list"
            shortcut={shortcut('Cmd+Shift+8')}
            variant={toggle(state.bulletList)}
            onClick={() => chain().toggleBulletList().run()}
          >
            <ListBullets className="size-3.5" />
          </IconButton>
          <IconButton
            size="xs"
            label="Numbered list"
            shortcut={shortcut('Cmd+Shift+7')}
            variant={toggle(state.orderedList)}
            onClick={() => chain().toggleOrderedList().run()}
          >
            <ListNumbers className="size-3.5" />
          </IconButton>
          <IconButton
            size="xs"
            label="Task list"
            shortcut={shortcut('Cmd+Shift+9')}
            variant={toggle(state.taskList)}
            onClick={() => chain().toggleTaskList().run()}
          >
            <ListChecks className="size-3.5" />
          </IconButton>
          <IconButton
            size="xs"
            label="Quote"
            variant={toggle(state.blockquote)}
            onClick={() => chain().toggleBlockquote().run()}
          >
            <Quotes className="size-3.5" />
          </IconButton>
          <IconButton
            size="xs"
            label="Code block"
            shortcut={shortcut('Cmd+Alt+C')}
            variant={toggle(state.codeBlock)}
            onClick={() => chain().toggleCodeBlock().run()}
          >
            <CodeBlock className="size-3.5" />
          </IconButton>
          <Divider />
          <TableMenu editor={editor} inTable={state.table} />
          <IconButton size="xs" label="Divider" onClick={() => chain().setHorizontalRule().run()}>
            <Minus className="size-3.5" />
          </IconButton>
        </div>
      )}
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

function Divider() {
  return <div className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden />;
}

function LinkButton({ editor, active }: { editor: Editor; active: boolean }) {
  const [open, setOpen] = useState(false);
  const [href, setHref] = useState('');

  const apply = () => {
    const url = href.trim();
    const chain = editor.chain().focus().extendMarkRange('link');
    if (!url) {
      chain.unsetLink().run();
    } else if (editor.state.selection.empty && !active) {
      chain
        .insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] })
        .run();
    } else {
      chain.setLink({ href: url }).run();
    }
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setHref((editor.getAttributes('link').href as string | undefined) ?? '');
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <IconButton size="xs" label="Link" variant={active ? 'secondary' : 'ghost'}>
          <LinkSimple className="size-3.5" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-2"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
        >
          <Input
            autoFocus
            value={href}
            onChange={(event) => setHref(event.target.value)}
            placeholder="https://… or path/to/file.md"
            aria-label="Link address"
            className="h-7 text-xs"
          />
          <Button type="submit" size="sm" className="h-7 px-2.5 text-xs">
            {href.trim() || !active ? 'Apply' : 'Remove'}
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

function TableMenu({ editor, inTable }: { editor: Editor; inTable: boolean }) {
  const run = (command: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) =>
    command(editor.chain().focus()).run();

  if (!inTable) {
    return (
      <IconButton
        size="xs"
        label="Table"
        onClick={() => run((chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
      >
        <Table className="size-3.5" />
      </IconButton>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton size="xs" label="Table" variant="secondary">
          <Table className="size-3.5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
        <DropdownMenuItem onSelect={() => run((chain) => chain.addRowBefore())}>
          Insert row above
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run((chain) => chain.addRowAfter())}>
          Insert row below
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run((chain) => chain.addColumnBefore())}>
          Insert column left
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run((chain) => chain.addColumnAfter())}>
          Insert column right
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => run((chain) => chain.deleteRow())}>
          Delete row
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => run((chain) => chain.deleteColumn())}>
          Delete column
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          onSelect={() => run((chain) => chain.deleteTable())}
        >
          Delete table
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
