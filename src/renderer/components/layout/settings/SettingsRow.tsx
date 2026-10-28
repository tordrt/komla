import { cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from 'react';

import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** Ids a row's control uses to take its name and description from the row. */
export interface SettingsRowIds {
  /** Put on the labelable control (input, select, switch) the row label names. */
  controlId: string;
  /** For controls that can't be labelled with `<label for>`, via `aria-labelledby`. */
  labelId: string;
  descriptionId: string | undefined;
}

interface SettingsRowProps {
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  /** A Switch, Select or Input is wired to the label automatically. Anything else
   *  can take the ids from a render function. */
  children: ReactNode | ((ids: SettingsRowIds) => ReactNode);
}

// Primitives that pass `id` and `aria-describedby` through to the form control.
const LABELLABLE_CONTROLS: unknown[] = [Switch, Select, Input];

type LabellableProps = { id?: string; 'aria-describedby'?: string };

function isLabellableControl(node: ReactNode): node is ReactElement<LabellableProps> {
  return isValidElement(node) && LABELLABLE_CONTROLS.includes(node.type);
}

export function SettingsRow({ label, description, disabled, children }: SettingsRowProps) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const descriptionId = description ? `${baseId}-description` : undefined;
  let controlId = `${baseId}-control`;
  let control: ReactNode;
  let labelsControl = true;

  if (typeof children === 'function') {
    control = children({ controlId, labelId, descriptionId });
  } else if (isLabellableControl(children)) {
    controlId = children.props.id ?? controlId;
    control = cloneElement(children, {
      id: controlId,
      'aria-describedby': children.props['aria-describedby'] ?? descriptionId,
    });
  } else {
    // Buttons and composite controls name themselves; a label `for` a button
    // would press it when the label is clicked.
    control = children;
    labelsControl = false;
  }

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 transition-colors',
        !disabled && 'hover:bg-accent/50'
      )}
    >
      <div className="min-w-0">
        <label
          id={labelId}
          htmlFor={labelsControl ? controlId : undefined}
          className={cn(
            'text-sm font-medium leading-tight',
            // Clicking the label toggles a switch, so it should look clickable.
            disabled
              ? 'text-muted-foreground'
              : isValidElement(children) && children.type === Switch && 'cursor-pointer'
          )}
        >
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="mt-0.5 text-[13px] leading-normal text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
