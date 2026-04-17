import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cronRegistry,
  registerCronHandler,
} from "./cron-killer.js";
import {
  INVOKE_PATH,
  startInvokeServer,
  type InvokeServerHandle,
} from "./invoke-server.js";

describe("startInvokeServer", () => {
  let handle: InvokeServerHandle | null = null;

  beforeEach(() => {
    cronRegistry.clear();
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = null;
    cronRegistry.clear();
  });

  it("invokes a registered handler by name and returns 200 + duration_ms", async () => {
    let ran = 0;
    registerCronHandler("nightly", () => {
      ran++;
    });

    handle = await startInvokeServer({ port: 0 });
    const resp = await fetch(`http://127.0.0.1:${handle.port}${INVOKE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "nightly" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { ok: boolean; duration_ms: number };
    expect(body.ok).toBe(true);
    expect(typeof body.duration_ms).toBe("number");
    expect(ran).toBe(1);
  });

  it("decodes args_base64 → JSON and passes to the handler", async () => {
    let seen: unknown = null;
    registerCronHandler("with-args", (args) => {
      seen = args;
    });

    handle = await startInvokeServer({ port: 0 });
    const payload = { user_id: 42, ids: [1, 2, 3] };
    const argsB64 = Buffer.from(JSON.stringify(payload)).toString("base64");

    const resp = await fetch(`http://127.0.0.1:${handle.port}${INVOKE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "with-args", args_base64: argsB64 }),
    });
    expect(resp.status).toBe(200);
    expect(seen).toEqual(payload);
  });

  it("returns 404 for an unknown handler", async () => {
    handle = await startInvokeServer({ port: 0 });
    const resp = await fetch(`http://127.0.0.1:${handle.port}${INVOKE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "missing" }),
    });
    expect(resp.status).toBe(404);
  });

  it("returns 500 when the handler throws", async () => {
    registerCronHandler("boom", () => {
      throw new Error("kaboom");
    });
    handle = await startInvokeServer({
      port: 0,
      onError: () => {
        /* swallow for test */
      },
    });

    const resp = await fetch(`http://127.0.0.1:${handle.port}${INVOKE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "boom" }),
    });
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("kaboom");
  });

  it("rejects unauthenticated requests when a token is configured", async () => {
    registerCronHandler("gated", () => {});
    handle = await startInvokeServer({ port: 0, token: "secret-123" });

    const without = await fetch(
      `http://127.0.0.1:${handle.port}${INVOKE_PATH}`,
      {
        method: "POST",
        body: JSON.stringify({ name: "gated" }),
      },
    );
    expect(without.status).toBe(401);

    const withToken = await fetch(
      `http://127.0.0.1:${handle.port}${INVOKE_PATH}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer secret-123",
        },
        body: JSON.stringify({ name: "gated" }),
      },
    );
    expect(withToken.status).toBe(200);
  });

  it("404s for any path other than the invoke path", async () => {
    handle = await startInvokeServer({ port: 0 });
    const resp = await fetch(`http://127.0.0.1:${handle.port}/other`);
    expect(resp.status).toBe(404);
  });
});
