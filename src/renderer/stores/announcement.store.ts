import { create } from 'zustand';

export interface Announcement {
  id: string;
  type: 'info' | 'tip' | 'whats-new' | 'warning';
  title: string;
  body: string;
  date: string;
  dismissible?: boolean;
  displayMode: 'banner' | 'dialog' | 'both';
  action?: {
    label: string;
    url: string;
  };
}

interface AnnouncementState {
  announcements: Announcement[];
  dialogOpen: boolean;

  setAnnouncements: (announcements: Announcement[]) => void;
  dismiss: (id: string) => void;
  openDialog: () => void;
  closeDialog: () => void;
}

export const useAnnouncementStore = create<AnnouncementState>((set) => ({
  announcements: [],
  dialogOpen: false,

  setAnnouncements: (announcements) => {
    set({ announcements });
  },

  dismiss: (id) => {
    void window.api.dismissAnnouncement(id);
    set((state) => ({
      announcements: state.announcements.filter((a) => a.id !== id),
    }));
  },

  openDialog: () => set({ dialogOpen: true }),
  closeDialog: () => set({ dialogOpen: false }),
}));
