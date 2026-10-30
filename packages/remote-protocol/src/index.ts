// Public API of @komla/remote-protocol.
//
// Three layers, exported through a single barrel:
//
//   1. Identity — fingerprint derivation + validation. Same algorithm the
//      desktop install-identity service uses; this is the consolidated
//      source of truth.
//
//   2. Crypto primitives — ECDH-P256, HKDF-SHA256, AES-GCM-256, ECDSA-P256
//      verify. Each is a thin WebCrypto wrapper with the protocol's pinned
//      parameters baked in (curve, hash, key length). Exported for callers
//      that need to compose them outside the standard handshake (e.g. tests).
//
//   3. Peer — the FSM that drives a full session: ephemeral keypair gen,
//      offer/answer handshake, derived session key, seq-counter discipline,
//      AES-GCM frame encrypt/decrypt. This is what the desktop service and
//      the browser/RN client both instantiate.
//
// Deliberately omitted from the barrel: anything WebSocket-specific. The
// `PeerTransport` interface is the only seam the package needs.

// Identity (consolidated fingerprint derivation)
export {
  fingerprintFromPublicKey,
  isValidFingerprint,
  FINGERPRINT_HEX_LENGTH,
} from './crypto/fingerprint';

// Crypto primitives
export { verifySignature } from './crypto/signature';
export {
  buildDeviceProof,
  deviceIdFromPublicKey,
  exportDevicePublicKey,
  generateDeviceKeyPair,
  signDeviceProof,
  verifyDeviceProof,
  type DeviceProofPurpose,
} from './crypto/device-identity';
export { buildHandshakeTranscript, hashHandshakeTranscript } from './crypto/transcript';
export {
  generateEphemeralKeyPair,
  importPeerPublicKey,
  deriveSessionKey,
  type EphemeralKeyPair,
} from './crypto/ecdh';
export {
  encrypt,
  decrypt,
  buildNonce,
  NONCE_BYTES,
  DIRECTION_DESKTOP_TO_CLIENT,
  DIRECTION_CLIENT_TO_DESKTOP,
  type Direction,
  type EncryptResult,
} from './crypto/aead';

// Wire format
export {
  parseFrame,
  E2EOfferSchema,
  E2EAnswerSchema,
  E2EEncSchema,
  E2EFrameSchema,
  MAX_FRAME_CHARS,
  type E2EFrame,
  type E2EOffer,
  type E2EAnswer,
  type E2EEnc,
} from './wire/messages';
export { encodeBase64, decodeBase64 } from './wire/encoding';
export {
  decodeBinaryEnvelope,
  encodeBinaryEnvelope,
  MAX_BINARY_BODY_BYTES,
  MAX_BINARY_FRAME_BYTES,
} from './wire/binary-envelope';
export {
  encodedJsonBytes,
  FrameTooLargeError,
  jsonStringBytes,
  MAX_ENCRYPTED_BODY_BYTES,
  splitJsonString,
} from './wire/frame-budget';
export { PEER_CLOSE, SESSION_CLOSE, type PeerCloseCode } from './wire/close-codes';

// Peer
export {
  Peer,
  type PeerOptions,
  type ClientPeerOptions,
  type DesktopPeerOptions,
  type PeerState,
  type PeerCloseEvent,
  type PeerLogger,
} from './peer/peer';
export type { PeerTransport } from './peer/transport';
export type { DecodedMessage, DecodedJsonMessage, DecodedBinaryMessage } from './peer/payload';

// Liveness heartbeat that runs on the same socket as the e2e Peer
export {
  classifyRelayFrame,
  RELAY_PING_FRAME,
  RELAY_PONG_FRAME,
  type RelayFrameKind,
} from './relay/heartbeat';

// Pair ceremony (application-layer frames inside the encrypted channel)
export {
  PAIR_PROTOCOL_VERSION,
  REMOTE_CAPABILITIES,
  PairFrameSchema,
  PairHelloSchema,
  PairRegistrationChallengeSchema,
  PairRegistrationResponseSchema,
  PairRegisteredSchema,
  PairAuthChallengeSchema,
  PairAuthResponseSchema,
  PairResumeChallengeSchema,
  PairResumeResponseSchema,
  PairAuthenticatedSchema,
  PairRejectedSchema,
  parsePairFrame,
  type PairFrame,
  type PairHello,
  type PairHelloRegister,
  type PairHelloAuthenticate,
  type PairHelloResume,
  type PairRegistrationChallenge,
  type PairRegistrationResponse,
  type PairRegistered,
  type PairAuthChallenge,
  type PairAuthResponse,
  type PairResumeChallenge,
  type PairResumeResponse,
  type PairAuthenticated,
  type PairRejected,
} from './pair/frames';

// Binary terminal output and input payloads, once both peers list binary-frames.
export {
  binaryTerminalOutputOverhead,
  decodeBinaryAppFrame,
  encodeBinaryTerminalInput,
  encodeBinaryTerminalOutput,
  type BinaryAppFrame,
  type BinaryTerminalInput,
  type BinaryTerminalOutput,
} from './app/binary-frames';

// Remote-control application frames inside the authenticated encrypted channel.
export {
  REMOTE_APP_PROTOCOL_VERSION,
  REMOTE_CUSTOM_TITLE_SOURCE_PREFIX,
  markRemoteAttentionCustomTitleSource,
  isRemoteAttentionCustomTitle,
  escapeRemoteAttentionCustomTitleSource,
  RemoteAppFrameSchema,
  RemoteWorkspaceSummarySchema,
  RemoteProjectSummarySchema,
  RemoteProjectIconSchema,
  MAX_REMOTE_PROJECT_ICON_CHARS,
  RemoteWorkspaceTagSchema,
  MAX_REMOTE_WORKSPACE_TAG_CHARS,
  REMOTE_WORKSPACE_TAG_TONES,
  RemoteLaunchModeSummarySchema,
  RemoteAgentPresetSummarySchema,
  RemoteLaunchEnvironmentSummarySchema,
  RemoteActionSummarySchema,
  RemoteWorkspaceEnvironmentSchema,
  RemoteTerminalSnapshotSchema,
  RemotePushSubscriptionSchema,
  RemoteHostEndpointSchema,
  parseRemoteAppFrame,
  type RemoteAppFrame,
  type RemoteWorkspaceSummary,
  type RemoteWorkspaceTag,
  type RemoteProjectSummary,
  type RemoteLaunchModeSummary,
  type RemoteAgentPresetSummary,
  type RemoteLaunchEnvironmentSummary,
  type RemoteActionSummary,
  type RemoteWorkspaceEnvironment,
  type RemoteTerminalSnapshot,
  type RemoteListWorkspaces,
  type RemoteLaunchOptionsGet,
  type RemoteLaunchOptions,
  type RemoteWorkspaces,
  type RemoteCreateWorkspace,
  type RemoteWorkspaceCreated,
  type RemoteStartWorkspace,
  type RemoteWorkspaceStarted,
  type RemoteAttachTerminal,
  type RemoteTerminalAttached,
  type RemoteTerminalSnapshotChunk,
  type RemoteTerminalData,
  type RemoteTerminalReset,
  type RemoteTerminalSize,
  type RemoteTerminalStatus,
  type RemoteTerminalInput,
  type RemoteTerminalDetach,
  type RemoteTerminalResize,
  type RemoteCreateTerminal,
  type RemoteTerminalCreated,
  type RemoteCloseTerminal,
  type RemoteTerminalClosed,
  type RemotePushSubscription,
  type RemotePushNotifyWhen,
  type RemotePushConfig,
  type RemotePushTested,
  type RemoteHostEndpoint,
  type RemoteHosts,
  type RemoteError,
} from './app/frames';
