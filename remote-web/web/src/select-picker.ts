// Picker rows for the launch sheets, after Orca Mobile's PickerListDrawer (stablyai/orca, MIT).
// Each <select> stays the source of truth: main.ts fills and reads it as before. A row button
// shows the selected option and opens a checkmark list in a bottom sheet, which beats the
// platform's select wheel on a phone.

export interface PickerOptions {
  label: string;
  /** Leading mark for an option, as trusted HTML (an inline SVG or a color dot). */
  mark?: (option: HTMLOptionElement) => string;
  /** Hide the row while there is only one option to choose. */
  hideWhenSingle?: boolean;
}

const CHEVRON =
  '<svg class="picker-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>';
const CHECK =
  '<svg class="picker-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>';

// Tailwind 500 swatches for launch-mode colors (src/renderer/lib/launch-mode-colors.ts).
const LAUNCH_MODE_SWATCHES: Record<string, string> = {
  blue: '#3b82f6',
  purple: '#a855f7',
  amber: '#f59e0b',
  emerald: '#10b981',
  red: '#ef4444',
  cyan: '#06b6d4',
  pink: '#ec4899',
  orange: '#f97316',
};
const FALLBACK_LAUNCH_MODE_COLORS = ['blue', 'purple', 'amber', 'emerald'];

/** The color a launch mode shows on the desktop: its saved color, or one picked by position. */
export function launchModeColor(savedColor: string | undefined, index: number): string {
  if (!savedColor) {
    return FALLBACK_LAUNCH_MODE_COLORS[index % FALLBACK_LAUNCH_MODE_COLORS.length] ?? 'blue';
  }
  return Object.hasOwn(LAUNCH_MODE_SWATCHES, savedColor) ? savedColor : 'amber';
}

/** A color dot for options whose `data-color` is a hex color or a launch-mode color, or nothing. */
export function colorDotMark(option: HTMLOptionElement): string {
  const saved = option.dataset.color ?? '';
  const color = Object.hasOwn(LAUNCH_MODE_SWATCHES, saved)
    ? LAUNCH_MODE_SWATCHES[saved]
    : /^#[0-9a-f]{3,8}$/i.test(saved)
      ? saved
      : null;
  if (!color) return '';
  return `<i class="picker-dot" style="background:${color}" aria-hidden="true"></i>`;
}

/**
 * Hides `select` behind a picker row that opens `sheet` (a `<dialog>` holding an `h2` and a
 * `[role=menu]`). Choosing an option sets the select's value and fires `change`.
 */
export function bindSelectPicker(
  select: HTMLSelectElement,
  sheet: HTMLDialogElement,
  options: PickerOptions
): void {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'picker-row';
  row.setAttribute('aria-haspopup', 'dialog');
  select.hidden = true;
  select.after(row);

  const render = () => {
    const selected = select.selectedOptions[0];
    const text = selected?.textContent ?? '';
    row.innerHTML = `<span class="picker-label"></span><span class="picker-value">${
      selected && options.mark ? options.mark(selected) : ''
    }<span class="picker-text"></span></span>${CHEVRON}`;
    row.querySelector('.picker-label')!.textContent = options.label;
    row.querySelector('.picker-text')!.textContent = text || 'None';
    row.setAttribute('aria-label', `${options.label}: ${text || 'none'}`);
    row.disabled = select.disabled || select.options.length === 0;
    if (options.hideWhenSingle && select.parentElement) {
      select.parentElement.hidden = select.options.length < 2;
    }
  };

  new MutationObserver(render).observe(select, { childList: true, attributes: true });
  select.addEventListener('change', render);
  row.addEventListener('click', () => openPickerSheet(select, sheet, options));
  render();
}

function openPickerSheet(
  select: HTMLSelectElement,
  sheet: HTMLDialogElement,
  options: PickerOptions
): void {
  const title = sheet.querySelector('h2');
  const list = sheet.querySelector<HTMLElement>('[role="menu"]');
  if (!list) return;
  if (title) title.textContent = options.label;
  list.replaceChildren(
    ...Array.from(select.options).map((option) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitemradio');
      const checked = option.value === select.value;
      item.setAttribute('aria-checked', String(checked));
      item.innerHTML = `${options.mark?.(option) ?? ''}<span class="picker-option-text"></span>${
        checked ? CHECK : ''
      }`;
      item.querySelector('.picker-option-text')!.textContent = option.textContent;
      item.addEventListener('click', () => {
        sheet.close();
        if (option.value === select.value) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return item;
    })
  );
  if (!sheet.open) sheet.showModal();
  list.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
}
