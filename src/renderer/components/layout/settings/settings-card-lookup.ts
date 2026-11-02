/** How long Settings waits for a card a page renders late: after async config, a lazy chunk, or a
 *  list main reads first, such as the plugins a plugin's page opens Settings at. */
export const CARD_LOOKUP_MS = 5000;

/** What the user does that means they've moved on, so a card that shows up late leaves them be. */
const USER_ACTIONS = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const;

export function findVisibleCard(container: HTMLElement | null, cardId: string): HTMLElement | null {
  if (!container) return null;
  const cards = Array.from(container.querySelectorAll<HTMLElement>(`[id="${cardId}"]`));
  return cards.find((card) => !card.closest('[hidden]')) ?? null;
}

/**
 * Calls onFound once the container shows the card: at once, or as the page renders it, for up to
 * CARD_LOOKUP_MS, unless the user clicks, scrolls or types in the meantime. Returns a function
 * that stops looking.
 */
export function waitForVisibleCard(
  getContainer: () => HTMLElement | null,
  cardId: string,
  onFound: (card: HTMLElement) => void
): () => void {
  let frame = 0;
  let observer: MutationObserver | undefined;
  let container: HTMLElement | null = null;
  const stop = () => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    clearTimeout(timer);
    for (const type of USER_ACTIONS) container?.removeEventListener(type, stop, true);
  };
  const lookUp = () => {
    const card = findVisibleCard(container, cardId);
    if (!card) return;
    stop();
    onFound(card);
  };
  // The container may mount a frame or two after the request.
  const watch = () => {
    container = getContainer();
    if (!container) {
      frame = requestAnimationFrame(watch);
      return;
    }
    for (const type of USER_ACTIONS) container.addEventListener(type, stop, true);
    observer = new MutationObserver(lookUp);
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'id'],
    });
    lookUp();
  };
  const timer = setTimeout(stop, CARD_LOOKUP_MS);
  watch();
  return stop;
}
