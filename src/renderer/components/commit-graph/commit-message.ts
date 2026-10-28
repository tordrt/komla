// A line break stays before a list item, an indented line or a trailer such as Co-Authored-By.
const HARD_WRAP = /\n(?![ \t]|[-*+•] |\d+[.)] |[\w-]+: )/g;

/**
 * A commit message's title, its first line, and its body, with the lines git messages are
 * wrapped at joined back into paragraphs so they wrap to the space they're shown in.
 */
export function splitCommitMessage(message: string): { title: string; body: string } {
  const [title = '', ...rest] = message.trim().split('\n');
  const body = rest
    .join('\n')
    .trim()
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(HARD_WRAP, ' '))
    .join('\n\n');
  return { title: title.trim(), body };
}
