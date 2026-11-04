import { describe, expect, it } from 'vitest';

import { menuItemClass } from '@/components/ui/menu-styles';

describe('menu item styles', () => {
  // The destructive token is a button fill, about 2.5:1 as text on a dark menu; the error token
  // is the text red each theme tunes to read.
  it('writes a destructive item in the error color, which reads on a dark menu', () => {
    expect(menuItemClass).toContain('data-[variant=destructive]:text-error');
    expect(menuItemClass).toContain('data-[variant=destructive]:[&_svg]:text-error!');
    expect(menuItemClass).not.toMatch(/data-\[variant=destructive\]:(\[&_svg\]:)?text-destructive/);
  });
});
