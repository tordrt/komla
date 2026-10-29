import {
  ArrowLeft,
  ArrowsClockwise,
  Broadcast,
  CalendarDots,
  CaretRight,
  Cloud,
  Download,
  FileCode,
  Folder,
  GearSix,
  GitBranch,
  Key,
  Keyboard,
  Microphone,
  NotePencil,
  Palette,
  Plugs,
  Robot,
  Terminal,
  type Icon,
} from '@phosphor-icons/react';
import {
  Fragment,
  lazy,
  Suspense,
  useState,
  useEffect,
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import { ProjectMark } from '@/components/projects/ProjectMark';
import { AlphaBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { claimWindowsTitleBarOverlaySurface } from '@/lib/palette-runtime';
import { resolveSettingsPage } from '@/lib/settings-navigation';
import { cn } from '@/lib/utils';
import { useProjectsStore } from '@/stores/projects.store';
import { useSshHostsStore } from '@/stores/ssh-hosts.store';
import { useUpdateStore } from '@/stores/update.store';

import { LinuxWindowControls } from '../LinuxWindowControls';
import { ReleaseNotesDialog } from '../ReleaseNotesDialog';
import {
  MAC_TRAFFIC_LIGHT_INSET_PX,
  WINDOWS_CAPTION_BUTTONS_WIDTH_PX,
  titleBarHeightPx,
  useHasTrafficLights,
} from '../title-bar-metrics';

import { ActionsTab } from './ActionsTab';
import { AgentTab } from './AgentTab';
import { AppearanceTab } from './AppearanceTab';
import { AutomationsTab } from './AutomationsTab';
import { FilesTab } from './FilesTab';
import { GeneralTab } from './GeneralTab';
import { GitTab } from './GitTab';
import { IntegrationsTab } from './IntegrationsTab';
import { LicenseTab } from './LicenseTab';
import {
  PROJECT_SECTIONS,
  projectSectionOfCard,
  type ProjectSection,
} from './project-settings-sections';
import { ProjectPageSubtitle } from './ProjectPageSubtitle';
import { ProjectSectionTabs } from './ProjectSectionTabs';
import { ProjectSettingsPage } from './ProjectSettingsPage';
import { ProjectsTab } from './ProjectsTab';
import { settingsCardId, type SettingsSearchProject } from './settings-search';
import { SettingsSearch } from './SettingsSearch';
import { ShortcutsTab } from './ShortcutsTab';
import { SshTab } from './SshTab';
import { TerminalTab } from './TerminalTab';
import { VoiceTab } from './VoiceTab';

import type { Project } from '@/types';

// Rarely opened tabs with heavy payloads (QR encoder, bundled changelog) load
// on demand instead of inflating the settings chunk.
const ChangelogTab = lazy(() =>
  import('./ChangelogTab').then((module) => ({ default: module.ChangelogTab }))
);
const RemoteTab = lazy(() =>
  import('./RemoteTab').then((module) => ({ default: module.RemoteTab }))
);

interface SettingsPage {
  value: string;
  label: string;
  description: string;
  icon: Icon;
  /** Nav group heading; pages without one sit at the top of the sidebar. */
  group?: string;
  indent?: boolean;
  /** Reachable by link (e.g. the version footer) but not listed in the nav. */
  hidden?: boolean;
  /** Marked Alpha in the nav and over the page. */
  alpha?: boolean;
}

const PAGES: SettingsPage[] = [
  {
    value: 'general',
    label: 'General',
    description: 'AI helpers and privacy.',
    icon: GearSix,
  },
  {
    value: 'agent',
    label: 'Agents',
    description: 'The agent CLIs Komla launches in workspaces and agent tabs.',
    icon: Robot,
    group: 'Agents',
  },
  {
    value: 'integrations',
    label: 'Integrations & MCP',
    description:
      'Connect agent CLIs to Komla, choose how they notify you, and control what agents can do through the CLI and MCP.',
    icon: Plugs,
    group: 'Agents',
  },
  {
    value: 'automations',
    label: 'Automations',
    description:
      'Agent tasks Komla starts in a new workspace on a schedule, on this computer or an SSH host.',
    icon: CalendarDots,
    group: 'Agents',
  },
  {
    value: 'projects',
    label: 'Projects',
    description: 'Repositories and folders Komla creates workspaces from.',
    icon: Folder,
    group: 'Projects',
  },
  {
    value: 'git',
    label: 'Git',
    description:
      'Default branch names and commit buttons for every project. A project can override them in its own Git settings.',
    icon: GitBranch,
    group: 'Projects',
  },
  {
    value: 'actions',
    label: 'Quick Commands',
    description: 'Saved prompts and terminal commands you can run in any workspace.',
    icon: NotePencil,
    group: 'Projects',
  },
  {
    value: 'ssh',
    label: 'SSH Hosts',
    description:
      'Run agents on another machine, so a bad command can’t touch your laptop. They keep working while it sleeps.',
    icon: Cloud,
    group: 'Environments',
  },
  {
    value: 'appearance',
    label: 'Appearance',
    description:
      'Theme, accent color, interface size, terminal colors and font, and the status bar.',
    icon: Palette,
    group: 'Interface',
  },
  {
    value: 'terminal',
    label: 'Terminal',
    description: 'Scrollback, pane and link behavior for every terminal.',
    icon: Terminal,
    group: 'Interface',
  },
  {
    value: 'files',
    label: 'Files & Diffs',
    description: 'File tree, search, editor, and browser preview defaults for new workspaces.',
    icon: FileCode,
    group: 'Interface',
  },
  {
    value: 'voice',
    label: 'Voice',
    description: 'Dictate prompts with a local speech-to-text model.',
    icon: Microphone,
    group: 'Interface',
  },
  {
    value: 'shortcuts',
    label: 'Shortcuts',
    description: 'Keyboard shortcuts for workspaces, terminals, and panes.',
    icon: Keyboard,
    group: 'Interface',
  },
  {
    value: 'remote',
    label: 'Remote',
    description: 'Use Komla from your phone, tablet or another computer. In alpha, so expect bugs.',
    icon: Broadcast,
    alpha: true,
  },
  {
    value: 'license',
    label: 'License',
    description: 'Your plan, license key, and activated devices.',
    icon: Key,
  },
  {
    value: 'changelog',
    label: 'What’s New',
    description: 'Changes in recent Komla releases.',
    icon: GearSix,
    hidden: true,
  },
];

/** A page to show, and optionally a card on it to scroll to. */
interface PageRequest {
  tab: string;
  cardId?: string;
  /** On Projects: the project whose settings to show, instead of the list. */
  projectId?: string;
  /** On a project: the section to show, when no card picks one. Defaults to General. */
  projectSection?: ProjectSection;
  /** On Projects: the form for adding a project, instead of the list. */
  addProject?: boolean;
}

/** What Projects shows. */
type ProjectsView =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'project'; projectId: string; section: ProjectSection };

function projectsViewFor(request: PageRequest): ProjectsView {
  if (request.tab !== 'projects') return { kind: 'list' };
  if (request.projectId) {
    const section = projectSectionOfCard(request.cardId) ?? request.projectSection ?? 'general';
    return { kind: 'project', projectId: request.projectId, section };
  }
  return request.addProject ? { kind: 'add' } : { kind: 'list' };
}

// Projects are listed under the Projects page in the nav, keyed apart from page values.
const PROJECT_NAV_KEY_PREFIX = 'project:';
const projectNavKey = (projectId: string) => `${PROJECT_NAV_KEY_PREFIX}${projectId}`;
// A git project's sections are listed under it while it's shown.
const projectSectionNavKey = (projectId: string, section: ProjectSection) =>
  `${projectNavKey(projectId)}/${section}`;

function parseProjectNavKey(key: string): { projectId: string; section?: ProjectSection } {
  const [projectId, suffix] = key.slice(PROJECT_NAV_KEY_PREFIX.length).split('/');
  // Anything but a known section opens General, rather than a page with every section hidden.
  const section = PROJECT_SECTIONS.find(({ value }) => value === suffix)?.value;
  return { projectId, section };
}

/** Names what a page shows, so a project's page and the add form differ from the list. A
 *  project's sections share its page, and its edits. */
function viewKey(tab: string, projectsView: ProjectsView): string {
  if (tab !== 'projects') return tab;
  if (projectsView.kind === 'project') return projectNavKey(projectsView.projectId);
  return projectsView.kind === 'add' ? 'projects:add' : tab;
}

/** Like viewKey, but tells a project's sections apart. */
function sectionViewKey(tab: string, projectsView: ProjectsView): string {
  return tab === 'projects' && projectsView.kind === 'project'
    ? projectSectionNavKey(projectsView.projectId, projectsView.section)
    : viewKey(tab, projectsView);
}

/** Workspace Setup is a section of each project's settings; links to it open that section. */
function workspaceSetupRequest(projectId: string | undefined): PageRequest {
  const { projects } = useProjectsStore.getState();
  const project =
    projects.find((candidate) => candidate.id === projectId) ??
    projects.find((candidate) => candidate.kind !== 'directory');
  return project
    ? { tab: 'projects', projectId: project.id, cardId: settingsCardId('Setup steps') }
    : { tab: 'projects' };
}

/** The heading and blurb over what Projects or another page shows. */
function pageHeader(
  page: SettingsPage | undefined,
  project: Project | undefined,
  addingProject: boolean
): { title: string; description: ReactNode; alpha?: boolean } | undefined {
  if (project) {
    return {
      title: project.name,
      description: <ProjectPageSubtitle project={project} />,
    };
  }
  if (addingProject) {
    return {
      title: 'Add project',
      description: 'A Git repository or a folder to create workspaces in.',
    };
  }
  return page && { title: page.label, description: page.description, alpha: page.alpha };
}

/** Projects as search covers them, with the cards each one's page shows. */
function searchableProjects(projects: Project[], hasSshHosts: boolean): SettingsSearchProject[] {
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    isGit: project.kind !== 'directory',
    showsSsh:
      project.kind !== 'directory' && (hasSshHosts || project.sshWorkspaceMode !== undefined),
  }));
}

type DiscardPrompt = { kind: 'close' } | { kind: 'page'; request: PageRequest; message: string };

// Search boxes mark themselves with this so Escape clears them before it closes Settings.
function escapeClearsField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement &&
    target.dataset.clearsOnEscape !== undefined &&
    target.value !== ''
  );
}

function findVisibleCard(container: HTMLElement | null, cardId: string): HTMLElement | null {
  if (!container) return null;
  const cards = Array.from(container.querySelectorAll<HTMLElement>(`[id="${cardId}"]`));
  return cards.find((card) => !card.closest('[hidden]')) ?? null;
}

const CARD_HIGHLIGHT_MS = 1600;
// Pages may render a card a little after they mount (async config, lazy chunks).
const CARD_LOOKUP_FRAMES = 30;

/** Calls onFound once the container shows the card, checking each frame for a while.
 *  Returns a function that stops looking. */
function waitForVisibleCard(
  getContainer: () => HTMLElement | null,
  cardId: string,
  onFound: (card: HTMLElement) => void
): () => void {
  let frame = 0;
  let attempts = 0;
  const lookUp = () => {
    const card = findVisibleCard(getContainer(), cardId);
    if (card) {
      onFound(card);
    } else if (++attempts < CARD_LOOKUP_FRAMES) {
      frame = requestAnimationFrame(lookUp);
    }
  };
  lookUp();
  return () => cancelAnimationFrame(frame);
}

interface SettingsNavRowProps {
  current: boolean;
  /** Takes the nav's single tab stop. */
  focusable: boolean;
  dirty: boolean;
  indent?: boolean;
  /** Whether rows listed under this one are showing; they stay until another row is picked. */
  expanded?: boolean;
  /** Full text for a label the row may cut short. */
  title?: string;
  /** A button over the row's end, such as one that folds rows under it away. */
  toggle?: ReactNode;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}

function SettingsNavRow({
  current,
  focusable,
  dirty,
  indent,
  expanded,
  title,
  toggle,
  buttonRef,
  onSelect,
  onKeyDown,
  children,
}: SettingsNavRowProps) {
  const row = (
    <button
      ref={buttonRef}
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      aria-current={current ? 'page' : undefined}
      tabIndex={focusable ? 0 : -1}
      title={title}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg py-1.5 text-sm whitespace-nowrap transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-hidden',
        current
          ? 'bg-accent font-medium text-foreground shadow-xs ring-1 ring-foreground/8'
          : expanded
            ? 'font-medium text-foreground hover:bg-accent/60'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
        indent ? 'pr-2.5 pl-8' : 'px-2.5',
        toggle && 'pr-8'
      )}
    >
      {children}
      {dirty && (
        <>
          <span aria-hidden="true" className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" />
          <span className="sr-only">, unsaved changes</span>
        </>
      )}
    </button>
  );
  return toggle ? (
    <div className="relative">
      {row}
      {toggle}
    </div>
  ) : (
    row
  );
}

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: string;
  initialGeneralSection?: string;
  initialEditProjectId?: string;
  initialSetupProjectId?: string;
  /** Title of a card on the page to scroll to and flash */
  initialCard?: string;
  /** Changes with every request to open Settings, including a link inside it to a page
   *  it already asked for. */
  openRequestId?: number;
}

export function SettingsDialog({
  open,
  onOpenChange,
  initialTab,
  initialGeneralSection,
  initialEditProjectId,
  initialSetupProjectId,
  initialCard,
  openRequestId,
}: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState('general');
  const [projectsView, setProjectsView] = useState<ProjectsView>({ kind: 'list' });
  // Whether the nav lists the projects; follows being on Projects until toggled.
  const [projectsNavOverride, setProjectsNavOverride] = useState<boolean | null>(null);
  const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
  const [discardPrompt, setDiscardPrompt] = useState<DiscardPrompt>({ kind: 'close' });
  const [discardPromptOpen, setDiscardPromptOpen] = useState(false);
  const [scrollRequest, setScrollRequest] = useState<{ cardId: string } | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [releaseNotesOpen, setReleaseNotesOpen] = useState(false);
  const [prevOpen, setPrevOpen] = useState(open);
  const wasOpenRef = useRef(open);
  const projects = useProjectsStore((state) => state.projects);
  const completePendingSshSetup = useSshHostsStore((state) => state.completePendingSetup);
  const hasSshHosts = useSshHostsStore((state) => !state.hasLoaded || state.hosts.length > 0);
  const hasTrafficLights = useHasTrafficLights();
  const titleBarHeight = titleBarHeightPx();
  const contentRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const navButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const {
    status: updateStatus,
    version: updateVersion,
    releaseNotes: updateReleaseNotes,
    checkForUpdates,
    installUpdate,
    openDownload,
  } = useUpdateStore();
  // A build from source doesn't update itself.
  const offersUpdates = window.api.buildFromSource !== true;

  const hasDirtyChanges = dirtyTabs.size > 0;
  const visibleNavItems = PAGES.filter((page) => !page.hidden);
  const navGroups = visibleNavItems.reduce<{ label?: string; pages: SettingsPage[] }[]>(
    (groups, page) => {
      const last = groups.at(-1);
      if (last && last.label === page.group) last.pages.push(page);
      else groups.push({ label: page.group, pages: [page] });
      return groups;
    },
    []
  );
  const activePage = PAGES.find((page) => page.value === activeTab);
  // A project that's gone, or not loaded yet, shows the list.
  const shownProject =
    activeTab === 'projects' && projectsView.kind === 'project'
      ? projects.find((project) => project.id === projectsView.projectId)
      : undefined;
  const shownProjectsView: ProjectsView =
    projectsView.kind === 'project' && !shownProject ? { kind: 'list' } : projectsView;
  const currentViewKey = viewKey(activeTab, shownProjectsView);
  const currentSectionViewKey = sectionViewKey(activeTab, shownProjectsView);
  // A git project shown in Settings lists its sections under it.
  const sectionedProject = shownProject && shownProject.kind !== 'directory' ? shownProject : null;
  const projectsNavExpanded =
    projects.length > 0 && (projectsNavOverride ?? activeTab === 'projects');
  // The nav rows in order, with each project under Projects while they're unfolded.
  const navKeys = visibleNavItems.flatMap((page) =>
    page.value === 'projects' && projectsNavExpanded
      ? [
          page.value,
          ...projects.flatMap((project) =>
            project === sectionedProject
              ? [
                  projectNavKey(project.id),
                  ...PROJECT_SECTIONS.map(({ value }) => projectSectionNavKey(project.id, value)),
                ]
              : [projectNavKey(project.id)]
          ),
        ]
      : [page.value]
  );
  // Projects stands in for the add form, and for a project while the projects are folded away.
  const currentNavKey = navKeys.includes(currentSectionViewKey)
    ? currentSectionViewKey
    : navKeys.includes(currentViewKey)
      ? currentViewKey
      : activeTab;
  // Roving tabindex target; falls back to the first item on unlisted pages.
  const focusableNavKey = navKeys.includes(currentNavKey) ? currentNavKey : navKeys[0];
  // Unsaved edits to a project mark its own row, whichever section is shown.
  const currentPageNavKey = navKeys.includes(currentViewKey) ? currentViewKey : currentNavKey;
  const dirtyNavKeys = new Set(
    [...dirtyTabs].map((tab) => (tab === activeTab ? currentPageNavKey : tab))
  );
  // Reset state when dialog closes
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (!open) {
      setActiveTab('general');
      setProjectsView({ kind: 'list' });
      setProjectsNavOverride(null);
      setDirtyTabs(new Set());
      setDiscardPromptOpen(false);
      setScrollRequest(null);
    }
  }
  // Load app version
  useEffect(() => {
    void window.api.getAppVersion().then(setAppVersion);
  }, []);

  // Settings covers the title bar, so the Windows window controls take its background.
  useEffect(() => {
    if (!open) return;
    return claimWindowsTitleBarOverlaySurface('background');
  }, [open]);

  const clearDirty = useCallback((tab: string) => {
    setDirtyTabs((prev) => {
      if (!prev.has(tab)) return prev;
      const next = new Set(prev);
      next.delete(tab);
      return next;
    });
  }, []);

  const showPage = useCallback(
    (request: PageRequest) => {
      const nextProjectsView = projectsViewFor(request);
      if (
        sectionViewKey(request.tab, nextProjectsView) !== currentSectionViewKey &&
        contentRef.current
      ) {
        contentRef.current.scrollTop = 0;
      }
      // Arriving on Projects unfolds the projects in the nav, and leaving folds them away.
      if ((request.tab === 'projects') !== (activeTab === 'projects')) {
        setProjectsNavOverride(null);
      }
      setActiveTab(request.tab);
      setProjectsView(nextProjectsView);
      setScrollRequest(request.cardId ? { cardId: request.cardId } : null);
    },
    [activeTab, currentSectionViewKey]
  );

  /** Shows a page, first asking to discard unsaved edits that leaving would lose.
   *  Returns whether the page changed right away. */
  const requestPage = useCallback(
    (request: PageRequest) => {
      const losesEdits =
        viewKey(request.tab, projectsViewFor(request)) !== currentViewKey &&
        dirtyTabs.has(activeTab);
      if (losesEdits) {
        const pageLabel = PAGES.find((page) => page.value === activeTab)?.label ?? 'this page';
        setDiscardPrompt({
          kind: 'page',
          request,
          message: shownProject
            ? `You have unsaved changes to ${shownProject.name}. Discard them?`
            : `You have unsaved changes on ${pageLabel}. Discard them and leave the page?`,
        });
        setDiscardPromptOpen(true);
        return false;
      }
      showPage(request);
      return true;
    },
    [activeTab, currentViewKey, dirtyTabs, shownProject, showPage]
  );

  // The open-target effect below must not re-run when requestPage changes.
  const requestPageRef = useRef(requestPage);
  useLayoutEffect(() => {
    requestPageRef.current = requestPage;
  });

  // Show the requested page when the dialog opens, or when a link inside
  // Settings (e.g. "Manage Actions") retargets it while open.
  useEffect(() => {
    if (!open) return;
    const page = resolveSettingsPage(initialTab, initialGeneralSection);
    if (page === 'workspace-setup') {
      requestPageRef.current(workspaceSetupRequest(initialSetupProjectId));
    } else if (page) {
      requestPageRef.current({
        tab: page,
        projectId: initialEditProjectId,
        cardId: initialCard ? settingsCardId(initialCard) : undefined,
      });
    }
  }, [
    open,
    initialTab,
    initialGeneralSection,
    initialEditProjectId,
    initialSetupProjectId,
    initialCard,
    openRequestId,
  ]);

  // Scroll to the card a search result points at, and flash it so it stands out.
  useEffect(() => {
    if (!scrollRequest) return;
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    let highlightedCard: HTMLElement | undefined;
    const stopLookingForCard = waitForVisibleCard(
      () => contentRef.current,
      scrollRequest.cardId,
      (card) => {
        card.scrollIntoView({ block: 'start' });
        card.dataset.searchTarget = '';
        highlightedCard = card;
        highlightTimer = setTimeout(() => delete card.dataset.searchTarget, CARD_HIGHLIGHT_MS);
      }
    );
    return () => {
      stopLookingForCard();
      clearTimeout(highlightTimer);
      // A newer search or closing Settings shouldn't leave the old card outlined.
      if (highlightedCard) delete highlightedCard.dataset.searchTarget;
    };
  }, [scrollRequest]);

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      void completePendingSshSetup();
    }
    wasOpenRef.current = open;
  }, [completePendingSshSetup, open]);

  const handleDirtyChange = useCallback(
    (tab: string) => (isDirty: boolean) => {
      setDirtyTabs((prev) => {
        if (isDirty && !prev.has(tab)) {
          const next = new Set(prev);
          next.add(tab);
          return next;
        }
        if (!isDirty && prev.has(tab)) {
          const next = new Set(prev);
          next.delete(tab);
          return next;
        }
        return prev;
      });
    },
    []
  );

  const askToDiscardBeforeClosing = useCallback(() => {
    setDiscardPrompt({ kind: 'close' });
    setDiscardPromptOpen(true);
  }, []);

  const handleClose = useCallback(() => {
    if (hasDirtyChanges) {
      askToDiscardBeforeClosing();
    } else {
      onOpenChange(false);
    }
  }, [askToDiscardBeforeClosing, hasDirtyChanges, onOpenChange]);

  const handleDiscard = useCallback(() => {
    setDiscardPromptOpen(false);
    if (discardPrompt.kind === 'page') {
      clearDirty(activeTab);
      showPage(discardPrompt.request);
    } else {
      setDirtyTabs(new Set());
      onOpenChange(false);
    }
  }, [activeTab, clearDirty, discardPrompt, onOpenChange, showPage]);

  const handleSaveClose = useCallback(() => {
    setDiscardPromptOpen(false);
    setDirtyTabs(new Set());
    onOpenChange(false);
  }, [onOpenChange]);

  // Handle dialog open change with dirty check
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen && hasDirtyChanges) {
        askToDiscardBeforeClosing();
      } else {
        onOpenChange(newOpen);
      }
    },
    [askToDiscardBeforeClosing, hasDirtyChanges, onOpenChange]
  );

  const handleTabChange = useCallback((tab: string) => requestPage({ tab }), [requestPage]);

  const selectNavKey = (key: string) => {
    if (!key.startsWith(PROJECT_NAV_KEY_PREFIX)) return handleTabChange(key);
    const { projectId, section } = parseProjectNavKey(key);
    return requestPage({ tab: 'projects', projectId, projectSection: section });
  };

  const handleNavKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    const currentIndex = navKeys.indexOf(key);
    let nextIndex: number | undefined;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft':
        // Unfold or fold the projects, as in a tree.
        if (key !== 'projects' || projects.length === 0) return;
        event.preventDefault();
        setProjectsNavOverride(event.key === 'ArrowRight');
        return;
      case 'ArrowDown':
        nextIndex = (currentIndex + 1) % navKeys.length;
        break;
      case 'ArrowUp':
        nextIndex = (currentIndex - 1 + navKeys.length) % navKeys.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = navKeys.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextKey = navKeys[nextIndex];
    if (selectNavKey(nextKey)) {
      navButtonRefs.current.get(nextKey)?.focus();
    }
  };

  const navRowProps = (key: string) => ({
    current: currentNavKey === key,
    focusable: focusableNavKey === key,
    dirty: dirtyNavKeys.has(key),
    buttonRef: (element: HTMLButtonElement | null) => {
      if (element) navButtonRefs.current.set(key, element);
      else navButtonRefs.current.delete(key);
    },
    onSelect: () => selectNavKey(key),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => handleNavKeyDown(event, key),
  });

  const header = pageHeader(
    activePage,
    shownProject,
    activeTab === 'projects' && shownProjectsView.kind === 'add'
  );

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        {/* The whole window, title bar included: Settings draws its own top row. */}
        <DialogContent
          className="!top-0 !left-0 flex !h-screen !max-h-none !w-full !max-w-none !translate-x-0 !translate-y-0 flex-col !gap-0 overflow-clip !rounded-none !border-0 !p-0"
          showCloseButton={false}
          floating={false}
          onOpenAutoFocus={(event) => {
            // Land in search, so typing finds a setting right away.
            event.preventDefault();
            searchInputRef.current?.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (escapeClearsField(e.target)) {
              e.preventDefault();
            } else if (hasDirtyChanges) {
              e.preventDefault();
              askToDiscardBeforeClosing();
            }
          }}
        >
          <DialogTitle className="sr-only">Settings</DialogTitle>
          <DialogDescription className="sr-only">
            Configure Komla and manage your projects.
          </DialogDescription>

          <div className="flex min-h-0 flex-1 flex-row">
            {/* Sidebar, on the workspace sidebar's surface so Settings reads as part of the app */}
            <div className="sidebar-surface flex min-h-0 w-[256px] shrink-0 flex-col border-r">
              {/* Top row, level with the content's and draggable, beside the macOS traffic lights */}
              <div
                className="drag-region flex shrink-0 items-center px-2"
                style={{
                  height: titleBarHeight,
                  ...(hasTrafficLights && { paddingLeft: MAC_TRAFFIC_LIGHT_INSET_PX }),
                }}
              >
                <DialogClose asChild>
                  <button
                    type="button"
                    className="no-drag flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors duration-150 hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-hidden"
                  >
                    <ArrowLeft className="size-4 shrink-0" />
                    Back to app
                    <Kbd aria-hidden="true" className="ml-auto">
                      Esc
                    </Kbd>
                  </button>
                </DialogClose>
              </div>
              <SettingsSearch
                pages={visibleNavItems}
                projects={searchableProjects(projects, hasSshHosts)}
                inputRef={searchInputRef}
                onOpenResult={(result) =>
                  requestPage({
                    tab: result.page,
                    cardId: result.cardId,
                    projectId: result.projectId,
                  })
                }
              >
                <nav aria-label="Settings" className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
                  <div className="flex flex-col gap-4">
                    {navGroups.map((group, index) => (
                      <div key={group.label ?? `group-${index}`} className="flex flex-col gap-0.5">
                        {group.label && (
                          <div className="px-2.5 pb-1 text-xs font-medium tracking-[0.14em] text-muted-foreground/70 uppercase">
                            {group.label}
                          </div>
                        )}
                        {group.pages.map(({ value, label, icon: Icon, indent, alpha }) => (
                          <Fragment key={value}>
                            <SettingsNavRow
                              {...navRowProps(value)}
                              indent={indent}
                              toggle={
                                value === 'projects' &&
                                projects.length > 0 && (
                                  <button
                                    type="button"
                                    // The Projects row's arrow keys do this from the keyboard.
                                    tabIndex={-1}
                                    aria-label={
                                      projectsNavExpanded ? 'Hide projects' : 'Show projects'
                                    }
                                    aria-expanded={projectsNavExpanded}
                                    onClick={() => setProjectsNavOverride(!projectsNavExpanded)}
                                    className="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/8 hover:text-foreground"
                                  >
                                    <CaretRight
                                      className={cn(
                                        'size-3 transition-transform duration-150',
                                        projectsNavExpanded && 'rotate-90'
                                      )}
                                    />
                                  </button>
                                )
                              }
                            >
                              <Icon className={cn('shrink-0', indent ? 'size-4' : 'size-4.5')} />
                              {label}
                              {alpha && (
                                <>
                                  {' '}
                                  <AlphaBadge />
                                </>
                              )}
                            </SettingsNavRow>
                            {value === 'projects' &&
                              projectsNavExpanded &&
                              projects.map((project) => (
                                <Fragment key={project.id}>
                                  <SettingsNavRow
                                    {...navRowProps(projectNavKey(project.id))}
                                    indent
                                    expanded={project === sectionedProject ? true : undefined}
                                    title={project.name}
                                  >
                                    <span className="flex size-4 shrink-0 items-center justify-center">
                                      <ProjectMark project={project} />
                                    </span>
                                    <span className="truncate">{project.name}</span>
                                  </SettingsNavRow>
                                  {project === sectionedProject && (
                                    <div
                                      role="group"
                                      aria-label={`${project.name} settings`}
                                      className="ml-10 flex flex-col gap-0.5 border-l border-foreground/12 pl-1.5"
                                    >
                                      {PROJECT_SECTIONS.map(
                                        ({ value, label, icon: SectionIcon }) => (
                                          <SettingsNavRow
                                            key={value}
                                            {...navRowProps(
                                              projectSectionNavKey(project.id, value)
                                            )}
                                          >
                                            <SectionIcon className="size-4 shrink-0" />
                                            {label}
                                          </SettingsNavRow>
                                        )
                                      )}
                                    </div>
                                  )}
                                </Fragment>
                              ))}
                          </Fragment>
                        ))}
                      </div>
                    ))}
                  </div>
                </nav>
              </SettingsSearch>
              {/* Version footer */}
              <div className="mt-auto space-y-1 border-t border-foreground/8 px-4 py-3 text-ui text-muted-foreground/70">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{appVersion ? `v${appVersion}` : ''}</span>
                  <button
                    type="button"
                    onClick={() => handleTabChange('changelog')}
                    className="transition-colors hover:text-muted-foreground"
                  >
                    What’s new
                  </button>
                </div>
                {!offersUpdates && <p>Built from source</p>}
                {offersUpdates && (updateStatus === 'idle' || updateStatus === 'error') && (
                  <button
                    type="button"
                    onClick={checkForUpdates}
                    className="transition-colors hover:text-muted-foreground"
                  >
                    Check for updates
                  </button>
                )}
                {updateStatus === 'checking' && (
                  <div role="status" className="flex items-center gap-1.5">
                    <Spinner size="xs" />
                    Checking for updates…
                  </div>
                )}
                {updateStatus === 'ready' && (
                  <div className="flex items-center gap-2">
                    <span className="text-foreground">v{updateVersion} ready</span>
                    <button
                      type="button"
                      onClick={installUpdate}
                      className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <ArrowsClockwise className="size-3" />
                      Restart
                    </button>
                    {updateReleaseNotes && (
                      <button
                        type="button"
                        onClick={() => setReleaseNotesOpen(true)}
                        className="underline underline-offset-2 transition-colors hover:text-muted-foreground"
                      >
                        Notes
                      </button>
                    )}
                  </div>
                )}
                {updateStatus === 'manual' && (
                  <div className="flex items-center gap-2">
                    <span className="text-foreground">v{updateVersion} available</span>
                    <button
                      type="button"
                      onClick={openDownload}
                      className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <Download className="size-3" />
                      Download
                    </button>
                    {updateReleaseNotes && (
                      <button
                        type="button"
                        onClick={() => setReleaseNotesOpen(true)}
                        className="underline underline-offset-2 transition-colors hover:text-muted-foreground"
                      >
                        Notes
                      </button>
                    )}
                  </div>
                )}
                {offersUpdates && updateStatus === 'error' && (
                  <p className="text-error">Update check failed</p>
                )}
              </div>
            </div>

            <div className="flex min-w-0 flex-1 flex-col bg-background">
              {/* Draggable top row, with room for the window controls */}
              <div
                className="drag-region flex shrink-0 items-center justify-end px-2"
                style={{
                  height: titleBarHeight,
                  ...(window.api.platform === 'win32' && {
                    paddingRight: WINDOWS_CAPTION_BUTTONS_WIDTH_PX,
                  }),
                }}
              >
                {window.api.platform === 'linux' && <LinuxWindowControls />}
              </div>
              {/* Content — overflow-anchor:none prevents scroll jumps when async content changes height */}
              <div
                ref={contentRef}
                className="min-h-0 flex-1 overflow-y-auto"
                style={{ overflowAnchor: 'none' }}
              >
                <div className="mx-auto max-w-[740px] px-8 pt-8 pb-10">
                  {header && (
                    <header
                      className={cn(
                        'mb-6 border-b border-border/60',
                        sectionedProject ? 'pb-0' : 'pb-5'
                      )}
                    >
                      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground">
                        <span className="truncate">{header.title}</span>
                        {header.alpha && (
                          <>
                            {' '}
                            <AlphaBadge />
                          </>
                        )}
                      </h1>
                      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
                        {header.description}
                      </p>
                      {sectionedProject && shownProjectsView.kind === 'project' && (
                        <div className="mt-5">
                          <ProjectSectionTabs
                            project={sectionedProject}
                            section={shownProjectsView.section}
                            onSectionChange={(projectSection) =>
                              requestPage({
                                tab: 'projects',
                                projectId: sectionedProject.id,
                                projectSection,
                              })
                            }
                          />
                        </div>
                      )}
                    </header>
                  )}

                  {activeTab === 'general' && (
                    <GeneralTab
                      onClose={handleClose}
                      onDirtyChange={handleDirtyChange('general')}
                    />
                  )}

                  {activeTab === 'appearance' && <AppearanceTab />}

                  {activeTab === 'terminal' && <TerminalTab />}

                  {activeTab === 'files' && <FilesTab />}

                  {activeTab === 'voice' && <VoiceTab />}

                  {activeTab === 'shortcuts' && (
                    <ShortcutsTab onDirtyChange={handleDirtyChange('shortcuts')} />
                  )}

                  {activeTab === 'agent' && (
                    <AgentTab
                      onClose={handleClose}
                      onSaveClose={handleSaveClose}
                      onDirtyChange={handleDirtyChange('agent')}
                    />
                  )}

                  {activeTab === 'integrations' && <IntegrationsTab />}

                  {activeTab === 'ssh' && <SshTab />}

                  {activeTab === 'projects' &&
                    (shownProject ? (
                      <ProjectSettingsPage
                        key={shownProject.id}
                        project={shownProject}
                        onDirtyChange={handleDirtyChange('projects')}
                        section={
                          shownProjectsView.kind === 'project'
                            ? shownProjectsView.section
                            : undefined
                        }
                      />
                    ) : (
                      <ProjectsTab
                        adding={shownProjectsView.kind === 'add'}
                        onAddProject={() => requestPage({ tab: 'projects', addProject: true })}
                        onShowList={() => requestPage({ tab: 'projects' })}
                        onOpenProject={(projectId) => requestPage({ tab: 'projects', projectId })}
                      />
                    ))}

                  {activeTab === 'git' && <GitTab />}
                  {activeTab === 'actions' && <ActionsTab onClose={handleClose} />}

                  {activeTab === 'automations' && <AutomationsTab onClose={handleClose} />}

                  <Suspense fallback={null}>
                    {activeTab === 'remote' && <RemoteTab />}

                    {activeTab === 'changelog' && (
                      <ChangelogTab
                        onClose={handleClose}
                        onDirtyChange={handleDirtyChange('changelog')}
                      />
                    )}
                  </Suspense>

                  {activeTab === 'license' && (
                    <LicenseTab
                      onClose={handleClose}
                      onDirtyChange={handleDirtyChange('license')}
                    />
                  )}
                </div>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unsaved changes confirmation, before closing or leaving a page */}
      <Dialog open={discardPromptOpen} onOpenChange={setDiscardPromptOpen}>
        <DialogContent role="alertdialog" className="max-w-sm !gap-0 !p-0">
          <div className="space-y-2 px-5 pt-5 pb-4">
            <DialogTitle className="text-sm font-semibold">Unsaved changes</DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed text-muted-foreground">
              {discardPrompt.kind === 'page'
                ? discardPrompt.message
                : 'You have unsaved changes. Discard them and close Settings?'}
            </DialogDescription>
          </div>
          <div className="flex justify-end gap-2 border-t border-border/30 px-5 py-3">
            <Button variant="ghost" size="sm" onClick={() => setDiscardPromptOpen(false)}>
              Keep editing
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDiscard}>
              Discard changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ReleaseNotesDialog open={releaseNotesOpen} onOpenChange={setReleaseNotesOpen} />
    </>
  );
}
