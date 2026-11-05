import { Check, Copy } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

import { useToastStore } from '@/stores/toast.store';

interface CopyRowButtonProps {
  /** What it copies, as in "Copy /review-pr" */
  title: string;
  /** The text to copy, or null when it can't be read any more */
  getText: () => string | null | Promise<string | null>;
}

/**
 * A row's copy button, showing a check once copied. The row runs or picks its entry on click or
 * Enter, and a menu item on pointer up, so the button keeps all of those to itself.
 */
export function CopyRowButton({ title, getText }: CopyRowButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const copy = async () => {
    let text: string | null;
    try {
      text = await getText();
    } catch {
      text = null;
    }
    if (text === null) {
      useToastStore.getState().addToast(`Couldn't read ${title}`, 'error');
      return;
    }
    window.api.copyToClipboard(text);
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  const stop = (event: SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const label = copied ? 'Copied' : `Copy ${title}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onMouseDown={stop}
      onPointerDown={stop}
      onPointerUp={stop}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          stop(event);
          void copy();
        }
      }}
      onClick={(event) => {
        stop(event);
        void copy();
      }}
      className="rounded p-1 text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
    >
      {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
    </button>
  );
}
