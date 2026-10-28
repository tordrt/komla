/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SegmentedControl } from '../../../../src/renderer/components/ui/segmented-control';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';

const OPTIONS = [
  { value: 'files', label: 'Files' },
  { value: 'content', label: 'Content', disabled: true },
  { value: 'symbols', label: 'Symbols' },
] as const;

function renderControl(value: 'files' | 'content' | 'symbols', onValueChange = vi.fn()) {
  render(
    <SegmentedControl
      aria-label="Search mode"
      value={value}
      onValueChange={onValueChange}
      options={OPTIONS}
    />
  );
  return onValueChange;
}

describe('SegmentedControl', () => {
  it('exposes a labelled radio group with the selected option checked', () => {
    renderControl('symbols');

    expect(screen.getByRole('radiogroup', { name: 'Search mode' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Symbols' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Files' })).toHaveAttribute('aria-checked', 'false');
  });

  it('makes only the selected option a tab stop', () => {
    renderControl('symbols');

    expect(screen.getByRole('radio', { name: 'Symbols' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'Files' })).toHaveAttribute('tabindex', '-1');
  });

  it('keeps a disabled option hoverable so its title can explain why', () => {
    render(
      <SegmentedControl
        aria-label="Publish method"
        value="url"
        onValueChange={vi.fn()}
        options={[
          { value: 'github', label: 'GitHub', disabled: true, title: 'GitHub CLI not installed' },
          { value: 'url', label: 'Remote URL' },
        ]}
      />
    );

    const github = screen.getByRole('radio', { name: 'GitHub' });
    expect(github).toBeDisabled();
    expect(github).toHaveAttribute('title', 'GitHub CLI not installed');
    expect(github.className).not.toContain('pointer-events-none');
  });

  it('reports every click, including on the selected option', () => {
    const onValueChange = renderControl('files');

    // Callers re-apply the selected option on a repeat click (e.g. re-normalize a pasted URL).
    fireEvent.click(screen.getByRole('radio', { name: 'Files' }));
    expect(onValueChange).toHaveBeenLastCalledWith('files');
    fireEvent.click(screen.getByRole('radio', { name: 'Symbols' }));
    expect(onValueChange).toHaveBeenLastCalledWith('symbols');
  });

  it('moves and selects with the arrow keys, skipping disabled options and wrapping', () => {
    const onValueChange = renderControl('files');
    const files = screen.getByRole('radio', { name: 'Files' });

    fireEvent.keyDown(files, { key: 'ArrowRight' });
    expect(onValueChange).toHaveBeenLastCalledWith('symbols');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Symbols' }));

    fireEvent.keyDown(files, { key: 'ArrowLeft' });
    expect(onValueChange).toHaveBeenLastCalledWith('symbols');

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Symbols' }), { key: 'Home' });
    expect(document.activeElement).toBe(files);
  });

  it('shows only icons when asked, naming each option in its tooltip', async () => {
    render(
      <SegmentedControl
        aria-label="Markdown view"
        iconOnly
        value="rich"
        onValueChange={vi.fn()}
        options={[
          { value: 'rich', label: 'Rich text', icon: <svg />, shortcut: 'Ctrl+/' },
          {
            value: 'source',
            label: 'Source',
            icon: <svg />,
            disabled: true,
            title: 'Too large to edit as rich text',
          },
        ]}
      />,
      { wrapper: TooltipProvider }
    );

    const rich = screen.getByRole('radio', { name: 'Rich text' });
    expect(rich).toHaveTextContent('');
    expect(rich).not.toHaveAttribute('title');
    act(() => rich.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Rich textCtrl+/');
    // A disabled button gets no pointer events to open a tooltip.
    expect(screen.getByRole('radio', { name: 'Source' })).toHaveAttribute(
      'title',
      'Too large to edit as rich text'
    );
  });
});
