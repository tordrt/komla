import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDismissAnnouncement = vi.fn();

// Mock window.api
Object.defineProperty(globalThis, 'window', {
  value: {
    api: {
      dismissAnnouncement: mockDismissAnnouncement,
    },
  },
  writable: true,
});

import { useAnnouncementStore } from '../../../src/renderer/stores/announcement.store';
import type { Announcement } from '../../../src/renderer/stores/announcement.store';

function createAnnouncement(overrides: Partial<Announcement> = {}): Announcement {
  return {
    id: 'test-1',
    type: 'info',
    title: 'Test Announcement',
    body: 'This is a test',
    date: '2026-03-07',
    dismissible: true,
    displayMode: 'banner',
    ...overrides,
  };
}

describe('announcement.store', () => {
  beforeEach(() => {
    useAnnouncementStore.setState(useAnnouncementStore.getInitialState(), true);
    vi.clearAllMocks();
  });

  describe('setAnnouncements', () => {
    it('should set announcements', () => {
      const announcements = [
        createAnnouncement({ id: 'a1' }),
        createAnnouncement({ id: 'a2', type: 'warning' }),
      ];

      useAnnouncementStore.getState().setAnnouncements(announcements);

      expect(useAnnouncementStore.getState().announcements).toEqual(announcements);
    });

    it('should replace existing announcements', () => {
      useAnnouncementStore.getState().setAnnouncements([createAnnouncement({ id: 'old' })]);
      useAnnouncementStore.getState().setAnnouncements([createAnnouncement({ id: 'new' })]);

      expect(useAnnouncementStore.getState().announcements).toHaveLength(1);
      expect(useAnnouncementStore.getState().announcements[0].id).toBe('new');
    });
  });

  describe('dismiss', () => {
    it('should remove announcement from list and call API', () => {
      const announcements = [createAnnouncement({ id: 'a1' }), createAnnouncement({ id: 'a2' })];
      useAnnouncementStore.getState().setAnnouncements(announcements);

      useAnnouncementStore.getState().dismiss('a1');

      expect(useAnnouncementStore.getState().announcements).toHaveLength(1);
      expect(useAnnouncementStore.getState().announcements[0].id).toBe('a2');
      expect(mockDismissAnnouncement).toHaveBeenCalledWith('a1');
    });

    it('should handle dismissing non-existent announcement gracefully', () => {
      useAnnouncementStore.getState().setAnnouncements([createAnnouncement({ id: 'a1' })]);
      useAnnouncementStore.getState().dismiss('non-existent');

      expect(useAnnouncementStore.getState().announcements).toHaveLength(1);
      expect(mockDismissAnnouncement).toHaveBeenCalledWith('non-existent');
    });
  });

  describe('announcement dialog', () => {
    it('should open and close dialog', () => {
      expect(useAnnouncementStore.getState().dialogOpen).toBe(false);

      useAnnouncementStore.getState().openDialog();
      expect(useAnnouncementStore.getState().dialogOpen).toBe(true);

      useAnnouncementStore.getState().closeDialog();
      expect(useAnnouncementStore.getState().dialogOpen).toBe(false);
    });
  });
});
