/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { pageLinkGuard } from '../../../src/main/services/page-link-guard';

const SVG = 'http://www.w3.org/2000/svg';

describe('pageLinkGuard', () => {
  const opened = vi.fn();

  beforeAll(() => {
    (window as unknown as { opened: typeof opened }).opened = opened;
    window.eval(pageLinkGuard('(url) => window.opened(url)'));
  });

  afterEach(() => {
    document.body.replaceChildren();
    opened.mockClear();
  });

  /** Clicks `target` as a page script would, and whether the click's default stayed. */
  function click(target: Element): boolean {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, composed: true });
    target.dispatchEvent(event);
    return !event.defaultPrevented;
  }

  function html(markup: string): Element {
    document.body.innerHTML = markup;
    return document.body.firstElementChild!;
  }

  it('keeps every kind of link from leaving the page or running script', () => {
    const svg = document.createElementNS(SVG, 'svg');
    const svgLink = document.createElementNS(SVG, 'a');
    svgLink.setAttribute('href', 'javascript:alert(1)');
    const shape = document.createElementNS(SVG, 'circle');
    svgLink.append(shape);
    svg.append(svgLink);

    const host = document.createElement('div');
    const shadowLink = document.createElement('a');
    shadowLink.href = 'javascript:alert(1)';
    const label = document.createElement('span');
    shadowLink.append(label);
    host.attachShadow({ mode: 'open' }).append(shadowLink);

    const links = [
      html('<a href="javascript:alert(1)">x</a>'),
      html('<a href="JavaScript:alert(1)"><b>x</b></a>').firstElementChild!,
      html('<a href="data:text/html,<p>hi</p>">x</a>'),
      html('<map><area href="javascript:alert(1)"></map>').firstElementChild!,
      html('<a href="https://example.com">x</a>'),
      html('<a href="other.html">x</a>'),
    ];
    for (const link of links) {
      document.body.replaceChildren(link.closest('a, map') ?? link);
      expect(click(link)).toBe(false);
    }
    document.body.replaceChildren(svg);
    expect(click(shape)).toBe(false);
    document.body.replaceChildren(host);
    expect(click(label)).toBe(false);
  });

  it("opens no link from a page script's click, only from the user's", () => {
    // jsdom can't make a trusted click, so the e2e test covers a link the user opens.
    expect(click(html('<a href="https://example.com">x</a>'))).toBe(false);
    expect(opened).not.toHaveBeenCalled();
  });

  it('takes the link the browser would follow, past an a without an href', () => {
    const outer = html('<a href="javascript:alert(1)"></a>');
    const svg = document.createElementNS(SVG, 'svg');
    const inner = document.createElementNS(SVG, 'a');
    svg.append(inner);
    outer.append(svg);
    expect(click(inner)).toBe(false);
  });

  it('follows a # link within the page itself, with the URL it checked', () => {
    const link = html('<a href="#details">x</a>');
    // A click handler that changes the link after the guard saw it doesn't change where it goes.
    link.addEventListener('click', () => link.setAttribute('href', 'javascript:alert(1)'));
    expect(click(link)).toBe(false);
    expect(location.hash).toBe('#details');
    location.hash = '';
  });

  it('leaves clicks that are on no link alone, or on an a without an href', () => {
    expect(click(html('<button>x</button>'))).toBe(true);
    expect(click(html('<a role="button">x</a>'))).toBe(true);
  });
});
