import { SegmentedControl } from '@/components/ui/segmented-control';
import { useConfigStore } from '@/stores/config.store';

import {
  DEFAULT_STATUS_BAR_SIZE,
  STATUS_BAR_SIZES,
  type StatusBarSize,
} from '../../../../shared/lib/status-bar-size';

const SIZE_LABELS: Record<StatusBarSize, string> = {
  small: 'Small',
  medium: 'Medium',
  large: 'Large',
};

const SIZE_OPTIONS = STATUS_BAR_SIZES.map((value) => ({ value, label: SIZE_LABELS[value] }));

/** Picks how tall the status bar is, in Settings and in the bar's customize panel. */
export function StatusBarSizeControl({
  size = 'sm',
  disabled,
}: {
  size?: 'xs' | 'sm';
  disabled?: boolean;
}) {
  const value = useConfigStore((s) => s.config?.statusBarSize ?? DEFAULT_STATUS_BAR_SIZE);
  const updateConfig = useConfigStore((s) => s.updateConfig);
  return (
    <SegmentedControl
      aria-label="Status bar size"
      size={size}
      disabled={disabled}
      value={value}
      onValueChange={(statusBarSize) => void updateConfig({ statusBarSize })}
      options={SIZE_OPTIONS}
    />
  );
}
