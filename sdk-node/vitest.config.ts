import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    // Integration tests (`*.integration.test.ts`) need Docker via
    // testcontainers and are opted into separately via `pnpm test:integration`
    // so `pnpm test` stays fast on dev machines without Docker running.
    exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.integration.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/generated/**"],
    },
  },
});
