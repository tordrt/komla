import { Check, CaretRight, Circle } from '@phosphor-icons/react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import * as React from 'react';

import { cn } from '@/lib/utils';

import {
  menuCheckRowClass,
  menuContentClass,
  menuIndicatorClass,
  menuItemClass,
  menuLabelClass,
  menuSeparatorClass,
  menuShortcutClass,
  menuSubTriggerClass,
} from './menu-styles';

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

// Radix also selects an item on a pointerup whose press started elsewhere, so a press can be
// dragged onto a row. That picked whatever row a menu grew under the pointer while its trigger was
// still pressed. Selection is left to the click, which needs the press to start on the row.
function ignorePressFromElsewhere(onPointerUp?: React.PointerEventHandler<HTMLDivElement>) {
  return (event: React.PointerEvent<HTMLDivElement>) => {
    onPointerUp?.(event);
    event.preventDefault();
  };
}

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & {
    inset?: boolean;
    /** Leaves out the caret, for an icon that says it opens more on its own. */
    hideCaret?: boolean;
  }
>(({ className, inset, hideCaret, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(menuSubTriggerClass, inset && 'pl-7', className)}
    {...props}
  >
    {children}
    {!hideCaret && <CaretRight className="ml-auto" />}
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      data-native-overlay="menu"
      ref={ref}
      className={cn(menuContentClass, className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> & {
    // Radix's menu passes this through to its FocusScope but leaves it out of the public types.
    onOpenAutoFocus?: (event: Event) => void;
  }
>(({ className, sideOffset = 4, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      data-native-overlay="menu"
      ref={ref}
      sideOffset={sideOffset}
      className={cn(menuContentClass, className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    variant?: 'default' | 'destructive';
  }
>(({ className, inset, variant = 'default', ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    data-variant={variant}
    className={cn(menuItemClass, inset && 'pl-7', className)}
    {...props}
    onPointerUp={ignorePressFromElsewhere(props.onPointerUp)}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem> & {
    uncheckedIndicator?: React.ReactNode;
    indicatorClassName?: string;
  }
>(({ className, children, checked, uncheckedIndicator, indicatorClassName, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(menuCheckRowClass, className)}
    checked={checked}
    {...props}
    onPointerUp={ignorePressFromElsewhere(props.onPointerUp)}
  >
    <span className={menuIndicatorClass}>
      <DropdownMenuPrimitive.ItemIndicator>
        <Check className={indicatorClassName} />
      </DropdownMenuPrimitive.ItemIndicator>
      {!checked && uncheckedIndicator}
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(menuCheckRowClass, className)}
    {...props}
    onPointerUp={ignorePressFromElsewhere(props.onPointerUp)}
  >
    <span className={menuIndicatorClass}>
      <DropdownMenuPrimitive.ItemIndicator>
        <Circle weight="fill" className="size-2" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

/** A radio item drawn as one segment of a row, for a choice between two or three short options. */
const DropdownMenuSegmentItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(
      'cursor-default rounded-sm px-2 py-0.5 text-[11px] leading-4 font-[450] text-muted-foreground outline-hidden select-none data-highlighted:bg-foreground/8 data-highlighted:text-foreground data-[state=checked]:bg-foreground/14 data-[state=checked]:text-foreground',
      className
    )}
    {...props}
    onPointerUp={ignorePressFromElsewhere(props.onPointerUp)}
  />
));
DropdownMenuSegmentItem.displayName = 'DropdownMenuSegmentItem';

/** A checkbox item drawn with a switch at its end, for a setting rather than a filter. */
const DropdownMenuSwitchItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(menuItemClass, className)}
    checked={checked}
    {...props}
    onPointerUp={ignorePressFromElsewhere(props.onPointerUp)}
  >
    <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    <span
      aria-hidden="true"
      className={cn(
        'ml-3 flex h-3.5 w-6 shrink-0 items-center rounded-full p-0.5 transition-colors',
        checked === true ? 'bg-primary' : 'bg-foreground/20'
      )}
    >
      <span
        className={cn(
          'size-2.5 rounded-full transition-transform motion-reduce:transition-none',
          checked === true ? 'translate-x-2.5 bg-primary-foreground' : 'bg-foreground'
        )}
      />
    </span>
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuSwitchItem.displayName = 'DropdownMenuSwitchItem';

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & {
    inset?: boolean;
  }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(menuLabelClass, inset && 'pl-7', className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    className={cn(menuSeparatorClass, className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

const DropdownMenuShortcut = ({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) => {
  return <span className={cn(menuShortcutClass, className)} {...props} />;
};
DropdownMenuShortcut.displayName = 'DropdownMenuShortcut';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuSegmentItem,
  DropdownMenuSwitchItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
};
