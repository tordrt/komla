/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/components/layout/ReleaseNotesDialog', () => ({
  ReleaseNotesDialog: () => null,
}));
vi.mock('../../../../src/renderer/stores/workspaces.store', () => ({
  useWorkspacesStore: (selector: (state: { workspaces: unknown[] }) => unknown) =>
    selector({ workspaces: [] }),
}));

import { AnnouncementBanner } from '../../../../src/renderer/components/layout/AnnouncementBanner';
import {
  BannerHost,
  useAnyBannerShowing,
  useBannerSlot,
} from '../../../../src/renderer/components/layout/BannerHost';
import { PortChangedBanner } from '../../../../src/renderer/components/layout/PortChangedBanner';
import { UpdateBanner } from '../../../../src/renderer/components/layout/UpdateBanner';
import { UsageAnalyticsConsentBanner } from '../../../../src/renderer/components/layout/UsageAnalyticsConsentBanner';
import { Banner } from '../../../../src/renderer/components/ui/banner';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';
import { useAnnouncementStore } from '../../../../src/renderer/stores/announcement.store';
import { useConfigStore } from '../../../../src/renderer/stores/config.store';
import { useUpdateStore } from '../../../../src/renderer/stores/update.store';

import type { ReactNode } from 'react';

function TestBanner({
  id,
  priority,
  children,
}: {
  id: string;
  priority: number;
  children: ReactNode;
}) {
  const [dismissed, setDismissed] = useState(false);
  const slot = useBannerSlot(id, priority, !dismissed);
  if (!slot.visible) return null;
  return (
    <Banner pager={slot.pager} onDismiss={() => setDismissed(true)} dismissLabel={`Dismiss ${id}`}>
      {children}
    </Banner>
  );
}

function renderHost(children: ReactNode) {
  return render(<BannerHost>{children}</BannerHost>, { wrapper: TooltipProvider });
}

function BannerShowing() {
  return <span>{useAnyBannerShowing() ? 'banner showing' : 'no banner'}</span>;
}

describe('BannerHost', () => {
  it('tells things outside it whether a banner is showing', () => {
    render(
      <>
        <BannerShowing />
        <BannerHost>
          <TestBanner id="only" priority={0}>
            Only banner
          </TestBanner>
        </BannerHost>
      </>,
      { wrapper: TooltipProvider }
    );
    expect(screen.getByText('banner showing')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss only' }));

    expect(screen.getByText('no banner')).toBeInTheDocument();
  });

  it('shows only the highest-priority banner, whatever the render order', () => {
    renderHost(
      <>
        <TestBanner id="low" priority={3}>
          Low priority
        </TestBanner>
        <TestBanner id="high" priority={0}>
          High priority
        </TestBanner>
        <TestBanner id="mid" priority={1}>
          Mid priority
        </TestBanner>
      </>
    );

    expect(screen.getByText('High priority')).toBeInTheDocument();
    expect(screen.queryByText('Mid priority')).toBeNull();
    expect(screen.queryByText('Low priority')).toBeNull();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('pages through waiting banners in priority order and wraps around', () => {
    renderHost(
      <>
        <TestBanner id="high" priority={0}>
          High priority
        </TestBanner>
        <TestBanner id="mid" priority={1}>
          Mid priority
        </TestBanner>
        <TestBanner id="low" priority={2}>
          Low priority
        </TestBanner>
      </>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next notice' }));
    expect(screen.getByText('Mid priority')).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next notice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next notice' }));
    expect(screen.getByText('High priority')).toBeInTheDocument();
    expect(screen.getByText('1 of 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Previous notice' }));
    expect(screen.getByText('Low priority')).toBeInTheDocument();
    expect(screen.getByText('3 of 3')).toBeInTheDocument();
  });

  it('shows the next banner when one is dismissed, and drops the pager for the last one', () => {
    renderHost(
      <>
        <TestBanner id="high" priority={0}>
          High priority
        </TestBanner>
        <TestBanner id="low" priority={1}>
          Low priority
        </TestBanner>
      </>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss high' }));

    expect(screen.getByText('Low priority')).toBeInTheDocument();
    expect(screen.queryByText(/of 2/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Next notice' })).toBeNull();
  });

  it('renders a banner on its own when there is no host', () => {
    render(
      <TestBanner id="solo" priority={0}>
        Solo
      </TestBanner>,
      { wrapper: TooltipProvider }
    );

    expect(screen.getByText('Solo')).toBeInTheDocument();
    expect(screen.queryByText(/of /)).toBeNull();
  });
});

describe('BannerHost with the app banners', () => {
  beforeEach(() => {
    window.api = {
      getPortChange: vi.fn().mockResolvedValue({ oldPort: 52863, newPort: 52864 }),
      onPortChanged: vi.fn(() => vi.fn()),
      dismissAnnouncement: vi.fn(),
      openExternal: vi.fn(),
      websiteUrl: 'https://example.test',
    } as unknown as typeof window.api;
    useUpdateStore.setState({ status: 'ready', version: '2.0.0', dismissed: false });
    useConfigStore.setState({
      config: { usageTelemetryConsentAnswered: false } as never,
    });
    useAnnouncementStore.setState({
      announcements: [
        {
          id: 'a1',
          type: 'info',
          title: 'Hello there',
          body: 'An announcement',
          date: '2026-10-01',
          displayMode: 'banner',
        },
      ],
    });
  });

  it('orders update, port changed, consent, then announcements', async () => {
    renderHost(
      <>
        <AnnouncementBanner />
        <UsageAnalyticsConsentBanner />
        <PortChangedBanner onOpenSettings={vi.fn()} />
        <UpdateBanner />
      </>
    );
    await act(async () => {});

    expect(screen.getByText(/Komla v2\.0\.0 is ready to install/)).toBeInTheDocument();
    expect(screen.getByText('1 of 4')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next notice' }));
    expect(screen.getByText(/MCP port changed from 52863 to 52864/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next notice' }));
    expect(screen.getByText('Share usage analytics?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next notice' }));
    expect(screen.getByText('Hello there')).toBeInTheDocument();
    expect(screen.getByText('4 of 4')).toBeInTheDocument();
  });

  it('gives the update and consent banners different tints', async () => {
    renderHost(
      <>
        <UsageAnalyticsConsentBanner />
        <UpdateBanner />
      </>
    );

    const updateBar = screen.getByText(/ready to install/).closest('div');
    fireEvent.click(screen.getByRole('button', { name: 'Next notice' }));
    const consentBar = screen.getByText('Share usage analytics?').closest('div');

    const tint = (el: Element | null) =>
      Array.from(el?.classList ?? []).find((name) => name.startsWith('bg-'));
    expect(tint(updateBar)).toBeDefined();
    expect(tint(consentBar)).toBeDefined();
    expect(tint(updateBar)).not.toBe(tint(consentBar));
  });
});
