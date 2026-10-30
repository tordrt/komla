import { z } from 'zod';

export const REMOTE_APP_PROTOCOL_VERSION = 1;
// V1 peers reject additive attention fields. Custom titles therefore travel in
// `message`, with this source marker telling newer clients that it is a label.
export const REMOTE_CUSTOM_TITLE_SOURCE_PREFIX = 'komla:custom-title:';

const MAX_ATTENTION_SOURCE_CHARS = 128;
// Senders must split terminal snapshots so no chunk's `data` exceeds this.
export const MAX_TERMINAL_SNAPSHOT_CHUNK_CHARS = 24 * 1024;

export function markRemoteAttentionCustomTitleSource(source: string): string {
  return `${REMOTE_CUSTOM_TITLE_SOURCE_PREFIX}${source}`.slice(0, MAX_ATTENTION_SOURCE_CHARS);
}

export function isRemoteAttentionCustomTitle(source: string): boolean {
  return source.startsWith(REMOTE_CUSTOM_TITLE_SOURCE_PREFIX);
}

export function escapeRemoteAttentionCustomTitleSource(source: string): string {
  if (!isRemoteAttentionCustomTitle(source)) return source;
  return `komla:source:${source}`.slice(0, MAX_ATTENTION_SOURCE_CHARS);
}

const RequestIdSchema = z.string().min(1).max(128);
const IdSchema = z.string().min(1).max(128);
export const MAX_NAME_CHARS = 256;
export const MAX_WORKSPACE_SEARCH_TEXT_CHARS = 512;
const NameSchema = z.string().min(1).max(MAX_NAME_CHARS);
const PathSchema = z.string().max(4096);
const PromptSchema = z.string().max(64 * 1024);
const WorkspaceAttentionSchema = z
  .object({
    kind: z.enum(['input-required', 'turn-complete', 'error', 'idle', 'generic']),
    source: z.string().min(1).max(MAX_ATTENTION_SOURCE_CHARS),
    updatedAt: z.number().int().nonnegative(),
    message: z.string().max(4096).optional(),
    terminalId: IdSchema.optional(),
  })
  .strict();

// A workspace's tag as the desktop shows it, e.g. "In review": its name, color and whether it spins.
export const MAX_REMOTE_WORKSPACE_TAG_CHARS = 40;
export const REMOTE_WORKSPACE_TAG_TONES = [
  'neutral',
  'info',
  'attention',
  'success',
  'warning',
  'error',
] as const;
export const RemoteWorkspaceTagSchema = z
  .object({
    name: z.string().min(1).max(MAX_REMOTE_WORKSPACE_TAG_CHARS),
    tone: z.enum(REMOTE_WORKSPACE_TAG_TONES),
    spinner: z.literal(true).optional(),
  })
  .strict();

const RemoteTerminalEnvironmentSchema = z
  .object({
    kind: z.literal('ssh'),
    name: NameSchema,
  })
  .strict();

export const RemoteWorkspaceSummarySchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    // What the desktop's search also matches: the user's note and the last prompt, clipped.
    description: z.string().max(MAX_WORKSPACE_SEARCH_TEXT_CHARS).optional(),
    lastPrompt: z.string().max(MAX_WORKSPACE_SEARCH_TEXT_CHARS).optional(),
    workingDirectory: PathSchema,
    projectId: IdSchema.nullable().optional(),
    projectName: NameSchema.optional(),
    projectColor: z.string().max(128).optional(),
    branchName: z.string().max(256).optional(),
    tag: RemoteWorkspaceTagSchema.optional(),
    status: z.enum(['active', 'stashed', 'archived', 'trashed']),
    provisioning: z.boolean(),
    agentActive: z.boolean().optional(),
    needsAttention: z.boolean().optional(),
    attention: WorkspaceAttentionSchema.optional(),
    createdAt: z.number().int().nonnegative().optional(),
    lastActivityAt: z.number().int().nonnegative().optional(),
    git: z
      .object({
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        aheadTargetBranch: z.number().int().nonnegative(),
        behindTargetBranch: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    primaryTerminalId: IdSchema.optional(),
    terminals: z.array(
      z.object({
        id: IdSchema,
        name: NameSchema,
        status: z.enum(['starting', 'running', 'stopped']),
        environment: RemoteTerminalEnvironmentSchema.optional(),
        agentActive: z.boolean().optional(),
        attention: WorkspaceAttentionSchema.optional(),
      })
    ),
  })
  .strict();

// A project's icon as the desktop shows it. Larger ones stay on the desktop, so a project list with
// icons still fits one frame.
export const MAX_REMOTE_PROJECT_ICON_CHARS = 16 * 1024;
export const RemoteProjectIconSchema = z
  .string()
  .max(MAX_REMOTE_PROJECT_ICON_CHARS)
  .regex(/^data:image\/(?:png|jpeg|svg\+xml|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/);

export const RemoteProjectSummarySchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    repositoryPath: PathSchema,
    color: z.string().max(128).optional(),
    // Only sent over a session that agreed on REMOTE_CAPABILITIES.PROJECT_ICONS.
    icon: RemoteProjectIconSchema.optional(),
  })
  .strict();

export const RemoteLaunchModeSummarySchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    color: z.string().max(128).optional(),
  })
  .strict();

export const RemoteAgentPresetSummarySchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    launchModes: z.array(RemoteLaunchModeSummarySchema),
    lastLaunchModeId: IdSchema.nullable().optional(),
  })
  .strict();

export const RemoteLaunchEnvironmentSummarySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), name: NameSchema }).strict(),
  z.object({ kind: z.literal('ssh'), id: IdSchema, name: NameSchema }).strict(),
]);

export const RemoteActionSummarySchema = z
  .object({
    id: IdSchema,
    title: NameSchema,
    type: z.enum(['prompt', 'command']),
    projectIds: z.array(IdSchema).optional(),
    requiresInput: z.boolean().optional(),
  })
  .strict();

export const RemoteWorkspaceEnvironmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }).strict(),
  z.object({ kind: z.literal('ssh'), hostId: IdSchema }).strict(),
]);

export const RemoteTerminalSnapshotSchema = z
  .object({
    workspaceId: IdSchema,
    terminalId: IdSchema,
    status: z.enum(['starting', 'running', 'stopped']),
    seq: z.number().int().min(0),
    // 0 is an empty screen for a terminal whose PTY has not spawned; its first
    // spawn arrives as an app:terminal:reset to generation 1.
    generation: z.number().int().min(0),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
    // 0 when a resumed attach sends no snapshot, only the output the phone missed.
    chunkCount: z.number().int().min(0).max(4096),
  })
  .strict();

export const RemoteListWorkspacesSchema = z
  .object({
    type: z.literal('app:workspaces:list'),
    requestId: RequestIdSchema,
  })
  .strict();

export const RemoteLaunchOptionsGetSchema = z
  .object({
    type: z.literal('app:launch-options:get'),
    requestId: RequestIdSchema,
  })
  .strict();

export const RemoteLaunchOptionsSchema = z
  .object({
    type: z.literal('app:launch-options'),
    requestId: RequestIdSchema,
    projects: z.array(RemoteProjectSummarySchema),
    presets: z.array(RemoteAgentPresetSummarySchema),
    environments: z.array(RemoteLaunchEnvironmentSummarySchema).optional(),
    actions: z.array(RemoteActionSummarySchema).optional(),
    defaultLaunchModeId: IdSchema.optional(),
  })
  .strict();

export const RemoteWorkspacesSchema = z
  .object({
    type: z.literal('app:workspaces'),
    requestId: RequestIdSchema,
    workspaces: z.array(RemoteWorkspaceSummarySchema),
    /** More pages of this list follow, with the same requestId; the last page omits it. */
    more: z.literal(true).optional(),
  })
  .strict();

export const RemoteCreateWorkspaceSchema = z
  .object({
    type: z.literal('app:workspace:create'),
    requestId: RequestIdSchema,
    projectId: IdSchema.optional(),
    name: NameSchema.optional(),
    branchName: z.string().min(1).max(256).optional(),
    presetId: IdSchema.optional(),
    launchModeId: IdSchema.optional(),
    initialPrompt: PromptSchema.optional(),
    environment: RemoteWorkspaceEnvironmentSchema.optional(),
  })
  .strict();

export const RemoteWorkspaceCreatedSchema = z
  .object({
    type: z.literal('app:workspace:created'),
    requestId: RequestIdSchema,
    workspace: RemoteWorkspaceSummarySchema,
  })
  .strict();

export const RemoteStartWorkspaceSchema = z
  .object({
    type: z.literal('app:workspace:start'),
    requestId: RequestIdSchema,
    workspaceId: IdSchema,
  })
  .strict();

export const RemoteWorkspaceStartedSchema = z
  .object({
    type: z.literal('app:workspace:started'),
    requestId: RequestIdSchema,
    workspace: RemoteWorkspaceSummarySchema,
  })
  .strict();

export const RemoteStopWorkspaceSchema = z
  .object({
    type: z.literal('app:workspace:stop'),
    requestId: RequestIdSchema,
    workspaceId: IdSchema,
  })
  .strict();

export const RemoteWorkspaceStoppedSchema = z
  .object({
    type: z.literal('app:workspace:stopped'),
    requestId: RequestIdSchema,
    workspace: RemoteWorkspaceSummarySchema,
  })
  .strict();

export const RemoteRegenerateWorkspaceTitleSchema = z
  .object({
    type: z.literal('app:workspace:title:regenerate'),
    requestId: RequestIdSchema,
    workspaceId: IdSchema,
  })
  .strict();

export const RemoteWorkspaceTitleRegeneratedSchema = z
  .object({
    type: z.literal('app:workspace:title:regenerated'),
    requestId: RequestIdSchema,
    workspace: RemoteWorkspaceSummarySchema,
  })
  .strict();

export const RemoteAttachTerminalSchema = z
  .object({
    type: z.literal('app:terminal:attach'),
    requestId: RequestIdSchema,
    workspaceId: IdSchema,
    terminalId: IdSchema.optional(),
    cols: z.number().int().min(1).max(1000).optional(),
    rows: z.number().int().min(1).max(1000).optional(),
    /**
     * What this phone's screen already shows of the terminal, after a reconnect: output of
     * `generation` up to `seq`. The desktop sends only what follows when it still has it.
     */
    resume: z
      .object({
        generation: z.number().int().min(1),
        seq: z.number().int().min(0),
      })
      .strict()
      .optional(),
  })
  .strict();

export const RemoteTerminalAttachedSchema = z
  .object({
    type: z.literal('app:terminal:attached'),
    requestId: RequestIdSchema,
    snapshot: RemoteTerminalSnapshotSchema,
    /** The phone keeps its screen: data frames after `snapshot.seq` follow, and no chunks. */
    resumed: z.literal(true).optional(),
  })
  .strict();

export const RemoteTerminalSnapshotChunkSchema = z
  .object({
    type: z.literal('app:terminal:snapshot-chunk'),
    requestId: RequestIdSchema,
    terminalId: IdSchema,
    generation: z.number().int().min(0),
    index: z.number().int().min(0).max(4095),
    data: z.string().max(MAX_TERMINAL_SNAPSHOT_CHUNK_CHARS),
  })
  .strict();

export const RemoteTerminalDataSchema = z
  .object({
    type: z.literal('app:terminal:data'),
    workspaceId: IdSchema,
    terminalId: IdSchema,
    data: z.string(),
    seq: z.number().int().min(0),
    generation: z.number().int().min(1),
    /**
     * Output too large for one frame is split: every piece but the last says
     * more follows, and all of them carry the seq of the output they belong to.
     */
    more: z.literal(true).optional(),
  })
  .strict();

export const RemoteTerminalResetSchema = z
  .object({
    type: z.literal('app:terminal:reset'),
    workspaceId: IdSchema,
    terminalId: IdSchema,
    generation: z.number().int().min(1),
    seq: z.number().int().min(0),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();

/**
 * Who the terminal's size follows. Someone using the terminal on the desktop takes its size
 * back (`desktop`, at the desktop's size), and the device's next resize takes it again
 * (`remote`, at the size it asked for).
 */
export const RemoteTerminalSizeSchema = z
  .object({
    type: z.literal('app:terminal:size'),
    workspaceId: IdSchema,
    terminalId: IdSchema,
    owner: z.enum(['desktop', 'remote']),
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();

export const RemoteTerminalStatusSchema = z
  .object({
    type: z.literal('app:terminal:status'),
    workspaceId: IdSchema.optional(),
    terminalId: IdSchema,
    status: z.enum(['starting', 'running', 'stopped']),
  })
  .strict();

export const RemoteTerminalInputSchema = z
  .object({
    type: z.literal('app:terminal:input'),
    terminalId: IdSchema,
    data: z.string(),
  })
  .strict();

export const RemoteTerminalDetachSchema = z
  .object({
    type: z.literal('app:terminal:detach'),
    terminalId: IdSchema,
  })
  .strict();

export const RemoteTerminalResizeSchema = z
  .object({
    type: z.literal('app:terminal:resize'),
    terminalId: IdSchema,
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  })
  .strict();

const RemoteTerminalSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('shell') }).strict(),
  z
    .object({
      kind: z.literal('agent'),
      presetId: IdSchema,
      launchModeId: IdSchema.optional(),
      prompt: PromptSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('action'),
      actionId: IdSchema,
      userInput: PromptSchema.optional(),
    })
    .strict(),
]);

export const RemoteCreateTerminalSchema = z
  .object({
    type: z.literal('app:terminal:create'),
    requestId: RequestIdSchema,
    workspaceId: IdSchema,
    source: RemoteTerminalSourceSchema,
  })
  .strict();

export const RemoteTerminalCreatedSchema = z
  .object({
    type: z.literal('app:terminal:created'),
    requestId: RequestIdSchema,
    workspace: RemoteWorkspaceSummarySchema,
    terminalId: IdSchema,
  })
  .strict();

export const RemoteCloseTerminalSchema = z
  .object({
    type: z.literal('app:terminal:close'),
    requestId: RequestIdSchema,
    workspaceId: IdSchema,
    terminalId: IdSchema,
  })
  .strict();

export const RemoteTerminalClosedSchema = z
  .object({
    type: z.literal('app:terminal:closed'),
    requestId: RequestIdSchema,
    workspace: RemoteWorkspaceSummarySchema,
    terminalId: IdSchema,
  })
  .strict();

// Voice dictation. The client records mic audio, downsamples to 16 kHz mono,
// and ships it as little-endian Int16 PCM base64. The desktop transcribes
// locally with the same on-device model the renderer uses and writes the
// resulting text straight into the attached terminal's PTY.
export const RemoteVoiceStatusSchema = z
  .object({
    type: z.literal('app:voice:status'),
    requestId: RequestIdSchema,
  })
  .strict();

export const RemoteVoiceAvailabilitySchema = z
  .object({
    type: z.literal('app:voice:availability'),
    requestId: RequestIdSchema,
    available: z.boolean(),
  })
  .strict();

export const RemoteVoiceTranscribeSchema = z
  .object({
    type: z.literal('app:voice:transcribe'),
    requestId: RequestIdSchema,
    terminalId: IdSchema.optional(),
    purpose: z.enum(['terminal', 'prompt']).optional(),
    // Base64 (standard alphabet) of little-endian Int16 PCM, 16 kHz mono.
    // A single recording is split into ordered chunks so each frame stays
    // under the wire-level MAX_FRAME_CHARS cap (64 KiB) once the app frame is
    // encrypted and base64-wrapped into an `e2e:enc` envelope; the desktop
    // reassembles them by requestId. `seq` is the 0-based chunk index and
    // `final` marks the last chunk, which triggers transcription. The client
    // chunks at 32 KiB of PCM (~43.7 KiB of base64); cap the field a little
    // above that so an oversized chunk fails as a clean app-level error here
    // rather than as an opaque transport teardown.
    audio: z
      .string()
      .min(4)
      .max(48 * 1024),
    seq: z.number().int().min(0).max(4096),
    final: z.boolean(),
    // When true, the desktop appends a carriage return after typing the
    // transcript so the terminal submits it. Read from the final chunk.
    enter: z.boolean(),
  })
  .strict();

export const RemoteVoiceTranscribedSchema = z
  .object({
    type: z.literal('app:voice:transcribed'),
    requestId: RequestIdSchema,
    text: z.string().max(64 * 1024),
  })
  .strict();

// Web Push. The phone subscribes with its browser's PushManager, and the desktop sends straight to
// that browser's push service with its own VAPID key, encrypting each payload to the
// subscription's keys (RFC 8291). The push service only relays ciphertext.
const Base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const PushNotifyWhenSchema = z.enum(['away', 'always']);

export const RemotePushSubscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .max(2048)
      .regex(/^https:\/\//),
    keys: z
      .object({
        p256dh: Base64UrlSchema.length(87),
        auth: Base64UrlSchema.length(22),
      })
      .strict(),
  })
  .strict();

export const RemotePushConfigGetSchema = z
  .object({
    type: z.literal('app:push:config:get'),
    requestId: RequestIdSchema,
  })
  .strict();

export const RemotePushConfigSchema = z
  .object({
    type: z.literal('app:push:config'),
    requestId: RequestIdSchema,
    /** False when this desktop can't keep a push key, e.g. no OS keychain. */
    available: z.boolean(),
    vapidPublicKey: Base64UrlSchema.length(87).optional(),
    subscribed: z.boolean(),
    notifyWhen: PushNotifyWhenSchema,
  })
  .strict();

export const RemotePushSubscribeSchema = z
  .object({
    type: z.literal('app:push:subscribe'),
    requestId: RequestIdSchema,
    subscription: RemotePushSubscriptionSchema,
    notifyWhen: PushNotifyWhenSchema,
  })
  .strict();

export const RemotePushUnsubscribeSchema = z
  .object({
    type: z.literal('app:push:unsubscribe'),
    requestId: RequestIdSchema,
  })
  .strict();

export const RemotePushTestSchema = z
  .object({
    type: z.literal('app:push:test'),
    requestId: RequestIdSchema,
  })
  .strict();

export const RemotePushTestedSchema = z
  .object({
    type: z.literal('app:push:tested'),
    requestId: RequestIdSchema,
    outcome: z.enum(['delivered', 'gone', 'failed', 'not-subscribed']),
  })
  .strict();

export const RemoteHostEndpointSchema = z
  .object({
    id: IdSchema,
    name: NameSchema,
    /** The host's phone server via Tailscale Serve; plain `ws:` only on localhost. */
    url: z
      .string()
      .max(2048)
      .regex(/^(wss:\/\/|ws:\/\/(localhost|127\.0\.0\.1):\d+\/)/),
    /** SHA-256 of the host's identity key, pinned like the desktop's install key. */
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export const RemoteListHostsSchema = z
  .object({
    type: z.literal('app:hosts:list'),
    requestId: RequestIdSchema,
  })
  .strict();

/** SSH hosts this phone may open directly, as vouched for by the authenticated desktop. */
export const RemoteHostsSchema = z
  .object({
    type: z.literal('app:hosts'),
    requestId: RequestIdSchema,
    hosts: z.array(RemoteHostEndpointSchema).max(64),
  })
  .strict();

/** The phone shows or hides the page, so the desktop knows whether it is being looked at. */
export const RemoteClientVisibilitySchema = z
  .object({
    type: z.literal('app:client:visibility'),
    visible: z.boolean(),
  })
  .strict();

export const RemoteErrorSchema = z
  .object({
    type: z.literal('app:error'),
    requestId: RequestIdSchema.optional(),
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2048),
  })
  .strict();

export const RemoteAppFrameSchema = z.discriminatedUnion('type', [
  RemoteListWorkspacesSchema,
  RemoteLaunchOptionsGetSchema,
  RemoteLaunchOptionsSchema,
  RemoteWorkspacesSchema,
  RemoteCreateWorkspaceSchema,
  RemoteWorkspaceCreatedSchema,
  RemoteStartWorkspaceSchema,
  RemoteWorkspaceStartedSchema,
  RemoteStopWorkspaceSchema,
  RemoteWorkspaceStoppedSchema,
  RemoteRegenerateWorkspaceTitleSchema,
  RemoteWorkspaceTitleRegeneratedSchema,
  RemoteAttachTerminalSchema,
  RemoteTerminalAttachedSchema,
  RemoteTerminalSnapshotChunkSchema,
  RemoteTerminalDataSchema,
  RemoteTerminalResetSchema,
  RemoteTerminalSizeSchema,
  RemoteTerminalStatusSchema,
  RemoteTerminalInputSchema,
  RemoteTerminalDetachSchema,
  RemoteTerminalResizeSchema,
  RemoteCreateTerminalSchema,
  RemoteTerminalCreatedSchema,
  RemoteCloseTerminalSchema,
  RemoteTerminalClosedSchema,
  RemoteVoiceStatusSchema,
  RemoteVoiceAvailabilitySchema,
  RemoteVoiceTranscribeSchema,
  RemoteVoiceTranscribedSchema,
  RemotePushConfigGetSchema,
  RemotePushConfigSchema,
  RemotePushSubscribeSchema,
  RemotePushUnsubscribeSchema,
  RemotePushTestSchema,
  RemotePushTestedSchema,
  RemoteListHostsSchema,
  RemoteHostsSchema,
  RemoteClientVisibilitySchema,
  RemoteErrorSchema,
]);

export type RemoteWorkspaceSummary = z.infer<typeof RemoteWorkspaceSummarySchema>;
export type RemoteWorkspaceTag = z.infer<typeof RemoteWorkspaceTagSchema>;
export type RemoteProjectSummary = z.infer<typeof RemoteProjectSummarySchema>;
export type RemoteLaunchModeSummary = z.infer<typeof RemoteLaunchModeSummarySchema>;
export type RemoteAgentPresetSummary = z.infer<typeof RemoteAgentPresetSummarySchema>;
export type RemoteLaunchEnvironmentSummary = z.infer<typeof RemoteLaunchEnvironmentSummarySchema>;
export type RemoteActionSummary = z.infer<typeof RemoteActionSummarySchema>;
export type RemoteWorkspaceEnvironment = z.infer<typeof RemoteWorkspaceEnvironmentSchema>;
export type RemoteTerminalSnapshot = z.infer<typeof RemoteTerminalSnapshotSchema>;
export type RemoteListWorkspaces = z.infer<typeof RemoteListWorkspacesSchema>;
export type RemoteLaunchOptionsGet = z.infer<typeof RemoteLaunchOptionsGetSchema>;
export type RemoteLaunchOptions = z.infer<typeof RemoteLaunchOptionsSchema>;
export type RemoteWorkspaces = z.infer<typeof RemoteWorkspacesSchema>;
export type RemoteCreateWorkspace = z.infer<typeof RemoteCreateWorkspaceSchema>;
export type RemoteWorkspaceCreated = z.infer<typeof RemoteWorkspaceCreatedSchema>;
export type RemoteStartWorkspace = z.infer<typeof RemoteStartWorkspaceSchema>;
export type RemoteWorkspaceStarted = z.infer<typeof RemoteWorkspaceStartedSchema>;
export type RemoteStopWorkspace = z.infer<typeof RemoteStopWorkspaceSchema>;
export type RemoteWorkspaceStopped = z.infer<typeof RemoteWorkspaceStoppedSchema>;
export type RemoteRegenerateWorkspaceTitle = z.infer<typeof RemoteRegenerateWorkspaceTitleSchema>;
export type RemoteWorkspaceTitleRegenerated = z.infer<typeof RemoteWorkspaceTitleRegeneratedSchema>;
export type RemoteAttachTerminal = z.infer<typeof RemoteAttachTerminalSchema>;
export type RemoteTerminalAttached = z.infer<typeof RemoteTerminalAttachedSchema>;
export type RemoteTerminalSnapshotChunk = z.infer<typeof RemoteTerminalSnapshotChunkSchema>;
export type RemoteTerminalData = z.infer<typeof RemoteTerminalDataSchema>;
export type RemoteTerminalReset = z.infer<typeof RemoteTerminalResetSchema>;
export type RemoteTerminalSize = z.infer<typeof RemoteTerminalSizeSchema>;
export type RemoteTerminalStatus = z.infer<typeof RemoteTerminalStatusSchema>;
export type RemoteTerminalInput = z.infer<typeof RemoteTerminalInputSchema>;
export type RemoteTerminalDetach = z.infer<typeof RemoteTerminalDetachSchema>;
export type RemoteTerminalResize = z.infer<typeof RemoteTerminalResizeSchema>;
export type RemoteCreateTerminal = z.infer<typeof RemoteCreateTerminalSchema>;
export type RemoteTerminalCreated = z.infer<typeof RemoteTerminalCreatedSchema>;
export type RemoteCloseTerminal = z.infer<typeof RemoteCloseTerminalSchema>;
export type RemoteTerminalClosed = z.infer<typeof RemoteTerminalClosedSchema>;
export type RemoteVoiceStatus = z.infer<typeof RemoteVoiceStatusSchema>;
export type RemoteVoiceAvailability = z.infer<typeof RemoteVoiceAvailabilitySchema>;
export type RemoteVoiceTranscribe = z.infer<typeof RemoteVoiceTranscribeSchema>;
export type RemoteVoiceTranscribed = z.infer<typeof RemoteVoiceTranscribedSchema>;
export type RemotePushSubscription = z.infer<typeof RemotePushSubscriptionSchema>;
export type RemotePushNotifyWhen = z.infer<typeof PushNotifyWhenSchema>;
export type RemotePushConfig = z.infer<typeof RemotePushConfigSchema>;
export type RemotePushTested = z.infer<typeof RemotePushTestedSchema>;
export type RemoteHostEndpoint = z.infer<typeof RemoteHostEndpointSchema>;
export type RemoteHosts = z.infer<typeof RemoteHostsSchema>;
export type RemoteError = z.infer<typeof RemoteErrorSchema>;
export type RemoteAppFrame = z.infer<typeof RemoteAppFrameSchema>;

export function parseRemoteAppFrame(value: unknown): RemoteAppFrame | null {
  const parsed = RemoteAppFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
