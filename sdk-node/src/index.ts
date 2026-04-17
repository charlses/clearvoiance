/**
 * @clearvoiance/node — Node.js SDK for clearvoiance.
 *
 * Public API surface. Adapter imports (HTTP, socket, cron) land in Phase 1b/1c.
 */

export { Client, createClient, SDK_VERSION } from "./client.js";
export type { ClientConfig, SessionHandle, StopResult } from "./client.js";
