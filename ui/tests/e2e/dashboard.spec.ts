import { test, expect, type Route } from "@playwright/test";

/**
 * Full happy-path through the UI using mocked engine responses. The test
 * intercepts every /api/v1/* call via page.route() so the suite doesn't
 * depend on a running engine — CI can run this without docker. Runs the
 * production Next.js build (via playwright.config webServer).
 *
 * Auth: email+password → cookie. The mock tracks whether /auth/login
 * succeeded; /auth/me returns 401 before login and 200 after, so the
 * AuthGate redirects to /login on first load and lets us in after.
 */

interface MockState {
  loggedIn: boolean;
}

function mockEngine(state: MockState) {
  return async (route: Route) => {
    const url = route.request().url();

    // --- Auth surface --------------------------------------------------
    if (url.includes("/api/v1/auth/state")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ setup_required: false }),
      });
    }
    if (url.includes("/api/v1/auth/me")) {
      if (!state.loggedIn) {
        return route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "UNAUTHENTICATED", message: "no session" },
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "user_test01",
          email: "admin@example.com",
          role: "admin",
          created_at: new Date().toISOString(),
        }),
      });
    }
    if (url.includes("/api/v1/auth/login")) {
      state.loggedIn = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: { "set-cookie": "clv_session=test-token; Path=/; HttpOnly" },
        body: JSON.stringify({
          user: {
            id: "user_test01",
            email: "admin@example.com",
            role: "admin",
            created_at: new Date().toISOString(),
          },
        }),
      });
    }
    if (url.includes("/api/v1/auth/logout")) {
      state.loggedIn = false;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
    }

    // --- Everything else needs auth ------------------------------------
    if (!state.loggedIn) {
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAUTHENTICATED", message: "no session" },
        }),
      });
    }

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
    return route.abort();
  };
}

test("login → dashboard → sessions → settings renders live data", async ({ page }) => {
  const state: MockState = { loggedIn: false };
  await page.route("**/api/v1/**", mockEngine(state));

  // Landing on / hits AuthGate → /auth/me (401) → /auth/state (setup
  // not required) → /login.
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);

  // Fill the login form.
  await page.getByRole("textbox", { name: /email/i }).fill("admin@example.com");
  await page.getByRole("textbox", { name: /password/i }).fill("correct-horse-battery-staple");
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
  // Account section shows the signed-in user.
  await expect(page.getByText("admin@example.com").first()).toBeVisible();
  // Engine section shows the config.
  await expect(page.getByText("127.0.0.1:9101")).toBeVisible();
});
