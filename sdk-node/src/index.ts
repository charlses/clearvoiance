/**
 * @clearvoiance/node — Node.js SDK for clearvoiance.
 *
 * Public API surface. Adapter imports (HTTP, socket, cron) land in Phase 1b/1c.
 */

export { Client, createClient, SDK_VERSION } from "./client.js";
export type { ClientConfig, SessionHandle, StopResult } from "./client.js";
export {
  DEFAULT_HEADER_DENY,
  RECOMMENDED_HEADER_DENY_PRODUCTION,
} from "./core/redaction.js";
export type { HeaderMatcher } from "./core/redaction.js";
export { currentEventId, runWithEvent } from "./core/event-context.js";
export type { EventContext } from "./core/event-context.js";
