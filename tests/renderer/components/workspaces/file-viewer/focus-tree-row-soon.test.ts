/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { focusTreeRowSoon } from '../../../../../src/renderer/components/workspaces/file-viewer/SidebarFileTree';

describe('focusTreeRowSoon', () => {
  let host: HTMLElement;
  let container: HTMLElement;
  let shadow: ShadowRoot;

  const addRow = () => {
    const row = document.createElement('div');
    row.dataset.type = 'item';
    row.tabIndex = 0;
    shadow.appendChild(row);
    return row;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    container.tabIndex = -1;
    host = document.createElement('div');
    const treeContainer = document.createElement('file-tree-container');
    shadow = treeContainer.attachShadow({ mode: 'open' });
    host.appendChild(treeContainer);
    container.appendChild(host);
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('focuses the row once it renders', () => {
    focusTreeRowSoon({ current: host }, { current: container });
    vi.advanceTimersByTime(100);
    const row = addRow();
    vi.advanceTimersByTime(100);

    expect(shadow.activeElement).toBe(row);
  });

  it('leaves the focus where the user put it while the row was rendering', () => {
    const prompt = document.createElement('textarea');
    document.body.appendChild(prompt);
    const then = vi.fn();
    focusTreeRowSoon({ current: host }, { current: container }, undefined, then);
    vi.advanceTimersByTime(100);

    // A shortcut opening the prompt draft, which takes the focus, before the row has rendered.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', metaKey: true, shiftKey: true }));
    prompt.focus();
    addRow();
    vi.advanceTimersByTime(600);

    expect(document.activeElement).toBe(prompt);
    expect(then).toHaveBeenCalledOnce();
  });

  it('still focuses the row after a key that left the focus where it was', () => {
    focusTreeRowSoon({ current: host }, { current: container });
    vi.advanceTimersByTime(100);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    const row = addRow();
    vi.advanceTimersByTime(100);

    expect(shadow.activeElement).toBe(row);
  });
});
