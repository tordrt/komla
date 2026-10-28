import { useEffect, useRef, useState } from 'react';

import { isNonHttpListener, type PreviewUrlCandidate } from '@/lib/dev-preview-candidates';

import { isLocalTerminalExecutionLocation } from '../../shared/types/terminal';

import type { LinkPreview } from '../../shared/types';

/** A page to describe: a URL on this machine's network, or on the SSH host's loopback interface. */
export interface LinkPreviewTarget {
  url: string;
  onSshHost: boolean;
  /** The process serving the page, so a new server on the same port is read again. */
  pid?: number;
}

export function linkPreviewKey({ url, onSshHost, pid }: LinkPreviewTarget): string {
  return `${onSshHost ? 'ssh' : 'local'}|${pid ?? ''}|${url}`;
}

/** The page a server candidate opens, or null when nothing answers HTTP there. */
export function candidatePreviewTarget(
  candidate: PreviewUrlCandidate,
  isSshWorkspace: boolean
): LinkPreviewTarget | null {
  if (candidate.live === false || isNonHttpListener(candidate)) return null;
  return {
    url: candidate.url,
    onSshHost: isSshWorkspace && !isLocalTerminalExecutionLocation(candidate.executionLocation),
    pid: candidate.service?.pid,
  };
}

interface LinkPreviewAnswers {
  /** What each page says about itself, by `linkPreviewKey`. */
  previews: ReadonlyMap<string, LinkPreview>;
  /** The targets main has answered for, with a preview or without. */
  answered: ReadonlySet<string>;
}

/**
 * The title, icon and Open Graph details of each target's page, read while
 * `enabled`. Main keeps answers for a while, so the next enable asks again
 * cheaply and picks up a page that changed.
 */
export function useLinkPreviews(
  workspaceId: string,
  targets: LinkPreviewTarget[],
  enabled: boolean
): LinkPreviewAnswers {
  // Each time the list opens for a workspace starts a new look.
  const [look, setLook] = useState({ id: 0, workspaceId, enabled });
  if (look.workspaceId !== workspaceId || look.enabled !== enabled) {
    setLook({ id: look.id + 1, workspaceId, enabled });
  }
  const [answers, setAnswers] = useState<LinkPreviewAnswers & { look: number }>(() => ({
    look: 0,
    ...NO_ANSWERS,
  }));
  const requested = useRef({ look: -1, keys: new Set<string>() });

  const targetsKey = JSON.stringify(
    targets.map((target) => [target.url, target.onSshHost, target.pid ?? null])
  );
  const lookId = look.id;
  useEffect(() => {
    if (!enabled) return;
    if (requested.current.look !== lookId) requested.current = { look: lookId, keys: new Set() };
    const asked = requested.current.keys;
    for (const [url, onSshHost, pid] of JSON.parse(targetsKey) as Array<
      [string, boolean, number | null]
    >) {
      const target = { url, onSshHost, pid: pid ?? undefined };
      const key = linkPreviewKey(target);
      if (asked.has(key)) continue;
      asked.add(key);
      void window.api
        .getLinkPreview({ ...target, workspaceId })
        .catch(() => null)
        .then((preview) => {
          setAnswers((current) => {
            // An answer for an older look is dropped.
            if (requested.current.look !== lookId) return current;
            const same = current.look === lookId;
            const previews = new Map(same ? current.previews : []);
            if (preview) previews.set(key, preview);
            return {
              look: lookId,
              previews,
              answered: new Set(same ? current.answered : []).add(key),
            };
          });
        });
    }
  }, [enabled, lookId, targetsKey, workspaceId]);

  return enabled && answers.look === lookId ? answers : NO_ANSWERS;
}

const NO_ANSWERS: LinkPreviewAnswers = { previews: new Map(), answered: new Set() };
// Recent og:images, so hovering a link again shows its image at once.
const MAX_CACHED_IMAGES = 12;
const images = new Map<string, Promise<string | null>>();

function loadImage(url: string): Promise<string | null> {
  const request: Promise<string | null> = window.api.getLinkPreviewImage(url).catch(() => null);
  images.set(url, request);
  // A failed image is asked for again next time; main decides when to retry.
  void request.then((dataUrl) => {
    if (dataUrl === null) images.delete(url);
  });
  if (images.size > MAX_CACHED_IMAGES) images.delete(images.keys().next().value!);
  return request;
}

/** An og:image as a data: URL; undefined while it loads, null when it can't be shown. */
export function useLinkPreviewImage(url: string | undefined): string | null | undefined {
  const [image, setImage] = useState<{ url: string; dataUrl: string | null } | null>(null);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const request = images.get(url) ?? loadImage(url);
    void request.then((dataUrl) => {
      if (!cancelled) setImage({ url, dataUrl });
    });
    return () => {
      cancelled = true;
    };
  }, [url]);
  if (!url) return null;
  return image?.url === url ? image.dataUrl : undefined;
}
