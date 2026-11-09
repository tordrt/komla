/**
 * The remote video's world: agents on the devbox SSH host, one with its
 * pricing page open beside it on a forwarded port. Each holds at a cue the
 * spec sends once Komla has quit, so their work lands while it's closed.
 */
import { HOLD, NAV } from './agent-status.scene';
import { PREVIEW_PORT, PREVIEW_URL, PRICING_WEB, YEARLY_EVENTS } from './browser-preview.scene';
import { RATE_LIMIT as HERO_RATE_LIMIT } from './hero.scene';
import type { VideoWorkspace, VideoWorld } from './video-fixtures';
import { ACME_API, DEVBOX } from './worlds';

export { HOLD, NAV, PREVIEW_PORT };
export { FINISH } from './hero.scene';

/** The cue the pricing agent waits on before opening its page, once a browser is beside it. */
export const PREVIEW = 'preview';
/** Sent once Komla has quit: the pricing agent restyles its page. */
export const RESTYLE = 'restyle';

const STAND_OUT_CSS = `.featured {
  border: 2px solid #2a6bd1;
  border-radius: 14px;
  background: #f3f7fe;
  transform: translateY(-8px);
  box-shadow: 0 16px 36px rgb(42 107 209 / 0.2);
}`;

/** Ships yearly billing with its page beside it, then starts on the Pro plan and holds. */
export const PRICING: VideoWorkspace = {
  id: 'ws-pricing',
  projectId: PRICING_WEB.id,
  title: 'Pricing Page',
  branch: 'pricing-page',
  minutesAgo: 1,
  agent: {
    title: '✳ Pricing page',
    turns: [
      {
        auto: true,
        afterMs: 200,
        prompt: 'Let people pay yearly on the pricing page',
        verb: 'Pricing',
        doneVerb: 'Baked',
        events: [
          ...YEARLY_EVENTS,
          { waitFor: PREVIEW },
          { bash: `komla preview --open ${PREVIEW_URL}`, delay: 500 },
          { say: 'Added a Monthly / Yearly switch; the page is open beside me.', delay: 300 },
        ],
      },
      {
        auto: true,
        afterMs: 600,
        prompt: 'Make the Pro plan stand out',
        verb: 'Restyling',
        doneVerb: 'Baked',
        events: [
          { tool: 'Read', arg: 'site/index.html', result: ['Read 74 lines'], delay: 400 },
          { waitFor: RESTYLE },
          { append: 'site/billing.css', content: STAND_OUT_CSS, delay: 500 },
          {
            say: 'The Pro plan now sits higher, with a blue outline and a soft shadow.',
            delay: 400,
          },
        ],
      },
    ],
  },
};

export const RATE_LIMIT: VideoWorkspace = { ...HERO_RATE_LIMIT, minutesAgo: 8 };

export const REMOTE_WORLD: VideoWorld = {
  sshHost: DEVBOX,
  projects: [PRICING_WEB, ACME_API],
  workspaces: [PRICING, { ...NAV, minutesAgo: 4 }, RATE_LIMIT],
  // Pages open beside the terminal instead of over it.
  config: { defaultInlinePreviewLayout: 'side-by-side' },
};
