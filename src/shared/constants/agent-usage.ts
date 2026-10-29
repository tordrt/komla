/** How often the status bar reads each agent's usage; it moves slowly, and providers limit reads. */
export const AGENT_USAGE_POLL_INTERVAL_MS = 5 * 60_000;

/** After a provider says its usage was read too often, it isn't asked again for this long. */
export const AGENT_USAGE_RATE_LIMITED_BACKOFF_MS = 15 * 60_000;
