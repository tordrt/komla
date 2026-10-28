import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useEffect, useMemo, useRef } from 'react';

/** Renders a Markdown file as a page, with its HTML sanitized and its links opened in the browser. */
export function MarkdownPreview({ markdown }: { markdown: string }) {
  const articleRef = useRef<HTMLElement>(null);
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }), {
        FORBID_TAGS: ['form', 'style'],
      }),
    [markdown]
  );

  // Delegated from the rendered links, which keep their own keyboard handling.
  useEffect(() => {
    const article = articleRef.current;
    article?.addEventListener('click', openLinkInBrowser);
    return () => article?.removeEventListener('click', openLinkInBrowser);
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background">
      <article
        ref={articleRef}
        className="markdown-preview mx-auto max-w-3xl px-8 py-6"
        // Sanitized above.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** A followed link would replace Komla's own page, so web links open in the browser instead. */
export function openLinkInBrowser(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute('href') ?? '';
  if (/^(?:https?|mailto):/i.test(href)) void window.api.openExternal(href);
}
