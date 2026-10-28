/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SettingsRow } from '../../../../../src/renderer/components/layout/settings/SettingsRow';
import { Button } from '../../../../../src/renderer/components/ui/button';
import { Select } from '../../../../../src/renderer/components/ui/select';
import { Switch } from '../../../../../src/renderer/components/ui/switch';

function SwitchRow({ disabled }: { disabled?: boolean }) {
  const [checked, setChecked] = useState(false);
  return (
    <SettingsRow
      label="Cursor blink"
      description="Blink the cursor in every terminal"
      disabled={disabled}
    >
      <Switch checked={checked} onCheckedChange={setChecked} disabled={disabled} />
    </SettingsRow>
  );
}

describe('SettingsRow', () => {
  it('names a switch with the row label and describes it with the row description', () => {
    render(<SwitchRow />);

    const toggle = screen.getByRole('switch', { name: 'Cursor blink' });
    expect(toggle).toHaveAccessibleDescription('Blink the cursor in every terminal');
  });

  it('toggles the switch when the label is clicked', async () => {
    const user = userEvent.setup();
    render(<SwitchRow />);

    await user.click(screen.getByText('Cursor blink'));

    expect(screen.getByRole('switch', { name: 'Cursor blink' })).toBeChecked();
  });

  it('names a select with the row label', () => {
    render(
      <SettingsRow label="Line height">
        <Select defaultValue="1.2">
          <option value="1">Tight</option>
          <option value="1.2">Normal</option>
        </Select>
      </SettingsRow>
    );

    expect(screen.getByRole('combobox', { name: 'Line height' })).toBeInTheDocument();
  });

  it('keeps an id the control already has', () => {
    render(
      <SettingsRow label="Vim mode">
        <Switch id="vim-mode" />
      </SettingsRow>
    );

    expect(screen.getByRole('switch', { name: 'Vim mode' })).toHaveAttribute('id', 'vim-mode');
  });

  it('does not press a button when its label is clicked', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <SettingsRow label="Clear logs" description="Delete application log files">
        <Button onClick={onClick}>Clear Logs</Button>
      </SettingsRow>
    );

    await user.click(screen.getByText('Clear logs'));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('passes ids to a render function for controls it cannot wire itself', () => {
    render(
      <SettingsRow label="Cursor style" description="Shape of the cursor">
        {({ labelId, descriptionId }) => (
          <div role="radiogroup" aria-labelledby={labelId} aria-describedby={descriptionId} />
        )}
      </SettingsRow>
    );

    const group = screen.getByRole('radiogroup', { name: 'Cursor style' });
    expect(group).toHaveAccessibleDescription('Shape of the cursor');
  });

  it('keeps the description of a disabled row readable', () => {
    render(<SwitchRow disabled />);

    const description = screen.getByText('Blink the cursor in every terminal');
    expect(description.closest('.opacity-50')).toBeNull();
    expect(screen.getByRole('switch', { name: 'Cursor blink' })).toBeDisabled();
  });
});
