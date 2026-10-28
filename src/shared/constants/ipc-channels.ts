export const IPC = {
  // Workspace
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_CREATE_BATCH: 'workspace:create-batch',
  WORKSPACE_ADD_TERMINAL: 'workspace:add-terminal',
  WORKSPACE_ADD_AGENT_TAB: 'workspace:add-agent-tab',
  WORKSPACE_REMOVE_TERMINAL: 'workspace:remove-terminal',
  WORKSPACE_STOP: 'workspace:stop',
  WORKSPACE_STOP_TERMINAL: 'workspace:stop-terminal',
  WORKSPACE_RESTART_TERMINAL: 'workspace:restart-terminal',
  WORKSPACE_RECONNECT_SSH_TERMINAL: 'workspace:reconnect-ssh-terminal',
  WORKSPACE_FIND_IN_SSH_TERMINAL: 'workspace:find-in-ssh-terminal',
  WORKSPACE_RECOVER_SSH_SESSIONS: 'workspace:recover-ssh-sessions',
  WORKSPACE_LIST_REMOTE_SSH: 'workspace:list-remote-ssh',
  WORKSPACE_ADOPT_REMOTE_SSH: 'workspace:adopt-remote-ssh',
  WORKSPACE_LINK_SSH_PROJECT: 'workspace:link-ssh-project',
  WORKSPACE_SYNC_SSH_HOST: 'workspace:sync-ssh-host',
  WORKSPACE_REMOVE_MISSING_SSH: 'workspace:remove-missing-ssh',
  WORKSPACE_DELETE: 'workspace:delete',
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_GET: 'workspace:get',
  WORKSPACE_UPDATE: 'workspace:update',
  WORKSPACE_UPDATE_TERMINAL: 'workspace:update-terminal',
  WORKSPACE_RESTART: 'workspace:restart',
  WORKSPACE_REORDER: 'workspace:reorder',
  WORKSPACE_GENERATE_BRANCH_NAME: 'workspace:generate-branch-name',
  WORKSPACE_REGENERATE_NAME: 'workspace:regenerate-name',
  WORKSPACE_CANCEL_BRANCH_NAMING: 'workspace:cancel-branch-naming',
  WORKSPACE_MOVE_TO_WINDOW: 'workspace:move-to-window',
  WORKSPACE_SAVE_LAYOUTS_ON_CLOSE: 'workspace:save-layouts-on-close',
  WORKSPACE_SET_PANE_SURFACE_WORKSPACES: 'workspace:set-pane-surface-workspaces',
  WORKSPACE_NOTIFY_CHANGED: 'workspace:notify-changed',
  WORKSPACE_LINK: 'workspace:link',
  WORKSPACE_UNLINK: 'workspace:unlink',
  WORKSPACE_SET_MANUAL_SPINNER: 'workspace:set-manual-spinner',
  WORKSPACE_CLEAR_TERMINAL_ATTENTION: 'workspace:clear-terminal-attention',
  WORKSPACE_TERMINAL_ATTENTION_SEEN: 'workspace:terminal-attention-seen',
  WORKSPACE_START_SSH_PREVIEW_FORWARD: 'workspace:start-ssh-preview-forward',
  WORKSPACE_STOP_SSH_PREVIEW_FORWARD: 'workspace:stop-ssh-preview-forward',
  WORKSPACE_START_SSH_LINK_FORWARD: 'workspace:start-ssh-link-forward',
  WORKSPACE_STOP_SSH_LINK_FORWARD: 'workspace:stop-ssh-link-forward',
  WORKSPACE_RETRY_SETUP_STEP: 'workspace:retry-setup-step',
  WORKSPACE_RETRY_LOCAL_MIRROR_SYNC: 'workspace:retry-local-mirror-sync',
  WORKSPACE_DISMISS_SETUP_ACTIVITY: 'workspace:dismiss-setup-activity',
  WORKSPACE_RUN_BACKGROUND_ACTION: 'workspace:run-background-action',
  WORKSPACE_STOP_BACKGROUND_ACTION_RUN: 'workspace:stop-background-action-run',

  // Workspace events (main → renderer)
  WORKSPACE_CREATED: 'workspace:created',
  WORKSPACE_UPDATED: 'workspace:updated',
  WORKSPACES_CHANGED: 'workspaces:changed',
  WORKSPACE_REMOVED_ON_OTHER_DEVICE: 'workspace:removed-on-other-device',
  WORKSPACE_LAYOUT_CHANGED_ON_OTHER_DEVICE: 'workspace:layout-changed-on-other-device',
  WORKSPACE_NEEDS_ATTENTION: 'workspace:needs-attention',
  WORKSPACE_AGENT_TAB_ADDED: 'workspace:agent-tab-added',
  WORKSPACE_OPEN_DEV_PREVIEW: 'workspace:open-dev-preview',
  WORKSPACE_TRASH_REQUESTED: 'workspace:trash-requested',
  WORKSPACE_WINDOW_CHANGED: 'workspace:window-changed',
  WORKSPACE_MOVED_HERE: 'workspace:moved-here',
  WORKSPACE_SELECT: 'workspace:select',
  WORKSPACE_FOCUS_WINDOW: 'workspace:focus-window',
  WORKSPACE_LOCAL_MIRROR_SYNC_STATUS: 'workspace:local-mirror-sync-status',

  // PTY
  PTY_INPUT: 'pty:input',
  PTY_RESIZE: 'pty:resize',
  PTY_GET_BUFFER: 'pty:get-buffer',
  PTY_DATA: 'pty:data',
  PTY_ACK: 'pty:ack',
  TERMINAL_SET_FOCUS: 'terminal:set-focus',
  TERMINAL_CLAIM_SIZE: 'terminal:claim-size',

  // Terminal events (main → renderer)
  TERMINAL_STATUS_CHANGE: 'terminal:status-change',
  TERMINAL_EXIT: 'terminal:exit',
  TERMINAL_ERROR: 'terminal:error',
  TERMINAL_HOST_CHANGED: 'terminal:host-changed',
  TERMINAL_RESET: 'terminal:reset',
  TERMINAL_SIZE_AUTHORITY: 'terminal:size-authority',

  // Git
  GIT_GET_DIRECTORY_INFO: 'git:get-directory-info',
  GIT_LIST_WORKTREES: 'git:list-worktrees',
  GIT_GET_WORKTREE_BRANCHES: 'git:get-worktree-branches',
  GIT_VALIDATE_REPO: 'git:validate-repo',
  GIT_GET_CHANGED_FILES_WITH_SUMMARY: 'git:get-changed-files-with-summary',
  GIT_GET_DIFF: 'git:get-diff',
  GIT_GET_DIFF_AGAINST_BRANCH: 'git:get-diff-against-branch',
  GIT_GET_FILE_DIFF_CONTENT: 'git:get-file-diff-content',
  GIT_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH: 'git:get-file-diff-content-against-branch',
  WORKSPACE_GET_DIFF: 'workspace:get-diff',
  WORKSPACE_GET_DIFF_AGAINST_BRANCH: 'workspace:get-diff-against-branch',
  WORKSPACE_GET_FILE_DIFF_CONTENT: 'workspace:get-file-diff-content',
  WORKSPACE_GET_FILE_DIFF_CONTENT_AGAINST_BRANCH: 'workspace:get-file-diff-content-against-branch',
  WORKSPACE_LIST_FILES: 'workspace:list-files',
  WORKSPACE_READ_FILE: 'workspace:read-file',
  WORKSPACE_SEARCH_CONTENT: 'workspace:search-content',
  WORKSPACE_READ_IMAGE_FILE: 'workspace:read-image-file',
  WORKSPACE_WRITE_FILE: 'workspace:write-file',
  WORKSPACE_DELETE_PATH: 'workspace:delete-path',
  WORKSPACE_IMPORT_EXTERNAL_FILE: 'workspace:import-external-file',
  WORKSPACE_READ_VIEWER_FILE: 'workspace:read-viewer-file',
  WORKSPACE_GET_VIEWER_PREVIEW_URL: 'workspace:get-viewer-preview-url',
  WORKSPACE_LIST_VIEWER_FOLDER: 'workspace:list-viewer-folder',
  WORKSPACE_GET_BRANCH_STATUS: 'workspace:get-branch-status',
  WORKSPACE_LIST_BRANCHES: 'workspace:list-branches',
  WORKSPACE_GET_COMMIT_GRAPH: 'workspace:get-commit-graph',
  WORKSPACE_GET_PULL_REQUEST_STATUS: 'workspace:get-pull-request-status',
  WORKSPACE_GET_COMMIT_DIFF: 'workspace:get-commit-diff',
  WORKSPACE_GET_COMMIT_FILE_DIFF: 'workspace:get-commit-file-diff',
  WORKSPACE_FETCH_REMOTE: 'workspace:fetch-remote',
  WORKSPACE_MERGE_FROM: 'workspace:merge-from',
  WORKSPACE_REBASE_ON_BRANCH: 'workspace:rebase-on-branch',
  WORKSPACE_PUSH: 'workspace:push',
  WORKSPACE_PULL: 'workspace:pull',
  WORKSPACE_PUSH_TARGET_BRANCH: 'workspace:push-target-branch',
  WORKSPACE_PULL_TARGET_BRANCH: 'workspace:pull-target-branch',
  WORKSPACE_MERGE_TARGET_BRANCH_FROM_REMOTE: 'workspace:merge-target-branch-from-remote',
  WORKSPACE_MERGE_TO_TARGET_BRANCH: 'workspace:merge-to-target-branch',
  WORKSPACE_RESTORE_FILE: 'workspace:restore-file',
  WORKSPACE_DISCARD_ALL_CHANGES: 'workspace:discard-all-changes',
  WORKSPACE_INSPECT_COMMIT_SCOPE: 'workspace:inspect-commit-scope',
  WORKSPACE_GENERATE_COMMIT_DRAFT: 'workspace:generate-commit-draft',
  WORKSPACE_COMMIT_CHANGES: 'workspace:commit-changes',
  WORKSPACE_CREATE_BRANCH: 'workspace:create-branch',
  WORKSPACE_SWITCH_BRANCH: 'workspace:switch-branch',
  GIT_GET_BRANCH_STATUS: 'git:get-branch-status',
  GIT_MERGE_FROM: 'git:merge-from',
  GIT_LIST_BRANCHES: 'git:list-branches',
  GIT_HAS_ORIGIN_REMOTE: 'git:has-origin-remote',
  GIT_GET_MAIN_BRANCH: 'git:get-main-branch',
  GIT_FETCH: 'git:fetch',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_PULL_REBASE: 'git:pull-rebase',
  GIT_PUSH_TARGET_BRANCH: 'git:push-target-branch',
  GIT_PULL_TARGET_BRANCH: 'git:pull-target-branch',
  GIT_MERGE_TARGET_BRANCH_FROM_REMOTE: 'git:merge-target-branch-from-remote',
  GIT_REBASE_ON_TARGET_BRANCH: 'git:rebase-on-target-branch',
  GIT_REBASE_ON_BRANCH: 'git:rebase-on-branch',
  GIT_ABORT_REBASE: 'git:abort-rebase',
  GIT_MERGE_TO_TARGET_BRANCH: 'git:merge-to-target-branch',
  GIT_SWITCH_BRANCH: 'git:switch-branch',
  GIT_DELETE_BRANCH: 'git:delete-branch',
  GIT_DELETE_REMOTE_BRANCH: 'git:delete-remote-branch',
  GIT_GET_BRANCH_URL: 'git:get-branch-url',
  GIT_GET_CREATE_PR_URL: 'git:get-create-pr-url',
  GIT_GET_REPO_WEB_INFO: 'git:get-repo-web-info',
  GIT_FILE_EXISTS: 'git:file-exists',
  GIT_GET_FILE_METADATA: 'git:get-file-metadata',
  GIT_COPY_FILE: 'git:copy-file',
  GIT_COPY_DIRECTORY: 'git:copy-directory',
  GIT_IMPORT_EXTERNAL_FILE: 'git:import-external-file',
  GIT_DELETE_FILE: 'git:delete-file',
  GIT_RENAME_FILE: 'git:rename-file',
  GIT_CREATE_DIRECTORY: 'git:create-directory',
  GIT_WRITE_FILE: 'git:write-file',
  GIT_LIST_FILES: 'git:list-files',
  GIT_READ_FILE: 'git:read-file',
  GIT_GET_HTML_PREVIEW_URL: 'git:get-html-preview-url',
  GIT_READ_IMAGE_FILE: 'git:read-image-file',
  GIT_GET_MEDIA_FILE_METADATA: 'git:get-media-file-metadata',
  GIT_READ_MEDIA_FILE: 'git:read-media-file',
  GIT_RESTORE_FILE: 'git:restore-file',
  GIT_DISCARD_ALL_CHANGES: 'git:discard-all-changes',
  GIT_INSPECT_COMMIT_SCOPE: 'git:inspect-commit-scope',
  GIT_GENERATE_COMMIT_DRAFT: 'git:generate-commit-draft',
  GIT_COMMIT_CHANGES: 'git:commit-changes',
  GIT_VALIDATE_REMOTE_URL: 'git:validate-remote-url',
  GIT_ADD_ORIGIN_REMOTE: 'git:add-origin-remote',
  GIT_CREATE_GITHUB_REPO: 'git:create-github-repo',
  GIT_PUSH_PROJECT_BRANCHES: 'git:push-project-branches',
  GIT_CHECK_GH_AUTH: 'git:check-gh-auth',
  GIT_GET_IDENTITY: 'git:get-identity',
  GIT_SET_IDENTITY: 'git:set-identity',
  GIT_GET_BLAME: 'git:get-blame',
  GIT_REFRESH_STATUS: 'git:refresh-status',

  // Git events (main → renderer)
  GIT_PROGRESS: 'git:progress',
  GIT_STATUS_WORKTREE_CHANGED: 'git-status:worktree-changed',
  WORKSPACE_OBSERVATIONS_GET: 'workspace-observations:get',
  WORKSPACE_OBSERVATION_CHANGED: 'workspace-observation:changed',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_UPDATE: 'config:update',
  CONFIG_CHANGED: 'config:changed',
  CONFIG_SAVE_OPENROUTER_API_KEY: 'config:save-openrouter-api-key',
  CONFIG_CLEAR_OPENROUTER_API_KEY: 'config:clear-openrouter-api-key',
  CONFIG_GET_OPENROUTER_KEY_STATUS: 'config:get-openrouter-key-status',
  CONFIG_TEST_CUSTOM_ENDPOINT: 'config:test-custom-endpoint',
  SSH_LIST_HOSTS: 'ssh:list-hosts',
  SSH_LIST_CONFIG_HOSTS: 'ssh:list-config-hosts',
  SSH_SAVE_HOST: 'ssh:save-host',
  SSH_HOSTS_CHANGED: 'ssh:hosts-changed',
  SSH_HOST_STATUSES_GET: 'ssh:host-statuses-get',
  SSH_HOST_CHECK: 'ssh:host-check',
  SSH_HOST_STATUSES_CHANGED: 'ssh:host-statuses-changed', // main → renderer
  CONFIG_VERIFY_SSH_HOST: 'config:verify-ssh-host',
  SSH_DELETE_HOST: 'ssh:delete-host',
  SSH_GET_INTEGRATION_STATUS: 'ssh:get-integration-status',
  SSH_GET_CACHED_INTEGRATION_UPDATES: 'ssh:get-cached-integration-updates',
  SSH_INTEGRATION_UPDATES_CHANGED: 'ssh:integration-updates-changed',
  SSH_GET_PORT_FORWARD_STATUS: 'ssh:get-port-forward-status',
  SSH_LIST_FORWARDED_PORTS: 'ssh:list-forwarded-ports',
  SSH_STOP_DESKTOP_FORWARD: 'ssh:stop-desktop-forward',
  SSH_ENABLE_INTEGRATION: 'ssh:enable-integration',
  SSH_DISABLE_INTEGRATION: 'ssh:disable-integration',
  SSH_SET_KOMLA_SKILL: 'ssh:set-komla-skill',
  CONFIG_SELECT_DIRECTORY: 'config:select-directory',
  CONFIG_SELECT_ANY_DIRECTORY: 'config:select-any-directory',

  // Automations
  AUTOMATION_LIST: 'automation:list',
  AUTOMATION_SAVE: 'automation:save',
  AUTOMATION_SET_ENABLED: 'automation:set-enabled',
  AUTOMATION_DELETE: 'automation:delete',
  AUTOMATION_RUN_NOW: 'automation:run-now',

  // Automation events (main → renderer)
  AUTOMATIONS_CHANGED: 'automations:changed',

  // Category
  CATEGORY_LIST: 'category:list',
  CATEGORY_CREATE: 'category:create',
  CATEGORY_UPDATE: 'category:update',
  CATEGORY_DELETE: 'category:delete',
  CATEGORY_GET_SETTINGS_PATH: 'category:get-settings-path',

  // Category events (main → renderer)
  CATEGORIES_CHANGED: 'categories:changed',

  // Project
  PROJECT_CREATE: 'project:create',
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_UPDATE: 'project:update',
  PROJECT_SET_SSH_WORKSPACE_MODE_IF_UNSET: 'project:set-ssh-workspace-mode-if-unset',
  PROJECT_DELETE: 'project:delete',
  PROJECT_VALIDATE_REPO: 'project:validate-repo',
  PROJECT_FIND_FOR_FOLDER: 'project:find-for-folder',
  PROJECT_FOLDER_OPENED: 'project:folder-opened',
  PROJECT_RECENT_FOLDERS: 'project:recent-folders',
  PROJECT_HAS_PROJECTS: 'project:has-projects',
  PROJECT_GET_SETTINGS_PATH: 'project:get-settings-path',
  PROJECT_CREATE_FROM_REMOTE: 'project:create-from-remote',
  PROJECT_CREATE_FROM_NEW: 'project:create-from-new',
  PROJECT_FIND_ICONS: 'project:find-icons',
  PROJECT_TAKE_ICON_PROMPT: 'project:take-icon-prompt',
  PROJECT_CHOOSE_ICON_FILE: 'project:choose-icon-file',
  PROJECT_LIST_LEFTOVER_BRANCHES: 'project:list-leftover-branches',
  PROJECT_DELETE_LEFTOVER_BRANCHES: 'project:delete-leftover-branches',
  PROJECT_LIST_HOST_BRANCHES: 'project:list-host-branches',

  // Project events (main → renderer)
  PROJECTS_CHANGED: 'projects:changed',

  // Preset
  PRESET_LIST_TEMPLATES: 'preset:list-templates',
  PRESET_LIST: 'preset:list',
  PRESET_GET: 'preset:get',
  PRESET_GET_ACTIVE: 'preset:get-active',
  PRESET_SET_ACTIVE: 'preset:set-active',
  PRESET_CREATE: 'preset:create',
  PRESET_CREATE_ACTIVE: 'preset:create-active',
  PRESET_DETECT_INSTALLED: 'preset:detect-installed',
  PRESET_UPDATE: 'preset:update',
  PRESET_DELETE: 'preset:delete',
  PRESET_REORDER: 'preset:reorder',
  PRESET_GET_SETTINGS_PATH: 'preset:get-settings-path',
  PRESET_BUILD_PROMPT_COMMAND: 'preset:build-prompt-command',
  PRESET_GET_ACTIVE_PRESETS: 'preset:get-active-presets',
  PRESET_ADD_ACTIVE: 'preset:add-active',
  PRESET_REMOVE_ACTIVE: 'preset:remove-active',

  // Agent preset events (main → renderer)
  AGENT_PRESETS_CHANGED: 'agent-presets:changed',

  // License
  LICENSE_GET_STATUS: 'license:get-status',
  LICENSE_REFRESH_STATUS: 'license:refresh-status',
  LICENSE_ACTIVATE: 'license:activate',
  LICENSE_DEACTIVATE: 'license:deactivate',
  LICENSE_GET_WORKSPACE_QUOTA: 'license:get-workspace-quota',
  LICENSE_GET_ACTIVATIONS: 'license:get-activations',
  LICENSE_REVOKE_ACTIVATION: 'license:revoke-activation',
  LICENSE_OPEN_BILLING_PORTAL: 'license:open-billing-portal',
  LICENSE_GET_PRICES: 'license:get-prices',

  // License events (main → renderer)
  LICENSE_REVOKED: 'license:revoked',

  // Telemetry
  TELEMETRY_GET_DISTINCT_ID: 'telemetry:get-distinct-id',
  TELEMETRY_TRACK_MONETIZATION: 'telemetry:track-monetization',
  TELEMETRY_TRACK_AGENT_SELECTED: 'telemetry:track-agent-selected',
  TELEMETRY_TRACK_SSH_HOST_ADDED: 'telemetry:track-ssh-host-added',

  // Notifications
  NOTIFICATIONS_ENABLE: 'notifications:enable',
  NOTIFICATIONS_DISABLE: 'notifications:disable',
  NOTIFICATIONS_GET_HOOK_DETAILS: 'notifications:get-hook-details',
  NOTIFICATIONS_CLEAR_ATTENTION: 'notifications:clear-attention',

  // Codex notifications
  CODEX_NOTIFICATIONS_ENABLE: 'codex-notifications:enable',
  CODEX_NOTIFICATIONS_DISABLE: 'codex-notifications:disable',
  CODEX_NOTIFICATIONS_GET_HOOK_DETAILS: 'codex-notifications:get-hook-details',
  CODEX_NOTIFICATIONS_ENABLE_FORCE: 'codex-notifications:enable-force',

  // Antigravity CLI notifications
  ANTIGRAVITY_NOTIFICATIONS_ENABLE: 'antigravity-notifications:enable',
  ANTIGRAVITY_NOTIFICATIONS_DISABLE: 'antigravity-notifications:disable',
  ANTIGRAVITY_NOTIFICATIONS_GET_HOOK_DETAILS: 'antigravity-notifications:get-hook-details',

  // OpenCode notifications
  OPENCODE_NOTIFICATIONS_ENABLE: 'opencode-notifications:enable',
  OPENCODE_NOTIFICATIONS_DISABLE: 'opencode-notifications:disable',
  OPENCODE_NOTIFICATIONS_GET_HOOK_DETAILS: 'opencode-notifications:get-hook-details',

  // Komla skill in the skills folders agents read
  KOMLA_SKILL_GET_STATUS: 'komla-skill:get-status',
  KOMLA_SKILL_ENABLE: 'komla-skill:enable',
  KOMLA_SKILL_DISABLE: 'komla-skill:disable',

  // MCP
  MCP_GET_STATUS: 'mcp:get-status',
  MCP_ENABLE: 'mcp:enable',
  MCP_DISABLE: 'mcp:disable',
  MCP_RUN_CLI: 'mcp:run-cli',
  MCP_RUN_REMOVE_CLI: 'mcp:run-remove-cli',
  MCP_RUN_CODEX_CLI: 'mcp:run-codex-cli',
  MCP_RUN_CODEX_REMOVE_CLI: 'mcp:run-codex-remove-cli',
  MCP_RUN_ANTIGRAVITY_CLI: 'mcp:run-antigravity-cli',
  MCP_RUN_ANTIGRAVITY_REMOVE_CLI: 'mcp:run-antigravity-remove-cli',
  MCP_RECONFIGURE_ALL: 'mcp:reconfigure-all',

  // Customization
  CUSTOMIZATION_GET_THEME: 'customization:get-theme',
  CUSTOMIZATION_GET_TERMINAL: 'customization:get-terminal',
  CUSTOMIZATION_UPDATE_THEME: 'customization:update-theme',
  CUSTOMIZATION_UPDATE_TERMINAL: 'customization:update-terminal',
  CUSTOMIZATION_RESET_THEME: 'customization:reset-theme',

  // Customization events (main → renderer)
  CUSTOMIZATION_THEME_CHANGED: 'customization:theme-changed',
  CUSTOMIZATION_TERMINAL_CHANGED: 'customization:terminal-changed',

  // Shortcuts
  SHORTCUTS_GET: 'shortcuts:get',
  SHORTCUTS_UPDATE: 'shortcuts:update',
  SHORTCUTS_RESET: 'shortcuts:reset',

  // Shortcuts events (main → renderer)
  SHORTCUTS_CHANGED: 'shortcuts:changed',

  // Shortcut triggers (main → renderer)
  SHORTCUT_PANE_CLOSE: 'shortcut:pane-close',
  SHORTCUT_FORWARDED: 'shortcut:forwarded',

  // Actions
  ACTION_LIST: 'action:list',
  ACTION_CREATE: 'action:create',
  ACTION_UPDATE: 'action:update',
  ACTION_REORDER: 'action:reorder',
  ACTION_DELETE: 'action:delete',
  ACTION_RECORD_USAGE: 'action:record-usage',

  // Action events (main → renderer)
  ACTIONS_CHANGED: 'actions:changed',
  SETTINGS_FEEDBACK: 'settings:feedback',
  SETTINGS_APPROVAL_REQUESTED: 'settings:approval-requested',
  SETTINGS_APPROVAL_DISMISSED: 'settings:approval-dismissed',
  SETTINGS_APPROVAL_REQUEST_PENDING: 'settings:approval-request-pending',
  SETTINGS_APPROVAL_RESOLVE: 'settings:approval-resolve',
  SETTINGS_HISTORY_LIST: 'settings:history-list',
  SETTINGS_HISTORY_REVERT: 'settings:history-revert',
  SETTINGS_HISTORY_CHANGED: 'settings:history-changed',

  // Shell
  SHELL_OPEN_EXTERNAL: 'shell:open-external',
  SHELL_SHOW_ITEM_IN_FOLDER: 'shell:show-item-in-folder',
  SHELL_OPEN_PATH: 'shell:open-path',
  SHELL_GET_AVAILABLE_EDITORS: 'shell:get-available-editors',
  SHELL_OPEN_IN_EDITOR: 'shell:open-in-editor',
  SHELL_GET_WSL_DISTROS: 'shell:get-wsl-distros',

  // Window
  WINDOW_CREATE: 'window:create',
  WINDOW_GET_ALL_IDS: 'window:get-all-ids',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  WINDOW_IS_FULLSCREEN: 'window:is-fullscreen',
  WINDOW_SET_TITLE_BAR_OVERLAY: 'window:set-title-bar-overlay',

  // Window events (renderer → main)
  WINDOW_RENDERER_READY: 'window:renderer-ready',
  WINDOW_SET_UNSAVED_FILES: 'window:set-unsaved-files',
  WINDOW_SET_SHOWN_WORKSPACE: 'window:set-shown-workspace',

  // Window events (main → renderer)
  WINDOW_MAXIMIZED_CHANGE: 'window:maximized-change',
  WINDOW_FULLSCREEN_CHANGE: 'window:fullscreen-change',
  WINDOW_LIST_UPDATED: 'window:list-updated',

  // Dev preview
  DEV_PREVIEW_SYNC: 'dev-preview:sync',
  DEV_PREVIEW_HIDE: 'dev-preview:hide',
  DEV_PREVIEW_CLOSE: 'dev-preview:close',
  DEV_PREVIEW_RELOAD: 'dev-preview:reload',
  DEV_PREVIEW_NAVIGATE: 'dev-preview:navigate',
  DEV_PREVIEW_CLEAR_SITE_DATA: 'dev-preview:clear-site-data',
  DEV_PREVIEW_CAPTURE: 'dev-preview:capture',
  DEV_PREVIEW_DETECT_SERVICES: 'dev-preview:detect-services',
  LINK_PREVIEW_GET: 'link-preview:get',
  LINK_PREVIEW_IMAGE: 'link-preview:image',
  VIRTUAL_DESKTOP_OPEN_IN_VNC_APP: 'virtual-desktop:open-in-vnc-app',
  VIRTUAL_DESKTOP_FORGET: 'virtual-desktop:forget',
  VIRTUAL_DESKTOP_STARTED: 'virtual-desktop:started',
  DEV_PREVIEW_NAVIGATION_STATE_CHANGED: 'dev-preview:navigation-state-changed',
  DEV_PREVIEW_SNAPSHOT_UPDATED: 'dev-preview:snapshot-updated',
  DEV_PREVIEW_OPEN_TAB: 'dev-preview:open-tab',
  DEV_PREVIEW_FOCUSED: 'dev-preview:focused',

  // The macOS menu bar's agents item and its popover page
  AGENTS_MENU_BAR_STATE: 'agents-menu-bar:state', // main → popover page
  AGENTS_MENU_BAR_STATE_REQUEST: 'agents-menu-bar:state-request', // popover page → main
  AGENTS_MENU_BAR_DRAW: 'agents-menu-bar:draw', // main → app window: draw the item's image
  AGENTS_MENU_BAR_IMAGE: 'agents-menu-bar:image', // app window → main
  AGENTS_MENU_BAR_RESIZE: 'agents-menu-bar:resize', // popover page → main
  AGENTS_MENU_BAR_OPEN: 'agents-menu-bar:open', // popover page → main
  AGENTS_MENU_BAR_CLOSE: 'agents-menu-bar:close', // popover page → main
  AGENTS_MENU_BAR_THEME: 'agents-menu-bar:theme', // app window → main

  // Toast layer drawn above browser previews
  TOAST_OVERLAY_SHOW: 'toast-overlay:show',
  TOAST_OVERLAY_HIDE: 'toast-overlay:hide',
  TOAST_OVERLAY_CONTENT: 'toast-overlay:content', // main → overlay page
  TOAST_OVERLAY_EVENT: 'toast-overlay:event', // overlay page → main → main window
  TOAST_OVERLAY_POINTER_UP: 'toast-overlay:pointer-up', // overlay page → main

  // Dialog
  DIALOG_SHOW_MESSAGE_BOX: 'dialog:show-message-box',

  // App
  APP_GET_SYSTEM_METRICS: 'app:get-system-metrics',
  APP_GET_HOST_RESOURCES: 'app:get-host-resources',
  APP_GET_VERSION: 'app:get-version',
  APP_GET_BASE_PATH: 'app:get-base-path',
  APP_INSTALL_UPDATE: 'app:install-update',
  APP_CHECK_UPDATES: 'app:check-updates',
  APP_DOWNLOAD_UPDATE: 'app:download-update',

  RESOURCE_USAGE_GET: 'resource-usage:get',

  // Agent plan usage limits
  AGENT_USAGE_GET: 'agent-usage:get',
  AGENT_USAGE_REFRESH: 'agent-usage:refresh',
  AGENT_USAGE_CHANGED: 'agent-usage:changed', // main → renderer

  // App events (main → renderer)
  APP_UPDATE_AVAILABLE: 'app:update-available',
  APP_UPDATE_NOT_AVAILABLE: 'app:update-not-available',
  APP_UPDATE_DOWNLOADED: 'app:update-downloaded',
  APP_UPDATE_ERROR: 'app:update-error',

  // Announcements
  ANNOUNCEMENTS_GET: 'announcements:get',
  ANNOUNCEMENTS_DISMISS: 'announcements:dismiss',

  // Announcement events (main → renderer)
  ANNOUNCEMENTS_UPDATED: 'announcements:updated',

  // Feedback
  FEEDBACK_SELECT_SCREENSHOTS: 'feedback:select-screenshots',
  FEEDBACK_SEND: 'feedback:send',

  // Error reporting
  ERROR_REPORT: 'error:report',

  // Data management
  DATA_DELETE_ALL_WORKSPACES: 'data:delete-all-workspaces',
  DATA_CLEAR_LOGS: 'data:clear-logs',
  DATA_RESET_APP: 'data:reset-app',

  // Diagnostics
  DIAGNOSTICS_RENDERER_STATS: 'diagnostics:renderer-stats',

  // Managed repo
  MANAGED_REPO_FETCH: 'managed-repo:fetch',
  MANAGED_REPO_PUSH: 'managed-repo:push',
  MANAGED_REPO_GET_REMOTE_STATUS: 'managed-repo:get-remote-status',

  // Project sync
  PROJECT_SYNC_GET_ALL_STATUSES: 'project-sync:get-all-statuses',
  PROJECT_SYNC_REFRESH: 'project-sync:refresh',

  // Search

  // Server
  SERVER_GET_PORT_CHANGE: 'server:get-port-change',
  SERVER_GET_PORT: 'server:get-port',

  // Server events (main → renderer)
  SERVER_PORT_CHANGED: 'server:port-changed',

  // Askpass
  ASKPASS_REQUEST: 'askpass:request',
  ASKPASS_RESPONSE: 'askpass:response',
  ASKPASS_ENDED: 'askpass:ended',
  ASKPASS_NOT_REMEMBERED: 'askpass:not-remembered',

  // Voice transcription
  VOICE_MODEL_STATUS: 'voice:model-status',
  VOICE_MODELS_LIST: 'voice:models-list',
  VOICE_MODEL_SELECT: 'voice:model-select',
  VOICE_MODEL_DOWNLOAD: 'voice:model-download',
  VOICE_MODEL_DOWNLOAD_PROGRESS: 'voice:model-download-progress',
  VOICE_MODEL_DOWNLOAD_CANCEL: 'voice:model-download-cancel',
  VOICE_MODEL_DELETE: 'voice:model-delete',
  VOICE_TRANSCRIBE: 'voice:transcribe',
  VOICE_TRANSCRIBE_CANCEL: 'voice:transcribe-cancel',
  VOICE_WARMUP: 'voice:warmup',
  VOICE_REQUEST_MIC_ACCESS: 'voice:request-mic-access',
  VOICE_RECORDING_STATE: 'voice:recording-state',

  // Status bar items
  STATUS_ITEMS_LIST: 'status-items:list',
  STATUS_COMMANDS_LIST: 'status-items:commands-list',
  STATUS_COMMAND_RUN: 'status-items:command-run',
  STATUS_POPOVER_RUN: 'status-items:popover-run',
  STATUS_BUTTON_RUN: 'status-items:button-run',
  // Status bar item events (main → renderer)
  STATUS_ITEMS_CHANGED: 'status-items:changed',
  STATUS_COMMANDS_CHANGED: 'status-items:commands-changed',
  STATUS_COMMAND_RESULT: 'status-items:command-result',

  // Hooks (main → renderer): a hook failed, or hooks.json can't be read
  HOOK_NOTICE: 'hooks:notice',

  // Notes
  NOTES_LIST: 'notes:list',
  NOTES_CREATE: 'notes:create',
  NOTES_READ: 'notes:read',
  NOTES_WRITE: 'notes:write',
  NOTES_TRASH: 'notes:trash',
  NOTES_DELETE: 'notes:delete',
  // Notes events (main → renderer)
  NOTES_CHANGED: 'notes:changed',

  // Sounds
  SOUNDS_LIST_CUSTOM: 'sounds:list-custom',
  SOUNDS_GET_DATA_URL: 'sounds:get-data-url',
  SOUNDS_OPEN_DIRECTORY: 'sounds:open-directory',

  // Clipboard
  CLIPBOARD_WRITE_TEXT: 'clipboard:write-text',
  CLIPBOARD_READ_TEXT: 'clipboard:read-text',
  CLIPBOARD_IMPORT_IMAGE: 'clipboard:import-image',
  CLIPBOARD_STAGE_IMAGE: 'clipboard:stage-image',

  // Menu events (main → renderer)
  MENU_NEW_WORKSPACE: 'menu:new-workspace',
  MENU_ADD_PROJECT: 'menu:add-project',
  MENU_OPEN_FOLDER: 'menu:open-folder',
  MENU_OPEN_SETTINGS: 'menu:open-settings',
  MENU_OPEN_FEEDBACK: 'menu:open-feedback',
  HOLD_TO_QUIT_HINT: 'menu:hold-to-quit-hint',

  // Remote control (always-on auth + transient pairing offer)
  REMOTE_CONTROL_DISCONNECT_ACTIVE: 'remote-control:disconnect-active',
  REMOTE_CONTROL_DIRECT_START: 'remote-control:direct-start',
  REMOTE_CONTROL_DIRECT_STOP: 'remote-control:direct-stop',
  REMOTE_CONTROL_DIRECT_START_PAIRING: 'remote-control:direct-start-pairing',
  REMOTE_CONTROL_DIRECT_START_TAILSCALE_SERVE: 'remote-control:direct-start-tailscale-serve',
  REMOTE_CONTROL_DIRECT_GET_TAILSCALE_STATUS: 'remote-control:direct-get-tailscale-status',
  REMOTE_CONTROL_DIRECT_CANCEL_PAIRING: 'remote-control:direct-cancel-pairing',
  REMOTE_CONTROL_DIRECT_GET_STATE: 'remote-control:direct-get-state',
  REMOTE_CONTROL_HOST_ACCESS_LIST: 'remote-control:host-access-list',
  REMOTE_CONTROL_HOST_ACCESS_SET: 'remote-control:host-access-set',

  // Remote control events (main → renderer)
  REMOTE_CONTROL_DIRECT_STATE_CHANGED: 'remote-control:direct-state-changed',
  REMOTE_CONTROL_HOST_ACCESS_CHANGED: 'remote-control:host-access-changed',

  // Paired devices
  PAIRED_DEVICES_LIST: 'paired-devices:list',
  PAIRED_DEVICES_RENAME: 'paired-devices:rename',
  PAIRED_DEVICES_REMOVE: 'paired-devices:remove',

  // Paired devices events (main → renderer)
  PAIRED_DEVICES_CHANGED: 'paired-devices:changed',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
