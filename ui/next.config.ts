import type { NextConfig } from "next";

// `standalone` emits a minimal server + traced node_modules under
// .next/standalone/, which deploy/images/ui/Dockerfile copies into a
// slim runtime image. Keeps the container small and self-contained.
const nextConfig: NextConfig = {
  output: "standalone",
  // pnpm workspace: standalone tracing needs to walk up one level to
  // reach the hoisted node_modules at the repo root.
  outputFileTracingRoot: "..",
};

export default nextConfig;
