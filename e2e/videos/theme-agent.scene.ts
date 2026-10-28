/**
 * The theme-agent video's world: an agent started from Settings → Appearance
 * has asked what look you want; your answer becomes a theme that Komla
 * previews live until you apply it.
 */
import type { VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_WEB, BACKGROUND_WORKSPACES, DEVBOX } from './worlds';

export const THEME_PROMPT = 'Warm and earthy, like a cabin at night';

// A real custom theme; Komla checks its contrast before previewing it.
const EMBER = {
  palette: 'custom',
  customPalette: {
    name: 'Ember',
    mode: 'dark',
    surfaces: {
      background: '#1c130d',
      card: '#251a12',
      popover: '#2b1f16',
      muted: '#31241a',
      highlight: '#4a3322',
      border: '#5e4330',
    },
    terminal: {
      background: '#1c130d',
      foreground: '#eadbc8',
      cursor: '#f2a65a',
      selection: '#4a3322',
      ansi: {
        red: '#e2725b',
        green: '#a8c47c',
        yellow: '#f2c46d',
        blue: '#86a8c8',
        magenta: '#cf8fae',
        cyan: '#7fbfb0',
      },
    },
  },
  accent: 'oklch(0.78 0.14 65)',
  borderRadius: 10,
};

export const THEME: VideoWorkspace = {
  id: 'ws-theme',
  projectId: ACME_WEB.id,
  title: 'Komla Theme',
  branch: 'komla-theme',
  minutesAgo: 1,
  agent: {
    title: '✳ Komla theme',
    history: [
      { prompt: "Customize Komla's appearance" },
      {
        tool: 'Bash',
        arg: 'komla settings get appearance',
        result: ['{ "palette": "default", "borderRadius": 8, … }'],
      },
      {
        say: 'What look would you like? Describe a mood or colors you like, or name a theme to start from.',
      },
      { done: 'Baked for 6s' },
    ],
    turns: [
      {
        verb: 'Mixing',
        doneVerb: 'Brewed',
        events: [
          { write: 'theme.json', content: `${JSON.stringify(EMBER, null, 2)}\n`, delay: 800 },
          { appearance: 'theme.json', delay: 500 },
          {
            say: 'Kept **Ember**: warm brown surfaces, an amber accent and terminal colors to match. This workspace was only for the theme, so you can delete it.',
            delay: 300,
          },
        ],
      },
    ],
  },
};

export const THEME_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [ACME_WEB],
  workspaces: [THEME, ...BACKGROUND_WORKSPACES],
};
