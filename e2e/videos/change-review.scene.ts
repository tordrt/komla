/** The dark-mode workspace and agent turn behind the change-review video. */
import type { VideoWorkspace } from './video-fixtures';
import { ACME_WEB } from './worlds';

const THEME_TOGGLE_TSX = `import { useEffect, useState } from 'react';
import { getInitialTheme, type Theme } from '../lib/theme';

export function ThemeToggle({ label }: { label: string }) {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);

  return (
    <button
      className="theme-toggle"
      aria-label={label}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      {theme === 'dark' ? 'Light' : 'Dark'}
    </button>
  );
}
`;

export const DARK_MODE_PROMPT = 'Add a dark mode toggle to the header';

export const DARK_MODE_WORKSPACE: VideoWorkspace = {
  id: 'ws-dark',
  projectId: ACME_WEB.id,
  title: 'Dark Mode',
  branch: 'dark-mode-toggle',
  minutesAgo: 0,
  agent: {
    title: '✳ Dark mode toggle',
    turns: [
      {
        verb: 'Spelunking',
        doneVerb: 'Baked',
        events: [
          { tool: 'Read', arg: 'src/lib/theme.ts', result: ['Read 5 lines'], delay: 600 },
          {
            edit: 'src/styles/tokens.css',
            find: 'body {',
            replace:
              "[data-theme='dark'] {\n  --bg: #0b0d12;\n  --surface: #151922;\n  --text: #e5e7eb;\n  --muted: #9ca3af;\n}\n\nbody {",
            delay: 750,
          },
          {
            write: 'src/components/ThemeToggle.tsx',
            content: THEME_TOGGLE_TSX,
            verb: 'Crafting',
            delay: 750,
          },
          {
            edit: 'src/components/Header.tsx',
            find: "import { Logo } from './Logo';",
            replace: "import { Logo } from './Logo';\nimport { ThemeToggle } from './ThemeToggle';",
            delay: 600,
          },
          // Overreaches by dropping the Docs link, which the video rolls back.
          {
            edit: 'src/components/Header.tsx',
            find: '        <Link href="/docs">Docs</Link>\n      </nav>\n',
            replace: '      </nav>\n      <ThemeToggle label="Dark mode" />\n',
            delay: 500,
          },
          {
            say: 'Added a dark mode toggle to the header. It follows the system setting until you pick a theme, then remembers your choice.',
            delay: 700,
          },
        ],
      },
    ],
  },
};
