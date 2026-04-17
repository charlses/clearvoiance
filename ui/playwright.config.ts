import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the Next.js UI. In CI we build the app once and
 * start it; locally `pnpm test:e2e --ui` reuses the dev server if already
 * running on 3100. Engine calls are intercepted via `page.route()` inside
 * the tests so the suite doesn't need a live engine.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    // Production build + start so the test exercises what users actually ship.
    command: "pnpm build && pnpm start",
    port: 3100,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
