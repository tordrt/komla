import { describe, expect, it } from 'vitest';

import {
  applyTerminalModifiers,
  isTerminalTapGesture,
  flingStep,
  isTerminalViewportAtBottom,
  railWheelRate,
  scrollThumbLine,
  TerminalMutationQueue,
  terminalProgramScrolls,
} from '../terminal-interaction';

describe('mobile terminal interaction', () => {
  it('applies latched Ctrl and Alt modifiers to the next typed character', () => {
    expect(applyTerminalModifiers('c', true, false)).toBe('\x03');
    expect(applyTerminalModifiers('x', false, true)).toBe('\x1bx');
    expect(applyTerminalModifiers('d', true, true)).toBe('\x1b\x04');
  });

  it('does not rewrite multi-character paste input as a control code', () => {
    expect(applyTerminalModifiers('paste', true, false)).toBe('paste');
  });

  it('leaves scrolling to a program on the alternate screen or reading the wheel', () => {
    expect(terminalProgramScrolls('normal', 'none')).toBe(false);
    // X10 reports only button presses, so the wheel still scrolls the scrollback.
    expect(terminalProgramScrolls('normal', 'x10')).toBe(false);
    expect(terminalProgramScrolls('alternate', 'none')).toBe(true);
    expect(terminalProgramScrolls('alternate', 'drag')).toBe(true);
    expect(terminalProgramScrolls('normal', 'vt200')).toBe(true);
    expect(terminalProgramScrolls('normal', 'any')).toBe(true);
  });

  it('maps a dragged scrollbar thumb to the scrollback line it points at', () => {
    // A 400 px track with a 40 px thumb grabbed 10 px below its top, over 180 lines.
    expect(scrollThumbLine(10, 10, 400, 40, 180)).toBe(0);
    expect(scrollThumbLine(190, 10, 400, 40, 180)).toBe(90);
    expect(scrollThumbLine(370, 10, 400, 40, 180)).toBe(180);
    // Past either end of the track it stays at that end.
    expect(scrollThumbLine(-50, 10, 400, 40, 180)).toBe(0);
    expect(scrollThumbLine(900, 10, 400, 40, 180)).toBe(180);
    expect(scrollThumbLine(100, 10, 40, 40, 180)).toBe(180);
  });

  it('scrolls a fullscreen program faster the further the rail thumb is pulled', () => {
    expect(railWheelRate(0)).toBe(0);
    expect(railWheelRate(-6)).toBe(0);
    expect(railWheelRate(-40)).toBeLessThan(0);
    expect(railWheelRate(40)).toBe(-railWheelRate(-40));
    expect(railWheelRate(120)).toBeGreaterThan(railWheelRate(40));
    expect(railWheelRate(10_000)).toBe(railWheelRate(20_000));
  });

  it('lets a flick coast to a stop', () => {
    const first = flingStep(2, 16);
    expect(first.distance).toBeCloseTo(32);
    expect(first.velocity).toBeLessThan(2);
    expect(first.velocity).toBeGreaterThan(1.8);
    let velocity = -2;
    let travelled = 0;
    let frames = 0;
    while (velocity !== 0 && frames < 1000) {
      const step = flingStep(velocity, 16);
      travelled += step.distance;
      velocity = step.velocity;
      frames++;
    }
    expect(velocity).toBe(0);
    expect(frames).toBeLessThan(200);
    expect(travelled).toBeLessThan(-400);
    expect(travelled).toBeGreaterThan(-800);
  });

  it('follows output only while the viewport is already at the bottom', () => {
    expect(isTerminalViewportAtBottom(12, 12)).toBe(true);
    expect(isTerminalViewportAtBottom(11, 12)).toBe(false);
  });

  it('waits for an asynchronous snapshot write before applying a reset and newer output', () => {
    const queue = new TerminalMutationQueue();
    const events: string[] = [];
    let finishSnapshot: (() => void) | undefined;

    queue.enqueue((done) => {
      events.push('snapshot:start');
      finishSnapshot = () => {
        events.push('snapshot:finish');
        done();
      };
    });
    queue.enqueue((done) => {
      events.push('reset');
      done();
    });
    queue.enqueue((done) => {
      events.push('new-output');
      done();
    });

    expect(events).toEqual(['snapshot:start']);
    finishSnapshot?.();
    expect(events).toEqual(['snapshot:start', 'snapshot:finish', 'reset', 'new-output']);
  });
});

describe('isTerminalTapGesture', () => {
  it('accepts a stationary tap', () => {
    expect(isTerminalTapGesture(4, 0)).toBe(true);
  });

  it('rejects terminal scrolling and dragged touches', () => {
    expect(isTerminalTapGesture(11, 0)).toBe(false);
    expect(isTerminalTapGesture(4, 2)).toBe(false);
  });
});
