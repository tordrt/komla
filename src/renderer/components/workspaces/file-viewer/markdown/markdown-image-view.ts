import type { NodeViewRenderer } from '@tiptap/core';

/**
 * The workspace-relative path of an image a Markdown file links to, or null for
 * web URLs and paths outside the workspace. Komla's page only shows images it
 * reads from disk.
 */
export function resolveMarkdownImagePath(markdownPath: string, src: string): string | null {
  if (/^[a-z][a-z\d+.-]*:/i.test(src) || src.startsWith('//')) return null;
  let path = src.split(/[?#]/)[0];
  try {
    path = decodeURI(path);
  } catch {
    // Keep the path as written.
  }
  const parts = path.startsWith('/') ? [] : markdownPath.split(/[\\/]/).slice(0, -1);
  for (const segment of path.split(/[\\/]/)) {
    if (!segment || segment === '.') continue;
    if (segment !== '..') parts.push(segment);
    else if (!parts.pop()) return null;
  }
  return parts.length ? parts.join('/') : null;
}

/** Shows images from `load`, which returns a URL the page can display or null. */
export function createImageNodeView(
  load: (src: string) => Promise<string | null>
): NodeViewRenderer {
  return ({ node }) => {
    const image = document.createElement('img');
    let src: string | null = null;

    const show = (attrs: Record<string, unknown>) => {
      image.alt = typeof attrs.alt === 'string' ? attrs.alt : '';
      image.title = typeof attrs.title === 'string' ? attrs.title : '';
      const next = typeof attrs.src === 'string' ? attrs.src : '';
      if (next === src) return;
      src = next;
      image.removeAttribute('src');
      image.classList.remove('is-broken');
      const fail = () => {
        if (src !== next) return;
        image.classList.add('is-broken');
        image.title = `Couldn't show ${next}`;
      };
      load(next).then((url) => {
        if (src !== next) return;
        if (url) image.src = url;
        else fail();
      }, fail);
    };

    show(node.attrs);
    return {
      dom: image,
      update: (updated) => {
        if (updated.type !== node.type) return false;
        show(updated.attrs);
        return true;
      },
    };
  };
}
