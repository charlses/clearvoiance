import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Event as PbEvent } from "../../generated/clearvoiance/v1/event.js";
import { captureHttp } from "./express.js";

class RecordingSink {
  public batches: PbEvent[][] = [];
  async sendBatch(events: PbEvent[]): Promise<void> {
    this.batches.push(events);
  }
  events(): PbEvent[] {
    return this.batches.flat();
  }
}

function listen(app: express.Application): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
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

describe("captureHttp (Express adapter)", () => {
  let sink: RecordingSink;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    sink = new RecordingSink();
  });

  afterEach(async () => {
    if (server) await close(server);
  });

  it("captures method, path, status, duration, and headers", async () => {
    const app = express();
    app.use(captureHttp(sink));
    app.get("/hello/:name", (req, res) => {
      res.status(200).json({ hello: req.params.name });
    });

    ({ server, url: base } = await listen(app));
    const resp = await fetch(`${base}/hello/world`, {
      headers: { "x-trace-id": "t-1", authorization: "Bearer secret" },
    });
    expect(resp.status).toBe(200);
    await resp.json();

    // Wait a tick for the finish handler to fire.
    await new Promise((r) => setImmediate(r));

    const events = sink.events();
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.adapter).toBe("http.express");
    expect(ev.http).toBeDefined();
    const http = ev.http!;
    expect(http.method).toBe("GET");
    expect(http.path).toBe("/hello/world");
    expect(http.status).toBe(200);
    expect(http.durationNs).toBeGreaterThan(0n);
    expect(http.headers["x-trace-id"]?.values).toEqual(["t-1"]);
    expect(http.headers["authorization"]?.values).toEqual(["Bearer secret"]);
    expect(ev.redactionsApplied).not.toContain("header:authorization");
  });

  it("captures request + response bodies up to the inline cap", async () => {
    const app = express();
    app.use(captureHttp(sink));
    app.use(express.json());
    app.post("/echo", (req, res) => {
      res.json({ seen: req.body });
    });

    ({ server, url: base } = await listen(app));
    const payload = { hello: "friend" };
    await fetch(`${base}/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    await new Promise((r) => setImmediate(r));

    const ev = sink.events()[0]!;
    const reqInline = ev.http?.requestBody?.inline;
    const resInline = ev.http?.responseBody?.inline;
    expect(reqInline).toBeDefined();
    expect(resInline).toBeDefined();
    expect(JSON.parse(Buffer.from(reqInline!).toString("utf-8"))).toEqual(payload);
    expect(JSON.parse(Buffer.from(resInline!).toString("utf-8"))).toEqual({ seen: payload });
  });

  it("truncates bodies over maxBodyInlineBytes and flags the redaction", async () => {
    const app = express();
    app.use(captureHttp(sink, { maxBodyInlineBytes: 10 }));
    app.post("/big", (req, res) => {
      res.status(204).end();
    });

    ({ server, url: base } = await listen(app));
    await fetch(`${base}/big`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "0123456789ABCDEF", // 16 bytes, cap is 10
    });

    await new Promise((r) => setImmediate(r));

    const ev = sink.events()[0]!;
    expect(ev.http?.requestBody?.inline?.length).toBe(10);
    expect(ev.http?.requestBody?.sizeBytes).toBe(10n);
    expect(ev.redactionsApplied).toContain("body:truncated");
  });

  it("extracts user via userExtractor", async () => {
    const app = express();
    app.use((req, _res, next) => {
      (req as express.Request & { user?: { id: string } }).user = { id: "u-42" };
      next();
    });
    app.use(
      captureHttp(sink, {
        userExtractor: (req) => (req as express.Request & { user?: { id: string } }).user?.id,
      }),
    );
    app.get("/me", (_req, res) => res.status(200).end());

    ({ server, url: base } = await listen(app));
    await fetch(`${base}/me`);
    await new Promise((r) => setImmediate(r));

    expect(sink.events()[0]!.http?.userId).toBe("u-42");
  });

  it("populates route template when Express matched a route", async () => {
    const app = express();
    app.use(captureHttp(sink));
    app.get("/users/:id/posts/:pid", (_req, res) => res.status(200).end());

    ({ server, url: base } = await listen(app));
    await fetch(`${base}/users/7/posts/12`);
    await new Promise((r) => setImmediate(r));

    expect(sink.events()[0]!.http?.routeTemplate).toBe("/users/:id/posts/:pid");
  });

  it("does not break the response when sendBatch throws", async () => {
    const failing: import("./express.js").EventSink = {
      sendBatch: async () => {
        throw new Error("engine down");
      },
    };
    let captured: unknown = null;
    const app = express();
    app.use(captureHttp(failing, { onError: (err) => (captured = err) }));
    app.get("/ok", (_req, res) => res.status(200).end());

    ({ server, url: base } = await listen(app));
    const resp = await fetch(`${base}/ok`);
    expect(resp.status).toBe(200);

    // Let the failed sendBatch reject and onError fire.
    await new Promise((r) => setTimeout(r, 10));
    expect((captured as Error | null)?.message).toBe("engine down");
  });
});
