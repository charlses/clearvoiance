/**
 * @clearvoiance/node — Node.js SDK for clearvoiance.
 *
 * Phase 0: placeholder. Real capture client + adapters land in Phase 1
 * (see plan/11-phase-1-capture-mvp.md).
 */

export const SDK_VERSION = "0.0.0-alpha.0";

/**
 * Configuration for a clearvoiance client.
 * Full schema lands in Phase 1.
 */
export interface ClientConfig {
  engine: {
    url: string;
    apiKey: string;
  };
  session: {
    name: string;
  };
}

/**
 * Creates a clearvoiance capture client. Phase 0 returns a stub.
 */
export function createClient(_config: ClientConfig): { version: string } {
  return { version: SDK_VERSION };
}
