import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const remoteShellHtml = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
const remoteShellSource = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
const remoteShellStyles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('mobile viewport', () => {
  it('prevents accidental zoom and draws under the notch when installed', () => {
    expect(remoteShellHtml).toContain(
      'content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover"'
    );
  });

  it('can be added to the Home Screen as an app', () => {
    expect(remoteShellHtml).toContain('<link rel="manifest" href="manifest.webmanifest" />');
    expect(remoteShellHtml).toContain(
      '<link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />'
    );
    expect(remoteShellHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
  });
});

describe('remote terminal toolbar', () => {
  it('uses a workspace back action and terminal tabs without cycle arrows', () => {
    expect(remoteShellHtml).toContain('aria-label="Back to workspaces"');
    expect(remoteShellHtml).toContain('id="terminal-workspace-name"');
    expect(remoteShellHtml).toContain('id="terminal-workspace-status"');
    expect(remoteShellHtml).toContain('id="terminal-tabs"');
    expect(remoteShellHtml).not.toContain('id="terminal-select"');
    expect(remoteShellHtml).not.toContain('id="terminal-prev"');
    expect(remoteShellHtml).not.toContain('id="terminal-next"');
  });

  it('shows one tab per running terminal plus a new-terminal tab', () => {
    expect(remoteShellSource).toContain("tab.setAttribute('role', 'tab')");
    expect(remoteShellSource).toContain(
      "tab.setAttribute('aria-selected', String(terminal.id === selectedTerminalId))"
    );
    expect(remoteShellSource).toContain("add.dataset.tabAction = 'new'");
    expect(remoteShellSource).toContain('this.els.terminalTabs.replaceChildren(...tabs, add)');
  });

  it('shows the selected terminal environment in workspace rows and the terminal toolbar', () => {
    expect(remoteShellHtml).toContain('id="terminal-environment"');
    expect(remoteShellSource).toContain('renderWorkspaceEnvironment(workspace)');
    expect(remoteShellSource).toContain('selectedTerminal?.environment');
    expect(remoteShellStyles).toContain('.workspace-environment');
  });

  it('keeps voice and terminal input out of the terminal toolbar', () => {
    expect(remoteShellHtml).not.toContain('id="voice-toolbar"');
    expect(remoteShellHtml).toContain('id="voice-record"');
    expect(remoteShellHtml).toContain('id="terminal-composer"');
    expect(remoteShellHtml).toContain('id="terminal-send"');
  });
});

describe('mobile terminal controls', () => {
  it('offers buffered composer input and raw xterm input by tapping the terminal', () => {
    expect(remoteShellHtml).not.toContain('id="terminal-raw-input"');
    expect(remoteShellHtml).toContain('id="terminal-keys-toggle"');
    expect(remoteShellHtml).toContain('aria-label="Hide terminal keys"');
    expect(remoteShellSource).toContain('private terminalKeysOpen = true');
    expect(remoteShellSource).not.toContain('this.terminalKeysOpen = false');
    expect(remoteShellHtml).toContain('id="mobile-keyboard-bar"');
    expect(remoteShellHtml).toContain('id="voice-use"');
    expect(remoteShellHtml).toContain('placeholder="Write a command or prompt"');
    expect(remoteShellSource).toContain("this.els.terminalComposer.addEventListener('keydown'");
    expect(remoteShellSource).toContain('this.submitTerminalComposer()');
    expect(remoteShellSource).toContain('this.term.paste(input)');
    expect(remoteShellSource).toContain('this.term.input(TERMINAL_ENTER)');
    expect(remoteShellSource).not.toContain('this.sendTerminalInput(input)');
    expect(remoteShellSource).toContain("'touchstart'");
    expect(remoteShellSource).toContain("'touchmove'");
    expect(remoteShellSource).toContain("'touchend'");
    expect(remoteShellSource).toContain('isTerminalTapGesture(');
    expect(remoteShellSource).toContain('this.term.focus()');
  });

  it('keeps the composer controls compact', () => {
    expect(remoteShellHtml.indexOf('id="terminal-keys-toggle"')).toBeLessThan(
      remoteShellHtml.indexOf('id="terminal-composer"')
    );
    expect(remoteShellStyles).toMatch(/\.voice-row \{[\s\S]*height: 52px/);
    expect(remoteShellStyles).toMatch(/\.voice-bar button[\s\S]*height: 38px/);
    expect(remoteShellStyles).toMatch(/\.terminal-composer[\s\S]*height: 38px/);
  });

  it('only exposes useful raw terminal shortcuts', () => {
    expect(remoteShellHtml).toContain('data-terminal-key="esc"');
    expect(remoteShellHtml).toContain('data-terminal-key="tab"');
    expect(remoteShellHtml).toContain('data-terminal-key="ctrl-c"');
    expect(remoteShellHtml).toContain('data-terminal-key="shift-tab"');
    expect(remoteShellHtml).toContain('data-terminal-key="enter"');
    expect(remoteShellSource).toContain('enter: TERMINAL_ENTER');
    expect(remoteShellSource).toContain("'shift-tab': '\\x1b[Z'");
    expect(remoteShellHtml).not.toContain('data-terminal-key="home"');
    expect(remoteShellHtml).not.toContain('data-terminal-key="end"');
    expect(remoteShellHtml).not.toContain('data-terminal-key="page-up"');
    expect(remoteShellHtml).not.toContain('data-terminal-key="page-down"');
    expect(remoteShellHtml).not.toContain('data-terminal-action="copy"');
    expect(remoteShellHtml).not.toContain('data-terminal-action="paste"');
  });

  it('offers voice transcription with and without submitting the terminal prompt', () => {
    expect(remoteShellHtml).toContain('id="voice-use"');
    expect(remoteShellHtml).toContain('>Transcribe</button>');
    expect(remoteShellHtml).toContain('id="voice-send"');
    expect(remoteShellHtml).toMatch(/id="voice-send"[\s\S]*Transcribe &amp; send/);
    expect(remoteShellSource).toContain('this.stopAndTranscribeVoice(false)');
    expect(remoteShellSource).toContain('this.stopAndTranscribeVoice(true)');
    expect(remoteShellSource).toContain('this.submitTerminalText(transcript)');
    expect(remoteShellSource).not.toContain('`${transcript}\\r`');
    expect(remoteShellSource).toContain('this.els.terminalComposer.value = transcript');
  });

  it('uses a minimal jump-to-latest affordance', () => {
    expect(remoteShellHtml).toContain('aria-label="Jump to latest"');
    expect(remoteShellHtml).toMatch(/id="terminal-jump-latest"[\s\S]*>\s*↓\s*<\/button>/);
    expect(remoteShellStyles).toMatch(/\.terminal-jump-latest[\s\S]*width: 32px/);
    expect(remoteShellStyles).toMatch(/\.terminal-jump-latest[\s\S]*border-radius: 999px/);
  });

  it('only explains unavailable voice input after the microphone is tapped', () => {
    expect(remoteShellHtml).not.toContain('id="voice-unavailable"');
    expect(remoteShellSource).toContain(
      "this.els.voiceRecord.addEventListener('click', () => void this.startVoiceRecording())"
    );
    expect(remoteShellSource).toContain(
      'Voice unavailable. Install a model in Komla under Settings → General → Voice Input.'
    );
    expect(remoteShellSource).toContain('if (!this.voiceAvailable)');
    expect(remoteShellSource).not.toContain(
      '!voiceReady || this.voiceStarting || this.pendingVoiceRequestId !== null'
    );
  });

  it('uses native panning with a thin custom position indicator', () => {
    expect(remoteShellHtml).toContain('id="terminal-touch-scroll"');
    expect(remoteShellHtml).toContain('id="terminal-touch-scroll-spacer"');
    expect(remoteShellHtml).toContain('id="terminal-scroll-indicator"');
    expect(remoteShellHtml).toContain('id="terminal-scroll-thumb"');
    expect(remoteShellSource).toContain('this.term.scrollToLine(');
    expect(remoteShellSource).toContain('this.els.terminalScrollThumb.style.height');
    expect(remoteShellSource).toContain('this.els.terminalScrollThumb.style.transform');
    expect(remoteShellStyles).toMatch(/button,[\s\S]*touch-action: manipulation/);
    expect(remoteShellStyles).toMatch(/\.terminal-touch-scroll[\s\S]*overflow-y: scroll/);
    expect(remoteShellStyles).toMatch(/\.terminal-touch-scroll[\s\S]*touch-action: pan-y/);
    expect(remoteShellStyles).toMatch(/\.mobile-keyboard-bar[\s\S]*touch-action: pan-x/);
    expect(remoteShellStyles).toMatch(/\.mobile-keyboard-bar[\s\S]*overflow-y: hidden/);
    expect(remoteShellStyles).toMatch(/#terminal \.xterm-screen[\s\S]*pointer-events: none/);
    expect(remoteShellStyles).toMatch(
      /\.terminal-touch-scroll::\-webkit-scrollbar[\s\S]*display: none/
    );
    expect(remoteShellStyles).toMatch(/#terminal \.xterm-viewport[\s\S]*right: -20px !important/);
    expect(remoteShellStyles).toMatch(
      /#terminal \.xterm-scrollable-element > \.scrollbar[\s\S]*display: none !important/
    );
    expect(remoteShellStyles).toMatch(/\.terminal-scroll-indicator[\s\S]*width: 2px/);
    expect(remoteShellStyles).toMatch(/\.terminal-scroll-indicator[\s\S]*pointer-events: none/);
    expect(remoteShellStyles).toMatch(/\.terminal-touch-scroll[\s\S]*right: -20px/);
    expect(remoteShellStyles).toMatch(/input,[\s\S]*textarea[\s\S]*font-size: 16px/);
    expect(remoteShellSource).toContain('scrollOnUserInput: false');
  });
});

describe('workspace actions', () => {
  it('offers prompt dictation inside the new workspace dialog', () => {
    expect(remoteShellHtml).toContain('id="prompt-voice"');
    expect(remoteShellHtml).toContain('aria-label="Dictate workspace prompt"');
    expect(remoteShellSource).toContain("this.stopAndUseWorkspaceVoice('edit')");
    expect(remoteShellSource).toContain('this.els.promptVoice.addEventListener');
    expect(remoteShellSource).toContain("this.stopAndUseWorkspaceVoice('edit')");
    expect(remoteShellSource).toContain("promptRecording ? 'Stop dictation'");
  });

  it('offers terminal and action creation from the workspace toolbar', () => {
    expect(remoteShellHtml).toContain('id="workspace-actions-trigger"');
    expect(remoteShellHtml).toContain('id="workspace-actions-menu"');
    expect(remoteShellHtml).toContain('id="workspace-actions-root"');
    expect(remoteShellHtml).toContain('id="workspace-actions-submenu"');
    expect(remoteShellHtml).toContain('data-workspace-action="actions"');
    expect(remoteShellHtml).toContain('data-workspace-action="back"');
    expect(remoteShellHtml.indexOf('id="new-tab-agents"')).toBeLessThan(
      remoteShellHtml.indexOf('data-workspace-action="shell"')
    );
    expect(remoteShellHtml).toContain('data-workspace-action="agent"');
    expect(remoteShellSource).toContain('button.dataset.workspaceAction = `agent:${preset.id}`');
    expect(remoteShellSource).toContain('this.launchAgent(action.slice(6))');
    expect(remoteShellHtml).toContain('id="terminal-launch-dialog"');
    expect(remoteShellHtml).toContain('id="terminal-agent-preset"');
    expect(remoteShellHtml).toContain('id="terminal-agent-launch-mode"');
    expect(remoteShellSource).toContain("type: 'app:terminal:create'");
    expect(remoteShellSource).toContain("type: 'app:terminal:close'");
    expect(remoteShellSource).toContain('frame.actions ?? []');
    expect(remoteShellSource).toContain("label: 'Saved prompts'");
    expect(remoteShellSource).toContain("label: 'Terminal commands'");
  });

  it('shows configured launch environments and sends an explicit override', () => {
    expect(remoteShellHtml).toContain('id="environment-field"');
    expect(remoteShellHtml).toContain('id="environment-select"');
    expect(remoteShellSource).toContain('frame.environments');
    expect(remoteShellSource).toContain('environment: selectedEnvironment');
    expect(remoteShellSource).toContain(
      'this.els.environmentField.hidden = this.environments.length < 2'
    );
  });

  it('renders mobile workspaces as edge-to-edge rows instead of cards', () => {
    expect(remoteShellStyles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*\.workspace-list \{[\s\S]*padding: 0 0/
    );
    expect(remoteShellStyles).toMatch(
      /@media \(max-width: 760px\)[\s\S]*\.workspace \{[\s\S]*border-radius: 0/
    );
  });

  it('does not repeat the stopped-workspace Start action in the overflow sheet', () => {
    expect(remoteShellSource).not.toContain("action('Start'");
    expect(remoteShellSource).toContain(
      "action('Restart', () => this.restartWorkspace(workspace.id))"
    );
    expect(remoteShellSource).toContain('buildWorkspaceSections(workspaces, {');
  });

  it('opens workspace and row actions as modal sheets', () => {
    expect(remoteShellHtml).toMatch(/<dialog id="workspace-actions-menu" class="sheet"/);
    expect(remoteShellHtml).toMatch(/<dialog id="workspace-row-sheet" class="sheet"/);
    expect(remoteShellSource).toContain('this.els.workspaceActionsMenu.showModal()');
    expect(remoteShellSource).toContain('this.els.workspaceRowSheet.showModal()');
  });

  it('searches and filters the workspace list', () => {
    expect(remoteShellHtml).toContain('id="workspace-search"');
    expect(remoteShellHtml).toContain('id="workspace-filters"');
    expect(remoteShellSource).toContain('query: this.workspaceQuery');
    expect(remoteShellSource).toContain('filter: this.workspaceFilter');
  });
});
