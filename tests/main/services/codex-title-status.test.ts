import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexTitleStatus } from '../../../src/main/services/terminal-attention/codex-title-status';

describe('Codex title fallback', () => {
  const emit = vi.fn();
  let status: CodexTitleStatus;
  beforeEach(() => {
    vi.useFakeTimers();
    emit.mockReset();
    status = new CodexTitleStatus(emit);
  });
  afterEach(() => {
    status.clear();
    vi.useRealTimers();
  });

  it('settles a /review working-to-ready title cycle when no root Stop arrives', async () => {
    status.hook('t', 'codex', 'activity');
    status.title('t', '⠋ project');
    status.title('t', '⠙ project');
    status.title('t', 'project');
    emit.mockClear();
    await vi.advanceTimersByTimeAsync(1999);
    expect(emit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(emit).toHaveBeenCalledWith('t', 'turn-complete');
  });

  it.each(['activity', 'prompt-submit', 'input-required', 'turn-complete'])(
    'lets a newer %s hook cancel inferred completion',
    async (kind) => {
      status.hook('t', 'codex', 'activity');
      status.title('t', '⠋ project');
      status.title('t', 'project');
      status.hook('t', 'codex', kind);
      emit.mockClear();
      await vi.advanceTimersByTimeAsync(5000);
      expect(emit).not.toHaveBeenCalled();
    }
  );

  it('does not guess completion from silence, arbitrary titles or another agent', async () => {
    status.title('unknown', '⠋ project');
    status.title('unknown', 'project');
    status.hook('t', 'codex', 'activity');
    status.title('t', '⠋ project');
    status.title('t', 'bash');
    status.hook('other', 'claude-code', 'activity');
    status.title('other', '⠋ project');
    status.title('other', 'project');
    emit.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores the spinner Codex shows until it names a new thread', async () => {
    status.hook('t', 'codex', 'prompt-submit');
    status.title('t', '⠋ ⠋ | project');
    expect(emit).toHaveBeenCalledWith('t', 'activity');
    status.hook('t', 'codex', 'turn-complete');
    emit.mockClear();
    status.title('t', '⠴ | project');
    status.title('t', '⠦ | project');
    status.title('t', 'project');
    status.title('t', 'Respond to greeting | project');
    await vi.advanceTimersByTimeAsync(5000);
    expect(emit).not.toHaveBeenCalled();
  });

  it('cancels on resumed title activity and terminal closure', async () => {
    status.hook('t', 'codex', 'activity');
    status.title('t', '⠋ project');
    status.title('t', 'project');
    status.title('t', '⠙ project');
    emit.mockClear();
    await vi.advanceTimersByTimeAsync(3000);
    expect(emit).not.toHaveBeenCalled();
    status.title('t', 'project');
    status.close('t');
    await vi.advanceTimersByTimeAsync(3000);
    expect(emit).not.toHaveBeenCalled();
  });
});
