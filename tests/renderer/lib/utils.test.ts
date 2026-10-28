import { describe, it, expect } from 'vitest';
import { cn } from '../../../src/renderer/lib/utils';

describe('cn', () => {
  it('merges class names', () => {
    expect(cn('foo', 'bar')).toBe('foo bar');
  });

  it('handles conditional classes', () => {
    expect(cn('base', false && 'hidden', 'visible')).toBe('base visible');
  });

  it('resolves tailwind conflicts (last wins)', () => {
    expect(cn('px-4', 'px-2')).toBe('px-2');
  });

  it('handles empty inputs', () => {
    expect(cn()).toBe('');
  });

  it('handles undefined and null values', () => {
    expect(cn('foo', undefined, null, 'bar')).toBe('foo bar');
  });

  it('handles array inputs', () => {
    expect(cn(['foo', 'bar'])).toBe('foo bar');
  });

  it('merges conflicting tailwind utilities', () => {
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('preserves non-conflicting classes', () => {
    expect(cn('p-4', 'text-lg', 'bg-white')).toBe('p-4 text-lg bg-white');
  });

  it('treats the custom type scale as font sizes, not colors', () => {
    expect(cn('text-ui', 'text-muted-foreground')).toBe('text-ui text-muted-foreground');
    expect(cn('text-success', 'text-ui')).toBe('text-success text-ui');
    expect(cn('text-xs', 'text-ui')).toBe('text-ui');
    expect(cn('text-ui', 'text-2xs')).toBe('text-2xs');
  });
});
