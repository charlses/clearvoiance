/**
 * Single source of truth for the SDK version string. Kept in its own file so
 * adapters can import it without pulling in the gRPC client.
 *
 * TODO(phase-1i): generate this from package.json at build time via tsup's
 * `env` option so the constant can't drift from the published version.
 */
export const SDK_VERSION = "0.0.0-alpha.0";
