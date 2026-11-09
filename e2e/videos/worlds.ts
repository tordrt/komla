/**
 * Shared demo content for the landing-page videos: one web app project and a
 * handful of workspaces in different states, so every video shows a lived-in
 * sidebar.
 */
import type { VideoProject, VideoWorkspace, VideoWorld } from './video-fixtures';

const TOKENS_CSS = `:root {
  --bg: #ffffff;
  --surface: #f6f7f9;
  --text: #111827;
  --muted: #6b7280;
  --accent: #2563eb;
  --radius: 10px;
}

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: Inter, system-ui, sans-serif;
}
`;

const HEADER_TSX = `import { Link } from './Link';
import { Logo } from './Logo';

export function Header() {
  return (
    <header className="header">
      <Logo />
      <nav className="header__nav">
        <Link href="/features">Features</Link>
        <Link href="/pricing">Pricing</Link>
        <Link href="/docs">Docs</Link>
      </nav>
    </header>
  );
}
`;

const THEME_TS = `export type Theme = 'light' | 'dark';

export function getInitialTheme(): Theme {
  return 'light';
}
`;

/** The SSH host every video's workspaces run on, as on a real dev box. */
export const DEVBOX = { hostname: 'devbox', name: 'devbox' };

export const ACME_WEB = {
  id: 'proj-acme-web',
  name: 'acme-web',
  color: 'hsl(212, 80%, 60%)',
  icon: 'acme-web.svg',
  files: {
    'README.md': '# Acme Web\n\nMarketing site and dashboard for Acme.\n',
    'package.json': JSON.stringify(
      { name: 'acme-web', private: true, scripts: { dev: 'vite', test: 'vitest run' } },
      null,
      2
    ),
    'src/styles/tokens.css': TOKENS_CSS,
    'src/components/Header.tsx': HEADER_TSX,
    'src/lib/theme.ts': THEME_TS,
    'src/lib/checkout.ts':
      'export async function startCheckout(plan: string) {\n  return plan;\n}\n',
    'src/api/search.ts': 'export function search(query: string) {\n  return [];\n}\n',
  },
};

/** A second project, for videos whose sidebar spans more than one. */
export const ACME_API: VideoProject = {
  id: 'proj-acme-api',
  name: 'acme-api',
  color: 'hsl(340, 75%, 62%)',
  icon: 'acme-api.svg',
  files: {
    'README.md': '# Acme API\n\nBilling, search and accounts for Acme.\n',
    'package.json': JSON.stringify(
      { name: 'acme-api', private: true, scripts: { dev: 'tsx watch src/server.ts' } },
      null,
      2
    ),
    'src/routes/webhooks.ts':
      "import { Router } from 'express';\n\nexport const webhooks = Router();\n",
    'src/routes/search.ts':
      "import { Router } from 'express';\n\nexport const search = Router();\n",
    'src/db.ts': "import { Pool } from 'pg';\n\nexport const db = new Pool();\n",
  },
};

/** The web app and the API behind it, named plainly, as the hero names them. */
export const WEB_APP: VideoProject = {
  ...ACME_WEB,
  name: 'web-app',
  icon: 'web-app.svg',
  files: {
    ...ACME_WEB.files,
    'package.json': JSON.stringify(
      { ...JSON.parse(ACME_WEB.files['package.json']), name: 'web-app' },
      null,
      2
    ),
  },
};
export const API_SERVER: VideoProject = {
  ...ACME_API,
  name: 'api-server',
  icon: 'api-server.svg',
  files: {
    ...ACME_API.files,
    'package.json': JSON.stringify(
      { ...JSON.parse(ACME_API.files['package.json']), name: 'api-server' },
      null,
      2
    ),
  },
};

/** Background workspaces that fill out the sidebar around a video's subject. */
export const BACKGROUND_WORKSPACES: VideoWorkspace[] = [
  {
    id: 'ws-checkout',
    projectId: ACME_WEB.id,
    title: 'Stripe Checkout',
    branch: 'stripe-checkout',
    minutesAgo: 12,
    commits: [
      {
        message: 'Add Stripe checkout session',
        files: {
          'src/lib/checkout.ts':
            "import Stripe from 'stripe';\n\nexport async function startCheckout(plan: string) {\n  const stripe = new Stripe(process.env.STRIPE_KEY!);\n  return stripe.checkout.sessions.create({ mode: 'subscription', line_items: [{ price: plan, quantity: 1 }] });\n}\n",
        },
      },
    ],
  },
  {
    id: 'ws-search',
    projectId: ACME_WEB.id,
    title: 'Search API',
    branch: 'search-endpoint',
    minutesAgo: 34,
    changes: {
      'src/api/search.ts':
        "import { db } from '../db';\n\nexport function search(query: string) {\n  return db.posts.where('title', 'ilike', `%${query}%`).limit(20);\n}\n",
    },
  },
  {
    id: 'ws-nav',
    projectId: ACME_WEB.id,
    title: 'Fix Nav Overflow',
    branch: 'fix-nav-overflow',
    minutesAgo: 95,
  },
];

export function acmeWorld(subjects: VideoWorkspace[]): VideoWorld {
  return {
    sshHost: DEVBOX,
    projects: [ACME_WEB],
    workspaces: [...subjects, ...BACKGROUND_WORKSPACES],
  };
}
