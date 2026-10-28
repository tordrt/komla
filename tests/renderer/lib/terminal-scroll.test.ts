import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock DOM elements before importing the module
function createMockElement(): any {
  const children: any[] = [];
  return {
    style: {} as Record<string, string>,
    parentElement: null as any,
    setAttribute: vi.fn(),
    appendChild(child: any) {
      child.parentElement = this;
      children.push(child);
    },
    removeChild(child: any) {
      child.parentElement = null;
      const idx = children.indexOf(child);
      if (idx >= 0) children.splice(idx, 1);
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.removeChild(this);
      }
    },
    _children: children,
  };
}

const mockBody = createMockElement();

vi.stubGlobal('document', {
  createElement: vi.fn(() => createMockElement()),
  body: mockBody,
});

vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
  cb(0);
  return 0;
});

let scrollModule: typeof import('../../../src/renderer/lib/terminal-scroll');

async function loadModules() {
  vi.resetModules();
  scrollModule = await import('../../../src/renderer/lib/terminal-scroll');
}

function createMockTerminal(overrides?: { viewportY?: number; baseY?: number }) {
  const viewportY = overrides?.viewportY ?? 0;
  const baseY = overrides?.baseY ?? 0;
  return {
    buffer: {
      active: { viewportY, baseY },
    },
    loadAddon: vi.fn(),
    write: vi.fn((_data: string, callback?: () => void) => callback?.()),
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
  };
}

describe('terminal-scroll', () => {
  beforeEach(async () => {
    await loadModules();
  });

  describe('loadRenderAddon', () => {
    it('calls terminal.loadAddon with the provided addon', () => {
      const terminal = createMockTerminal({ viewportY: 0, baseY: 0 });
      const addon = { dispose: vi.fn() };

      scrollModule.loadRenderAddon(terminal as any, addon as any);

      expect(terminal.loadAddon).toHaveBeenCalledWith(addon);
    });

    it('scrolls to bottom when terminal was at bottom before load', () => {
      const terminal = createMockTerminal({ viewportY: 100, baseY: 100 });
      const addon = { dispose: vi.fn() };

      scrollModule.loadRenderAddon(terminal as any, addon as any);

      expect(terminal.scrollToBottom).toHaveBeenCalled();
      expect(terminal.scrollToLine).not.toHaveBeenCalled();
    });

    it('scrolls to bottom when viewportY exceeds baseY', () => {
      const terminal = createMockTerminal({ viewportY: 150, baseY: 100 });
      const addon = { dispose: vi.fn() };

      scrollModule.loadRenderAddon(terminal as any, addon as any);

      expect(terminal.scrollToBottom).toHaveBeenCalled();
    });

    it('restores exact scroll position when not at bottom', () => {
      const terminal = createMockTerminal({ viewportY: 42, baseY: 200 });
      const addon = { dispose: vi.fn() };

      scrollModule.loadRenderAddon(terminal as any, addon as any);

      expect(terminal.scrollToLine).toHaveBeenCalledWith(42);
      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    });

    it('restores scroll even when loadAddon throws', () => {
      const terminal = createMockTerminal({ viewportY: 50, baseY: 200 });
      terminal.loadAddon.mockImplementation(() => {
        throw new Error('WebGL context lost');
      });
      const addon = { dispose: vi.fn() };

      expect(() => scrollModule.loadRenderAddon(terminal as any, addon as any)).toThrow(
        'WebGL context lost'
      );

      expect(terminal.scrollToLine).toHaveBeenCalledWith(50);
    });

    it('does not mask addon error when scroll restore also throws', () => {
      const terminal = createMockTerminal({ viewportY: 0, baseY: 0 });
      terminal.loadAddon.mockImplementation(() => {
        throw new Error('addon failed');
      });
      terminal.scrollToBottom.mockImplementation(() => {
        throw new Error('scroll failed');
      });
      const addon = { dispose: vi.fn() };

      expect(() => scrollModule.loadRenderAddon(terminal as any, addon as any)).toThrow(
        'addon failed'
      );
    });

    it('handles zero scrollback (viewportY=0, baseY=0) as at-bottom', () => {
      const terminal = createMockTerminal({ viewportY: 0, baseY: 0 });
      const addon = { dispose: vi.fn() };

      scrollModule.loadRenderAddon(terminal as any, addon as any);

      expect(terminal.scrollToBottom).toHaveBeenCalled();
    });

    // Note: xterm 5 had a deferred RAF restore to handle a stale _currentRowHeight
    // cache race. xterm 6's DomScrollableElement reads dimensions synchronously
    // from the active renderer, so only the synchronous restore is needed.
  });

  describe('follow-bottom state', () => {
    it('follows the new bottom after a PTY write when follow mode is active', () => {
      const terminal = createMockTerminal({ viewportY: 100, baseY: 200 });
      const state = scrollModule.createTerminalScrollFollowState();

      scrollModule.writeTerminalDataFollowingScroll(terminal as any, state, 'output');

      expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
      expect(state.pendingWrites).toBe(0);
    });

    it('does not refresh the viewport after a write that xterm already followed', () => {
      const terminal = createMockTerminal({ viewportY: 200, baseY: 200 });
      const state = scrollModule.createTerminalScrollFollowState();

      scrollModule.writeTerminalDataFollowingScroll(terminal as any, state, 'output');

      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    });

    it('preserves scrollback when the user has opted out of follow mode', () => {
      const terminal = createMockTerminal({ viewportY: 100, baseY: 200 });
      const state = { followBottom: false, pendingWrites: 0 };

      scrollModule.writeTerminalDataFollowingScroll(terminal as any, state, 'output');

      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
    });

    it('updates follow intent from visible user scrolling', () => {
      const terminal = createMockTerminal({ viewportY: 100, baseY: 200 });
      const state = scrollModule.createTerminalScrollFollowState();

      scrollModule.updateTerminalScrollFollow(terminal as any, state, true);

      expect(state.followBottom).toBe(false);
    });

    it('ignores viewport drift caused by hidden or pending writes', () => {
      const terminal = createMockTerminal({ viewportY: 100, baseY: 200 });
      const state = { followBottom: true, pendingWrites: 1 };

      scrollModule.updateTerminalScrollFollow(terminal as any, state, true);
      scrollModule.updateTerminalScrollFollow(terminal as any, state, false);

      expect(state.followBottom).toBe(true);
    });

    it('preserves user scroll intent while writes are pending', () => {
      const terminal = createMockTerminal({ viewportY: 100, baseY: 200 });
      const state = { followBottom: true, pendingWrites: 1 };

      scrollModule.updateTerminalScrollFollow(terminal as any, state, true, true);

      expect(state.followBottom).toBe(false);
    });

    it('stops following immediately when the user wheels up', () => {
      const state = scrollModule.createTerminalScrollFollowState();

      scrollModule.stopTerminalScrollFollowOnWheel(state, { deltaY: -1 });

      expect(state.followBottom).toBe(false);
    });

    it('stops following immediately when the user pages up', () => {
      const state = scrollModule.createTerminalScrollFollowState();

      scrollModule.stopTerminalScrollFollowOnKey(state, { key: 'PageUp', shiftKey: true });

      expect(state.followBottom).toBe(false);
    });

    it('preserves a search result when a pending PTY write completes', () => {
      const terminal = createMockTerminal({ viewportY: 200, baseY: 200 });
      const state = scrollModule.createTerminalScrollFollowState();
      let finishWrite: (() => void) | undefined;
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        finishWrite = callback;
      });

      scrollModule.writeTerminalDataFollowingScroll(terminal as any, state, 'output');
      scrollModule.stopTerminalScrollFollowForSearch(state);
      terminal.buffer.active.viewportY = 100;
      finishWrite?.();

      expect(terminal.scrollToBottom).not.toHaveBeenCalled();
      expect(state.followBottom).toBe(false);
    });

    it('resumes following when the user explicitly scrolls to bottom during a pending write', () => {
      const terminal = createMockTerminal({ viewportY: 100, baseY: 200 });
      const state = { followBottom: false, pendingWrites: 0 };
      let finishWrite: (() => void) | undefined;
      terminal.write.mockImplementation((_data: string, callback?: () => void) => {
        finishWrite = callback;
      });

      scrollModule.writeTerminalDataFollowingScroll(terminal as any, state, 'output');
      scrollModule.startTerminalScrollFollow(state);
      finishWrite?.();

      expect(terminal.scrollToBottom).toHaveBeenCalledOnce();
      expect(state.followBottom).toBe(true);
    });
  });
});
