import { describe, expect, it } from 'vitest';

import { TerminalSizeOwner } from '../terminal-size-owner';

const said = (owner: 'desktop' | 'remote', cols: number, rows = 40, terminalId = 't1') => ({
  terminalId,
  owner,
  cols,
  rows,
});

describe('terminal size owner', () => {
  it('follows the desktop taking the attached terminal’s size', () => {
    const size = new TerminalSizeOwner();
    expect(size.follow(said('desktop', 140, 40, 't2'), 't1')).toBeNull();
    expect(size.desktopSize('t1')).toBeNull();

    expect(size.follow(said('desktop', 140), 't1')).toBe('desktop');
    expect(size.desktopSize('t1')).toEqual({ cols: 140, rows: 40 });
    // Only for the terminal it was said about.
    expect(size.desktopSize('t2')).toBeNull();
  });

  it('ignores what the desktop said before it heard this device take the size back', () => {
    const size = new TerminalSizeOwner();
    size.follow(said('desktop', 140), 't1');

    expect(size.claim('t2')).toBeNull();
    expect(size.claim('t1')).toEqual({ cols: 140, rows: 40 });
    expect(size.desktopSize('t1')).toBeNull();
    expect(size.claim('t1')).toBeNull();
    expect(size.follow(said('desktop', 160), 't1')).toBeNull();
    expect(size.desktopSize('t1')).toBeNull();

    expect(size.follow(said('remote', 50, 20), 't1')).toBeNull();
    expect(size.follow(said('desktop', 160), 't1')).toBe('desktop');
    expect(size.desktopSize('t1')).toEqual({ cols: 160, rows: 40 });
  });

  it('fits again when a resize it sent anyway took the size back', () => {
    const size = new TerminalSizeOwner();
    size.follow(said('desktop', 140), 't1');

    expect(size.follow(said('remote', 50, 20), 't1')).toBe('remote');
    expect(size.desktopSize('t1')).toBeNull();
  });

  it('keeps the desktop’s size when the resize that would take it back could not be sent', () => {
    const size = new TerminalSizeOwner();
    size.follow(said('desktop', 140), 't1');
    const given = size.claim('t1')!;

    size.unclaim('t1', given);
    expect(size.desktopSize('t1')).toEqual({ cols: 140, rows: 40 });
    expect(size.follow(said('desktop', 160), 't1')).toBe('desktop');
  });

  it('forgets everything on a new attach, which takes the size itself', () => {
    const size = new TerminalSizeOwner();
    size.follow(said('desktop', 140), 't1');
    size.forget();
    expect(size.desktopSize('t1')).toBeNull();

    size.follow(said('desktop', 140), 't1');
    size.claim('t1');
    size.forget();
    expect(size.follow(said('desktop', 160), 't1')).toBe('desktop');
  });
});
