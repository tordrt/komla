import { describe, expect, it } from 'vitest';

import {
  toastOverlayEventArgsSchema,
  toastOverlayShowArgsSchema,
} from '../../../../src/main/ipc/validation/toast-overlay-ipc.schemas';

const state = {
  bounds: { x: 900.5, y: 740, width: 284, height: 44 },
  toasts: [{ id: 'a1', message: 'Saved', type: 'success', dismissOnTimeout: true }],
  themeClassName: 'dark',
  themeStyle: '--primary: 0.5 0.1 200;',
  messageMaxHeight: 320,
};

describe('toast overlay IPC schemas', () => {
  it('accepts the stack bounds, toasts and theme of the main window', () => {
    expect(toastOverlayShowArgsSchema.parse([state])).toEqual([state]);
  });

  it('keeps whether a toast reports work that is still running', () => {
    const deleting = {
      ...state,
      toasts: [
        {
          id: 'a1',
          message: 'Deleting workspace…',
          type: 'info',
          dismissOnTimeout: false,
          progress: true,
        },
      ],
    };
    expect(toastOverlayShowArgsSchema.parse([deleting])).toEqual([deleting]);
  });

  it('rejects an empty stack, unusable bounds and unknown toast types', () => {
    expect(() => toastOverlayShowArgsSchema.parse([{ ...state, toasts: [] }])).toThrow();
    expect(() =>
      toastOverlayShowArgsSchema.parse([{ ...state, bounds: { ...state.bounds, width: 0 } }])
    ).toThrow();
    expect(() =>
      toastOverlayShowArgsSchema.parse([
        { ...state, toasts: [{ ...state.toasts[0], type: 'warning' }] },
      ])
    ).toThrow();
  });

  it('accepts only removals and actions for a toast id', () => {
    expect(toastOverlayEventArgsSchema.parse([{ type: 'remove', id: 'a1' }])).toEqual([
      { type: 'remove', id: 'a1' },
    ]);
    expect(() => toastOverlayEventArgsSchema.parse([{ type: 'focus', id: 'a1' }])).toThrow();
    expect(() => toastOverlayEventArgsSchema.parse([{ type: 'remove', id: '' }])).toThrow();
  });
});
