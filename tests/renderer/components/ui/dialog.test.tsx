/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it } from 'vitest';

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../src/renderer/components/ui/dialog';

describe('DialogBody', () => {
  it('scrolls its content and lays the dialog out as a column around it', () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Title</DialogTitle>
            <DialogDescription>Description</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-4">Body content</DialogBody>
          <DialogFooter>
            <button type="button">OK</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );

    const body = screen.getByText('Body content');
    expect(body).toHaveAttribute('data-dialog-body');
    expect(body).toHaveClass('min-h-0', 'flex-1', 'overflow-y-auto', 'space-y-4');
    // A grid row won't shrink below its content, so the dialog switches to a
    // flex column whenever it holds a body.
    expect(screen.getByRole('dialog')).toHaveClass(
      'has-[>[data-dialog-body]]:flex',
      'has-[>[data-dialog-body]]:flex-col'
    );
  });
});
