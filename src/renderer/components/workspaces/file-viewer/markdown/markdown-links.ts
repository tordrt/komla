import { resolveMarkdownImagePath } from './markdown-image-view';

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/** Where a link in a Markdown file goes, when it goes somewhere Komla can open. */
export type MarkdownLinkTarget =
  | { kind: 'web'; url: string }
  /** A heading in the same file, by its anchor. */
  | { kind: 'heading'; slug: string }
  /** A workspace file, by its path in the workspace. */
  | { kind: 'file'; path: string };

/** How a host opens the workspace files links point to, by their paths in the workspace. */
export interface MarkdownFileLinks {
  canOpen: (path: string) => boolean;
  open: (path: string) => void;
}

/** Where `href`, in the Markdown file at `markdownPath`, goes; null when Komla can't open it. */
export function resolveMarkdownLink(markdownPath: string, href: string): MarkdownLinkTarget | null {
  if (/^(?:https?|mailto):/i.test(href)) return { kind: 'web', url: href };
  if (href.startsWith('#')) {
    const slug = decodeAnchor(href.slice(1)).toLowerCase();
    return slug ? { kind: 'heading', slug } : null;
  }
  // A link to a query or nothing at all would resolve to the file's own folder.
  if (!/^[^?#]/.test(href)) return null;
  const path = resolveMarkdownImagePath(markdownPath, href);
  return path ? { kind: 'file', path } : null;
}

/** A heading's anchor as GitHub makes it: lowercase, punctuation dropped, spaces as hyphens. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-');
}

/**
 * The position of the heading an anchor names, or null. A repeated heading's anchor takes the
 * next number no earlier anchor has, as on GitHub: `#notes` is the first "Notes", `#notes-1` the
 * next, unless a "Notes 1" heading came first and took it.
 */
export function findHeading(doc: ProseMirrorNode, slug: string): number | null {
  const repeats = new Map<string, number>();
  let found: number | null = null;
  doc.descendants((node, position) => {
    if (found !== null) return false;
    // Headings can sit in lists and quotes, but not in other headings.
    if (node.type.name !== 'heading') return true;
    const base = headingSlug(node.textContent);
    let anchor = base;
    while (repeats.has(anchor)) {
      const count = (repeats.get(base) ?? 0) + 1;
      repeats.set(base, count);
      anchor = `${base}-${count}`;
    }
    repeats.set(anchor, 0);
    if (anchor === slug) found = position;
    return false;
  });
  return found;
}

function decodeAnchor(anchor: string): string {
  try {
    return decodeURIComponent(anchor);
  } catch {
    return anchor;
  }
}
