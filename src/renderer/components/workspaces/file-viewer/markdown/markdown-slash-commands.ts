import {
  CodeBlock,
  ListBullets,
  ListChecks,
  ListNumbers,
  Minus,
  Quotes,
  Table,
  TextHOne,
  TextHThree,
  TextHTwo,
  TextT,
} from '@phosphor-icons/react';
import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion, { exitSuggestion } from '@tiptap/suggestion';

import type { Icon } from '@phosphor-icons/react';
import type { ChainedCommands, Editor, Range } from '@tiptap/core';
import type { SuggestionProps } from '@tiptap/suggestion';

export interface SlashCommand {
  title: string;
  keywords: string;
  icon: Icon;
  apply: (chain: ChainedCommands) => ChainedCommands;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    title: 'Text',
    keywords: 'paragraph plain',
    icon: TextT,
    apply: (chain) => chain.setParagraph(),
  },
  {
    title: 'Heading 1',
    keywords: 'h1 title',
    icon: TextHOne,
    apply: (chain) => chain.setHeading({ level: 1 }),
  },
  {
    title: 'Heading 2',
    keywords: 'h2 subtitle',
    icon: TextHTwo,
    apply: (chain) => chain.setHeading({ level: 2 }),
  },
  {
    title: 'Heading 3',
    keywords: 'h3',
    icon: TextHThree,
    apply: (chain) => chain.setHeading({ level: 3 }),
  },
  {
    title: 'Bullet list',
    keywords: 'ul unordered',
    icon: ListBullets,
    apply: (chain) => chain.toggleBulletList(),
  },
  {
    title: 'Numbered list',
    keywords: 'ol ordered',
    icon: ListNumbers,
    apply: (chain) => chain.toggleOrderedList(),
  },
  {
    title: 'Task list',
    keywords: 'todo checkbox checklist',
    icon: ListChecks,
    apply: (chain) => chain.toggleTaskList(),
  },
  {
    title: 'Quote',
    keywords: 'blockquote',
    icon: Quotes,
    apply: (chain) => chain.toggleBlockquote(),
  },
  {
    title: 'Code block',
    keywords: 'fence snippet',
    icon: CodeBlock,
    apply: (chain) => chain.toggleCodeBlock(),
  },
  {
    title: 'Table',
    keywords: 'grid',
    icon: Table,
    apply: (chain) => chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }),
  },
  {
    title: 'Divider',
    keywords: 'hr horizontal rule line separator',
    icon: Minus,
    apply: (chain) => chain.setHorizontalRule(),
  },
];

/** Commands with a word in their title or keywords starting with the query. */
export function filterSlashCommands(query: string): SlashCommand[] {
  const prefix = query.toLowerCase();
  return SLASH_COMMANDS.filter((command) =>
    `${command.title} ${command.keywords}`
      .toLowerCase()
      .split(/\s+/)
      .some((word) => word.startsWith(prefix))
  );
}

export interface SlashMenuState {
  commands: SlashCommand[];
  selected: number;
  /** Where the typed `/` is, for placing the menu. */
  anchor: DOMRect | null;
  run: (command: SlashCommand) => void;
}

interface SlashCommandsOptions {
  onChange: (state: SlashMenuState | null) => void;
}

const slashMenuKey = new PluginKey('markdownSlashMenu');

/** Typing `/` at the start of a line opens a menu of blocks to insert. */
export const MarkdownSlashCommands = Extension.create<SlashCommandsOptions>({
  name: 'markdownSlashCommands',
  addOptions() {
    return { onChange: () => {} };
  },
  addProseMirrorPlugins() {
    const { onChange } = this.options;
    let props: SuggestionProps<SlashCommand, SlashCommand> | null = null;
    let selected = 0;
    const publish = () => {
      onChange(
        props?.items.length
          ? {
              commands: props.items,
              selected,
              anchor: props.clientRect?.() ?? null,
              run: props.command,
            }
          : null
      );
    };
    const show = (next: SuggestionProps<SlashCommand, SlashCommand>) => {
      props = next;
      selected = 0;
      publish();
    };

    return [
      Suggestion<SlashCommand, SlashCommand>({
        editor: this.editor,
        pluginKey: slashMenuKey,
        char: '/',
        startOfLine: true,
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        items: ({ query }) => filterSlashCommands(query),
        command: ({ editor, range, props: command }) => runSlashCommand(editor, range, command),
        render: () => ({
          onStart: show,
          onUpdate: show,
          onExit: () => {
            props = null;
            publish();
          },
          onKeyDown: ({ event, view }) => {
            const count = props?.items.length ?? 0;
            if (!props || !count) return false;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              selected = (selected + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
              publish();
              return true;
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              props.command(props.items[selected]);
              return true;
            }
            if (event.key === 'Escape') {
              exitSuggestion(view, slashMenuKey);
              return true;
            }
            return false;
          },
        }),
      }),
    ];
  },
});

function runSlashCommand(editor: Editor, range: Range, command: SlashCommand): void {
  command.apply(editor.chain().focus().deleteRange(range)).run();
}
