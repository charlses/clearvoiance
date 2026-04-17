/**
 * Public entry point for outbound capture. `patchOutbound(client)` installs
 * both the `http`/`https` and global-`fetch` patches in one call.
 */

import { patchHttp, type PatchHttpOptions, type OutboundSink, type PatchHandle } from "./http.js";
import { patchFetch, type PatchFetchOptions } from "./fetch.js";

export type { OutboundSink, PatchHandle, PatchHttpOptions, PatchFetchOptions };
export { patchHttp, targetFromHost } from "./http.js";
export { patchFetch } from "./fetch.js";
export { signatureOf, type SignatureInput, type CanonicalizeConfig } from "./signature.js";

export interface PatchOutboundOptions
  extends PatchHttpOptions,
    PatchFetchOptions {}

/**
 * Installs HTTP + fetch outbound capture. The returned handle uninstalls both.
 */
export function patchOutbound(
  client: OutboundSink,
  opts: PatchOutboundOptions = {},
): PatchHandle {
  const httpHandle = patchHttp(client, opts);
  const fetchHandle = patchFetch(client, opts);
  return {
    uninstall() {
      fetchHandle.uninstall();
      httpHandle.uninstall();
    },
  };
}
