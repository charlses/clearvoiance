import { defineConfig } from "vitest/config";

/**
 * Integration-test config. Runs only `*.integration.test.ts` files and
 * requires Docker for testcontainers. Triggered via `pnpm test:integration`
 * (in CI too, once the runner has Docker available).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    // Containers are slow to boot; give each test a generous window.
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
