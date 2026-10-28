/**
 * @vitest-environment jsdom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TrashCleanupCard } from '../../../../../src/renderer/components/layout/settings/TrashCleanupCard';

describe('TrashCleanupCard', () => {
  // jsdom lays nothing out, like a card that mounts hidden: a height measured then is 0.
  it('leaves the command field its own height when it mounts before layout', () => {
    render(<TrashCleanupCard script="" onScriptChange={vi.fn()} />);

    expect(screen.getByRole('textbox', { name: 'Trash cleanup command' }).style.height).toBe('');
  });
});
