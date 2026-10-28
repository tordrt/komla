# Analytics

## Overview

App telemetry goes to `/api/v1/telemetry/*` on the license worker, which forwards it to Umami. The Worker forwards the client IP (`X-Forwarded-For`), `User-Agent`, and `Accept-Language` so Umami can derive sessions and location; Umami does not store raw IPs. The website's own analytics are documented with the site, outside this repo.

`src/main/services/telemetry.service.ts` sends every event; crash reports go through `src/main/services/error-reporting.service.ts`. Unpackaged builds (`npm run dev`) send no crash reports and, of the events below, only monetization events, to the staging API.

## Controls

One setting, **Usage data** (Settings → General → Privacy), picks the level, see `src/shared/lib/telemetry-level.ts`:

| Level                 | Config                                                             | Sends                                                            |
| --------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `off`                 | `anonymousTelemetryEnabled: false`, `usageTelemetryEnabled: false` | Nothing.                                                         |
| `anonymous` (default) | `anonymousTelemetryEnabled: true`, `usageTelemetryEnabled: false`  | The install ping and daily heartbeat, with no install ID.        |
| `usage` (opt-in)      | `usageTelemetryEnabled: true`                                      | Everything below, each event with the install ID (`distinctId`). |

Setup's last step asks only whether to share usage analytics, with neither answer preselected, and records the answer in `usageTelemetryConsentAnswered`. The anonymous level needs no consent: it's on by default and turned off in Settings or by the environment (below). `UsageAnalyticsConsentBanner` asks configs that never answered.

**Crash reports** have their own switch (`errorReportingEnabled`, on by default), also offered as a ticked checkbox on that setup step.

`DO_NOT_TRACK=1`, or `KOMLA_TELEMETRY=off` (`0`, `false`), in the app's own environment turns off all telemetry and crash reports, whatever the settings say (`src/main/lib/telemetry-env.ts`). Komla reads its own process environment only, so a variable set in a shell profile applies when Komla is started from that shell, not from the Dock, Start menu or a desktop launcher. Settings doesn't show the override.

## App Events

Every event carries `appVersion`, `platform`, `arch` and `distribution`: `official` for apps built by `scripts/release.sh` (the downloads on the website), `source` for any other build, such as one built from the public source. The Worker records events without the field, from app versions that predate it, as `official`, and any value other than `official` as `source`.

An `agent` field is a built-in agent preset's name; a preset the user made is sent as `Custom`.

**Anonymous level:**

| Event       | Source                | Payload                                                                                        |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `install`   | One-time install ping | The common fields.                                                                             |
| `heartbeat` | Daily heartbeat       | Adds `agent`, `isLicensed`, `licenseCohort`, `licenseType`, `firstThisWeek`, `firstThisMonth`. |

### Active installs

The heartbeat goes out at most once per install per UTC day, so daily active installs are the day's `heartbeat` events. `firstThisWeek` and `firstThisMonth` say whether it is the install's first heartbeat in that ISO week (Monday start, UTC) or calendar month (`src/main/lib/active-periods.ts`), so weekly and monthly active installs are the period's heartbeats with that flag set. Counting needs no install ID; the date of the previous heartbeat stays on the device. Count events, not Umami visitors: without an ID, Umami guesses visitors from IP and user agent.

**Usage level only (opt-in):**

| Event                                | Source                                                   | Notes                                                                                                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monetization events                  | `free_limit_hit`, `upgrade_clicked`, `license_activated` | Event name, cohort dimensions, `source`, counts.                                                                                                                                                                                                                                                       |
| `ssh_host_added`                     | SSH host added                                           | `source`: where adding started — `tips` (Tips menu, or Settings opened from it), `new_workspace` (New Workspace's environment menu, or Settings opened from it), `onboarding` (picked “A machine I can SSH into” in the setup wizard) or `settings` (anything else). Never the host's name or address. |
| `agent_selected`                     | Default agent chosen by the setup wizard                 | Carries the default agent's `agent` name: the first of the installed agents Komla found that was left ticked on the agent step, else the one picked on the agent picker, which only shows when none were found. A custom agent is sent as `Custom`. Fires once per wizard run.                         |
| `integration_milestone`              | First time an integration is exercised                   | Fires once ever per `milestone`: `notification:<kind>:<source>` (first notification hook received per kind per agent) and `mcp:tool-used` (first MCP tool call). The `agent` is the notification's `source`, falling back to the active preset. Also carries `notificationKind` / `tool`.              |
| `usage_summary` / `usage_summary_v2` | Daily usage summary                                      | Workspace/action/project counts plus a `utilityRequests` block — daily AI labeling utility counts by provider (`managed` / `custom`) plus `failuresByReason`.                                                                                                                                          |
| Checkout `#aid=`                     | `UpgradeDialog` → `/buy`                                 | Links the in-app journey to `checkout_started` / `purchase` via Stripe `metadata.analytics_id`.                                                                                                                                                                                                        |

## Crash Reports

`POST /api/v1/errors` with uncaught exceptions and unhandled rejections in the main process, React error-boundary errors, and renderer or child process crashes. Messages and stacks are scrubbed of home paths, the host name, emails, URL credentials and common token formats (`scrubErrorText`), stacks are cut to 10 lines, and context is limited to an allowlist of keys. Each report adds `appVersion`, `platform`, `arch`, `electronVersion`, `isLicensed` and the agent preset name (built-in, or `Custom`). Errors that are only logged are not reported.

## Privacy

- No cookies are set by Komla's Umami analytics.
- Nothing is stored in Komla's own database; IPs are forwarded to Umami but not stored by it.
- The app sends a `distinctId` only after the user opts in to usage analytics.
- Email addresses are not included in analytics event properties.
- Keep the site's privacy policy (`privacy.html`) in sync when adding or changing app telemetry.
