// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bindSelectPicker, colorDotMark, launchModeColor } from '../select-picker';

function makeSheet(): HTMLDialogElement {
  const sheet = document.createElement('dialog');
  sheet.innerHTML = '<h2></h2><div role="menu"></div>';
  // jsdom has no modal dialogs.
  sheet.showModal = vi.fn(() => sheet.setAttribute('open', ''));
  sheet.close = vi.fn(() => sheet.removeAttribute('open'));
  document.body.append(sheet);
  return sheet;
}

function makeSelect(options: Array<[string, string, string?]>, selected: string) {
  const field = document.createElement('div');
  const select = document.createElement('select');
  field.append(select);
  document.body.append(field);
  fill(select, options, selected);
  return { field, select };
}

function fill(select: HTMLSelectElement, options: Array<[string, string, string?]>, selected = '') {
  select.replaceChildren(
    ...options.map(([value, label, color]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      option.selected = value === selected;
      if (color) option.dataset.color = color;
      return option;
    })
  );
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('select picker', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('shows the selected option in a row and hides the select', () => {
    const sheet = makeSheet();
    const { select } = makeSelect(
      [
        ['p1', 'komla', '#339fee'],
        ['p2', 'landing'],
      ],
      'p1'
    );
    bindSelectPicker(select, sheet, { label: 'Project', mark: colorDotMark });
    const row = select.nextElementSibling as HTMLButtonElement;
    expect(select.hidden).toBe(true);
    expect(row.getAttribute('aria-label')).toBe('Project: komla');
    expect(row.querySelector('.picker-dot')).not.toBeNull();
  });

  it('lists options with a check and applies a choice through a change event', () => {
    const sheet = makeSheet();
    const { select } = makeSelect(
      [
        ['a', 'Claude Code'],
        ['b', 'Codex'],
      ],
      'a'
    );
    const changed = vi.fn();
    select.addEventListener('change', changed);
    bindSelectPicker(select, sheet, { label: 'Agent' });
    (select.nextElementSibling as HTMLButtonElement).click();

    expect(sheet.querySelector('h2')!.textContent).toBe('Agent');
    const items = sheet.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
    expect([...items].map((item) => item.getAttribute('aria-checked'))).toEqual(['true', 'false']);
    expect(items[0]!.querySelector('.picker-check')).not.toBeNull();

    items[1]!.click();
    expect(sheet.close).toHaveBeenCalled();
    expect(select.value).toBe('b');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(select.nextElementSibling!.getAttribute('aria-label')).toBe('Agent: Codex');
  });

  it('does not fire change when the current option is picked again', () => {
    const sheet = makeSheet();
    const { select } = makeSelect([['a', 'Default']], 'a');
    const changed = vi.fn();
    select.addEventListener('change', changed);
    bindSelectPicker(select, sheet, { label: 'Mode' });
    (select.nextElementSibling as HTMLButtonElement).click();
    sheet.querySelector<HTMLButtonElement>('[role="menuitemradio"]')!.click();
    expect(changed).not.toHaveBeenCalled();
  });

  it('follows options replaced by the app and hides a single-option row', async () => {
    const sheet = makeSheet();
    const { field, select } = makeSelect([['', 'Default']], '');
    bindSelectPicker(select, sheet, { label: 'Mode', hideWhenSingle: true });
    expect(field.hidden).toBe(true);

    fill(
      select,
      [
        ['', 'Default'],
        ['plan', 'Plan'],
      ],
      'plan'
    );
    await flush();
    expect(field.hidden).toBe(false);
    expect(select.nextElementSibling!.getAttribute('aria-label')).toBe('Mode: Plan');
  });

  it('renders text as text, not markup', () => {
    const sheet = makeSheet();
    const { select } = makeSelect([['x', '<img src=x onerror=alert(1)>']], 'x');
    bindSelectPicker(select, sheet, { label: 'Project' });
    const row = select.nextElementSibling as HTMLButtonElement;
    expect(row.querySelector('img')).toBeNull();
    row.click();
    expect(sheet.querySelector('img')).toBeNull();
  });
});

describe('color marks', () => {
  it('accepts hex and launch-mode colors only', () => {
    const option = document.createElement('option');
    option.dataset.color = 'purple';
    expect(colorDotMark(option)).toContain('#a855f7');
    option.dataset.color = '#e8a33d';
    expect(colorDotMark(option)).toContain('#e8a33d');
    option.dataset.color = 'red;background:url(x)';
    expect(colorDotMark(option)).toBe('');
    option.dataset.color = 'constructor';
    expect(colorDotMark(option)).toBe('');
  });

  it('picks launch-mode colors the way the desktop does', () => {
    expect(launchModeColor(undefined, 0)).toBe('blue');
    expect(launchModeColor(undefined, 5)).toBe('purple');
    expect(launchModeColor('cyan', 0)).toBe('cyan');
    expect(launchModeColor('mauve', 0)).toBe('amber');
  });
});
