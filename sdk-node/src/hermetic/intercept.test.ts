import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWithEvent } from "../core/event-context.js";
import { signatureOf } from "../outbound/signature.js";

import { installHermetic } from "./intercept.js";
import { MockStore, type MockEntry } from "./mock-store.js";

const nodeRequire = createRequire(import.meta.url);
const http = nodeRequire("node:http") as typeof import("node:http");

function seed(store: MockStore, eventId: string, partial: {
  method: string;
  host: string;
  path: string;
  body?: Buffer;
  contentType?: string;
  status: number;
  responseBody: string;
  responseContentType?: string;
}): MockEntry {
  const signature = signatureOf({
    method: partial.method,
    host: partial.host,
    path: partial.path,
    body: partial.body,
    contentType: partial.contentType,
  });
  const entry: MockEntry = {
    eventId,
    signature,
    status: partial.status,
    responseHeaders: partial.responseContentType
      ? { "content-type": [partial.responseContentType] }
      : {},
    responseBody: Buffer.from(partial.responseBody),
    responseContentType: partial.responseContentType ?? "text/plain",
  };
  store.add(entry);
  return entry;
}

describe("installHermetic — fetch intercept", () => {
  let store: MockStore;
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    store = new MockStore();
  });

  afterEach(() => {
    if (uninstall) uninstall();
    uninstall = null;
  });

  it("returns the mocked response for a matching fetch call", async () => {
    seed(store, "ev_1", {
      method: "GET",
      host: "api.example.com",
      path: "/v1/ping",
      status: 200,
      responseBody: '{"ok":true}',
      responseContentType: "application/json",
    });
    const handle = installHermetic({ store, policy: "strict" });
    uninstall = handle.uninstall;

    const result = await runWithEvent({ eventId: "ev_1" }, async () => {
      const resp = await fetch("https://api.example.com/v1/ping");
      expect(resp.status).toBe(200);
      return await resp.json();
    });

    expect(result).toEqual({ ok: true });
  });

  it("throws on unmocked outbound under strict policy", async () => {
    const handle = installHermetic({ store, policy: "strict" });
    uninstall = handle.uninstall;

    await expect(
      runWithEvent({ eventId: "ev_2" }, async () => {
        await fetch("https://api.example.com/unknown");
      }),
    ).rejects.toThrow(/unmocked outbound/);
  });

  it("returns a synthetic 200 {} under loose policy", async () => {
    const handle = installHermetic({ store, policy: "loose" });
    uninstall = handle.uninstall;

    const result = await runWithEvent({ eventId: "ev_3" }, async () => {
      const resp = await fetch("https://api.example.com/any");
      return await resp.json();
    });
    expect(result).toEqual({});
  });

  it("passes fetch through when no capture scope is active", async () => {
    // No mock seeded; if intercept fired, strict would throw. We expect a
    // real fetch attempt — this test uses a throwaway ephemeral URL which
    // will fail network-wise, but the fact that it reaches the network
    // (not an unmocked-outbound throw) is what we're asserting.
    const handle = installHermetic({ store, policy: "strict" });
    uninstall = handle.uninstall;
    await expect(
      fetch("http://127.0.0.1:1/never"),
    ).rejects.toThrow(/fetch failed|ECONNREFUSED|Connection refused/);
  });
});

describe("installHermetic — http.request intercept", () => {
  let store: MockStore;
  let uninstall: (() => void) | null = null;

  beforeEach(() => {
    store = new MockStore();
  });

  afterEach(() => {
    if (uninstall) uninstall();
    uninstall = null;
  });

  it("emits a fake response for a matching http.request call", async () => {
    seed(store, "ev_http_1", {
      method: "GET",
      host: "example.com",
      path: "/hello",
      status: 200,
      responseBody: "world",
    });
    const handle = installHermetic({ store, policy: "strict" });
    uninstall = handle.uninstall;

    const { status, body } = await runWithEvent({ eventId: "ev_http_1" }, () => {
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { hostname: "example.com", path: "/hello" },
          (res) => {
            let s = "";
            res.on("data", (c) => (s += c.toString()));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body: s }));
          },
        );
        req.on("error", reject);
        req.end();
      });
    });

    expect(status).toBe(200);
    expect(body).toBe("world");
  });

  it("emits 'error' on unmocked http.request under strict policy", async () => {
    const handle = installHermetic({ store, policy: "strict" });
    uninstall = handle.uninstall;

    await expect(
      runWithEvent({ eventId: "ev_http_2" }, () => {
        return new Promise<void>((resolve, reject) => {
          const req = http.request(
            { hostname: "example.com", path: "/missing" },
            () => resolve(),
          );
          req.on("error", reject);
          req.end();
        });
      }),
    ).rejects.toThrow(/unmocked outbound/);
  });
});
