/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CARD_LOOKUP_MS,
  waitForVisibleCard,
} from '../../../../../src/renderer/components/layout/settings/settings-card-lookup';

describe('waitForVisibleCard', () => {
  let container: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(() => {
    container.remove();
    vi.useRealTimers();
  });

  function card(id = 'settings-plugin-prs') {
    const element = document.createElement('div');
    element.id = id;
    return element;
  }

  // MutationObserver calls back in a microtask.
  const rendered = () => Promise.resolve();

  it('finds a card the page renders long after it opened, as after a list main reads', async () => {
    const found = vi.fn();
    waitForVisibleCard(() => container, 'settings-plugin-prs', found);

    vi.advanceTimersByTime(3000);
    container.append(card('settings-plugin-other'));
    await rendered();
    expect(found).not.toHaveBeenCalled();
    const target = card();
    container.append(target);
    await rendered();

    expect(found).toHaveBeenCalledExactlyOnceWith(target);
  });

  it('finds a card at once, and one shown when its section stops being hidden', async () => {
    const shown = card();
    container.append(shown);
    const found = vi.fn();
    waitForVisibleCard(() => container, 'settings-plugin-prs', found);
    expect(found).toHaveBeenCalledWith(shown);

    const section = document.createElement('section');
    section.hidden = true;
    section.append(card('settings-plugin-later'));
    container.append(section);
    const later = vi.fn();
    waitForVisibleCard(() => container, 'settings-plugin-later', later);
    expect(later).not.toHaveBeenCalled();
    section.hidden = false;
    await rendered();
    expect(later).toHaveBeenCalledOnce();
  });

  it('leaves the user be once they click, scroll or type, or after a while', async () => {
    const afterClick = vi.fn();
    waitForVisibleCard(() => container, 'settings-plugin-prs', afterClick);
    container.dispatchEvent(new Event('pointerdown'));

    const afterWait = vi.fn();
    waitForVisibleCard(() => container, 'settings-plugin-prs', afterWait);
    vi.advanceTimersByTime(CARD_LOOKUP_MS);

    container.append(card());
    await rendered();
    expect(afterClick).not.toHaveBeenCalled();
    expect(afterWait).not.toHaveBeenCalled();
  });
});
