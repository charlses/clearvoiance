import { test, expect, type Route } from "@playwright/test";

/**
 * Full happy-path through the UI using mocked engine responses. The test
 * intercepts every /api/v1/* call via page.route() so the suite doesn't
 * depend on a running engine — CI can run this without docker. Runs the
 * production Next.js build (via playwright.config webServer).
 */

// Canned engine responses. Keep these narrow — we want to assert on
// whatever the UI actually renders, not on every field.
function mockEngine(fulfill: (route: Route) => Promise<void>) {
  return async (route: Route) => {
    const url = route.request().url();
    if (url.includes("/api/v1/version")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          engine: "0.0.1-test",
          api: "v1",
          sdk_compat: "@clearvoiance/node@0.0.0-alpha.0",
        }),
      });
    }
    if (url.includes("/api/v1/sessions")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sessions: [
            {
              id: "sess_abc",
              name: "checkout-smoke",
              labels: { env: "staging" },
              status: "active",
              started_at: new Date().toISOString(),
              events_captured: 42,
              bytes_captured: 1024,
            },
          ],
          count: 1,
        }),
      });
    }
    if (url.includes("/api/v1/replays")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          replays: [
            {
              id: "rep_xyz",
              source_session_id: "sess_abc",
              target_url: "http://staging.example.com",
              speedup: 12,
              status: "completed",
              started_at: new Date().toISOString(),
              events_dispatched: 42,
              events_failed: 0,
              events_backpressured: 0,
            },
          ],
          count: 1,
        }),
      });
    }
    if (url.includes("/api/v1/config")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          engine: "clearvoiance",
          version: "0.0.1-test",
          grpc_addr: "127.0.0.1:9100",
          http_addr: "127.0.0.1:9101",
          features: { replay_engine: true, audit_log: true },
        }),
      });
    }
    if (url.includes("/api/v1/api-keys")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ keys: [], count: 0 }),
      });
    }
    return fulfill(route);
  };
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/**", mockEngine((r) => r.abort()));
  // Clear any stored key from a previous run.
  await page.addInitScript(() => window.localStorage.clear());
});

test("login → dashboard → sessions → settings renders live data", async ({ page }) => {
  // Landing on / redirects to /login when no key is stored.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  // Enter a dev-open key. /version probe should succeed against the mock.
  await page.getByLabel("API key").fill("dev-key");
  await page.getByRole("button", { name: /sign in/i }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  // Dashboard shows the mocked engine info + sessions/replays.
  await expect(page.getByText("0.0.1-test")).toBeVisible();
  await expect(page.getByText("checkout-smoke")).toBeVisible();
  await expect(page.getByText("rep_xyz").first()).toBeVisible();

  // Navigate to Sessions from the sidebar.
  await page.getByRole("link", { name: /Sessions/ }).click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(page.getByText("checkout-smoke")).toBeVisible();

  // Navigate to Replays.
  await page.getByRole("link", { name: /Replays/ }).click();
  await expect(page).toHaveURL(/\/replays$/);
  await expect(page.getByText("rep_xyz").first()).toBeVisible();

  // Navigate to Settings.
  await page.getByRole("link", { name: /Settings/ }).click();
  await expect(page).toHaveURL(/\/settings$/);
  // Engine section shows the config.
  await expect(page.getByText("127.0.0.1:9101")).toBeVisible();
  await expect(page.getByText("No API keys provisioned yet.")).toBeVisible();
});
