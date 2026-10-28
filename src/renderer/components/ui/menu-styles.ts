// Shared by the dropdown and context menus so the two read the same.

// The outer radius is the item radius plus the padding, so the corners nest. tailwind-merge
// doesn't let a `w-*` cancel the `min-w-44` floor, so a menu with its own width adds `min-w-0`.
// No exit animation: a menu kept mounted to animate out takes focus back from what its item
// opened (see menu-close.test.tsx).
export const menuContentClass =
  'floating-surface z-50 max-h-(--radix-popper-available-height) min-w-44 origin-(--radix-popper-transform-origin) overflow-x-hidden overflow-y-auto rounded-[calc(var(--radius)+2px)] border p-1 text-popover-foreground shadow-xl data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1';

// 12px at weight 450, as Orca sets them, reads crisper than 13px regular. Icons default to 14px;
// one with its own size keeps it.
const menuRowClass =
  "relative flex cursor-default select-none items-center gap-2 rounded-md py-1 text-[12px] leading-[17px] font-[450] outline-hidden focus:bg-foreground/8 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5";

// Leading icons are muted unless they bring their own color.
const mutedIconClass = "[&_svg:not([class*='text-'])]:text-muted-foreground";

export const menuItemClass = `${menuRowClass} ${mutedIconClass} px-2 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:[&_svg]:text-destructive!`;

export const menuSubTriggerClass = `${menuRowClass} ${mutedIconClass} px-2 data-[state=open]:bg-foreground/8`;

// Checkbox and radio rows leave room on the left for the indicator. Only their own leading icons
// are muted; the check inside the indicator keeps the text color.
export const menuCheckRowClass = `${menuRowClass} pr-2 pl-7 [&>svg:not([class*='text-'])]:text-muted-foreground`;

export const menuIndicatorClass = 'absolute left-2 flex size-3.5 items-center justify-center';

export const menuLabelClass =
  'px-2 pt-1.5 pb-1 text-[11px] leading-4 font-medium text-muted-foreground';

// A tint of the text color, as the border token matches the lifted dark surface.
export const menuSeparatorClass = 'my-1 h-px bg-foreground/10';

export const menuShortcutClass = 'ml-auto pl-4 text-[11px] whitespace-nowrap text-muted-foreground';
