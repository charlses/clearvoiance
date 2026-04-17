import type { Server } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runWithEvent } from "../core/event-context.js";
import type { Event as PbEvent } from "../generated/clearvoiance/v1/event.js";
import { patchFetch } from "./fetch.js";

class RecordingSink {
  public batches: PbEvent[][] = [];
  async sendBatch(events: PbEvent[]): Promise<void> {
    this.batches.push(events);
  }
  events(): PbEvent[] {
    return this.batches.flat();
  }
  inflight: Promise<unknown>[] = [];
  track<T>(p: Promise<T>): Promise<T> {
    this.inflight.push(p);
    return p;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }
}

function listen(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c.toString()));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.statusCode = 200;
        res.end(JSON.stringify({ echoed: body, path: req.url, method: req.method }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe("patchFetch (outbound global fetch capture)", () => {
  let sink: RecordingSink;
  let server: Server;
  let base: string;
  let uninstall: (() => void) | null = null;

  beforeEach(async () => {
    sink = new RecordingSink();
    ({ server, url: base } = await listen());
  });

  afterEach(async () => {
    if (uninstall) uninstall();
    uninstall = null;
    await close(server);
  });

  it("records fetch calls inside a capture scope and returns the response unchanged", async () => {
    const handle = patchFetch(sink);
    uninstall = handle.uninstall;

    const result = await runWithEvent({ eventId: "ev_fetch_1" }, async () => {
      const resp = await fetch(`${base}/api/ping`);
      return await resp.json();
    });

    await sink.drain();

    expect(result).toMatchObject({ path: "/api/ping", method: "GET" });
    const events = sink.events();
    expect(events).toHaveLength(1);
    expect(events[0]!.outbound!.causedByEventId).toBe("ev_fetch_1");
    expect(events[0]!.outbound!.http!.method).toBe("GET");
    expect(events[0]!.outbound!.http!.path).toBe("/api/ping");
    expect(events[0]!.outbound!.http!.status).toBe(200);
  });

  it("captures JSON request bodies and returns an identical response to the caller", async () => {
    const handle = patchFetch(sink);
    uninstall = handle.uninstall;

    const result = await runWithEvent({ eventId: "ev_fetch_2" }, async () => {
      const resp = await fetch(`${base}/api/echo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hello: "world" }),
      });
      return await resp.json();
    });

    await sink.drain();

    expect(JSON.parse((result as { echoed: string }).echoed)).toEqual({ hello: "world" });

    const ev = sink.events()[0]!;
    const reqBody = ev.outbound!.http!.requestBody!;
    expect(reqBody.inline).toBeDefined();
    expect(JSON.parse(Buffer.from(reqBody.inline!).toString("utf-8"))).toEqual({
      hello: "world",
    });
  });

  it("passes through calls outside any capture scope", async () => {
    const handle = patchFetch(sink);
    uninstall = handle.uninstall;

    const resp = await fetch(`${base}/unscoped`);
    await resp.text();
    await sink.drain();

    expect(sink.events()).toHaveLength(0);
  });

  it("uninstall restores the original global fetch", () => {
    const before = globalThis.fetch;
    const handle = patchFetch(sink);
    expect(globalThis.fetch).not.toBe(before);
    handle.uninstall();
    expect(globalThis.fetch).toBe(before);
  });
});
